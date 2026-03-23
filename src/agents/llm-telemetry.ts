/**
 * LLM Telemetry Logger
 *
 * Captures per-iteration metrics for every LLM call:
 * - TTFT  (Time To First Token, ms)
 * - TPOT  (Time Per Output Token, ms/token)
 * - Input token count + full input content (plaintext)
 * - Output token count + full output content (plaintext)
 *
 * Enabled via:  OPENCLAW_LLM_TELEMETRY=true
 * Output file:  OPENCLAW_LLM_TELEMETRY_FILE  (default: ~/.openclaw/state/logs/llm-telemetry.jsonl)
 *
 * Each LLM call (including tool-use round-trips inside one agent turn) produces
 * one JSONL record.  Fields:
 *
 * {
 *   ts:               ISO timestamp of the request
 *   sessionId:        openclaw session id
 *   sessionKey:       openclaw session key
 *   runId:            run identifier
 *   provider:         e.g. "anthropic" / "openai"
 *   modelId:          e.g. "claude-opus-4-6"
 *   iterationIndex:   0-based call counter within this session (tool-loop rounds)
 *   ttftMs:           milliseconds from request start to first text token (null if no text)
 *   tpotMs:           ms per output token ((completionMs - ttftMs) / (outputTokens - 1))
 *   requestStartedAt: Unix epoch ms
 *   firstTokenAt:     Unix epoch ms (null if no text)
 *   completedAt:      Unix epoch ms
 *   durationMs:       total call duration in ms
 *   inputTokens:      raw prompt token count (null if not reported)
 *   outputTokens:     raw completion token count (null if not reported)
 *   cacheReadTokens:  cache read tokens (null if not reported)
 *   cacheWriteTokens: cache write tokens (null if not reported)
 *   inputContent:     full plaintext of what was sent to the model (messages array, JSON)
 *   outputContent:    full plaintext of what the model returned (accumulated text)
 *   stopReason:       "stop" | "toolUse" | "length" | "error" | "aborted"
 * }
 */
import fs from "node:fs";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";

const log = createSubsystemLogger("agent/llm-telemetry");

// ---------- Config ----------

type TelemetryConfig = {
  enabled: boolean;
  filePath: string;
};

function resolveTelemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig {
  const enabled = parseBooleanValue(env.OPENCLAW_LLM_TELEMETRY) ?? false;
  const fileOverride = env.OPENCLAW_LLM_TELEMETRY_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "llm-telemetry.jsonl");
  return { enabled, filePath };
}

// ---------- Types ----------

export type TelemetryRecord = {
  ts: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  iterationIndex: number;
  requestStartedAt: number;
  firstTokenAt: number | null;
  completedAt: number;
  ttftMs: number | null;
  tpotMs: number | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Full plaintext of the messages sent to the model (JSON-stringified array). */
  inputContent: string;
  /** Full plaintext of the model's text output (concatenated deltas). */
  outputContent: string;
  stopReason: string;
};

// ---------- Logger factory ----------

export type LlmTelemetryLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createLlmTelemetryLogger(params: {
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
}): LlmTelemetryLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolveTelemetryConfig(env);
  if (!cfg.enabled) {
    return null;
  }

  const { filePath } = cfg;
  let dirReady = false;
  let iterationIndex = 0;

  const writeSync = (data: string) => {
    try {
      if (!dirReady) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        dirReady = true;
      }
      fs.appendFileSync(filePath, data, "utf8");
    } catch {
      // ignore write failures silently
    }
  };

  log.info("llm-telemetry logger enabled", { filePath });

  const record = (rec: TelemetryRecord) => {
    const line = safeJsonStringify(rec);
    if (!line) {return;}
    writeSync(`${line}\n`);
  };

  const wrapStreamFn: LlmTelemetryLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const currentIteration = iterationIndex++;
      const requestStartedAt = Date.now();
      let firstTokenAt: number | null = null;
      const outputParts: string[] = [];

      // Extract the full input content (messages) from context.
      // pi-ai passes context as { messages, system, ... }
      const ctx = context as unknown as { messages?: unknown; system?: unknown };
      let inputContent = "";
      try {
        inputContent = safeJsonStringify({ system: ctx?.system, messages: ctx?.messages }) ?? "";
      } catch {
        inputContent = "(serialization failed)";
      }

      // Intercept the onPayload option to also log the raw request body.
      // (We still call the original onPayload if present so no functionality breaks.)
      const originalOnPayload = options?.onPayload;
      const nextOptions = {
        ...options,
        onPayload: (payload: unknown, m: typeof model) => {
          return originalOnPayload?.(payload, m);
        },
      };

      // Call the real streamFn.
      const streamOrPromise = streamFn(model, context, nextOptions);

      type EventStream = ReturnType<typeof createAssistantMessageEventStream>;

      // Helper: given the resolved stream, wrap it with our interceptor.
      const wrapStream = (innerStream: EventStream): EventStream => {
        const out = createAssistantMessageEventStream();

        // Drain the inner stream, capture events, re-emit to outer.
        (async () => {
          try {
            for await (const event of innerStream) {
              const ev = event;

              // Capture first substantive token → TTFT.
              // Any of text_start / toolcall_start / thinking_start counts as
              // "first token" — the model has started generating content.
              if (
                firstTokenAt === null &&
                (ev.type === "text_start" ||
                  ev.type === "toolcall_start" ||
                  ev.type === "thinking_start")
              ) {
                firstTokenAt = Date.now();
              }

              // Accumulate output: text deltas → plain text; toolcall
              // completions → JSON-serialized tool call for the record.
              if (ev.type === "text_delta") {
                outputParts.push(ev.delta);
              } else if (ev.type === "toolcall_end") {
                outputParts.push(`[tool:${safeJsonStringify(ev.toolCall) ?? ""}]`);
              }

              // Re-emit the event unchanged.
              out.push(ev);

              // On terminal events, write the telemetry record.
              if (ev.type === "done" || ev.type === "error") {
                const completedAt = Date.now();
                const assistantMsg =
                  ev.type === "done" ? ev.message : ev.error;
                const usage = (assistantMsg as { usage?: unknown })?.usage as
                  | {
                      input?: number;
                      output?: number;
                      cacheRead?: number;
                      cacheWrite?: number;
                      totalTokens?: number;
                      input_tokens?: number;
                      output_tokens?: number;
                      prompt_tokens?: number;
                      completion_tokens?: number;
                      inputTokens?: number;
                      outputTokens?: number;
                      cache_read_input_tokens?: number;
                      cache_creation_input_tokens?: number;
                      cached_tokens?: number;
                    }
                  | undefined;

                const inputTokens =
                  usage?.input ??
                  usage?.input_tokens ??
                  usage?.prompt_tokens ??
                  usage?.inputTokens ??
                  null;
                const outputTokens =
                  usage?.output ??
                  usage?.output_tokens ??
                  usage?.completion_tokens ??
                  usage?.outputTokens ??
                  null;
                const cacheReadTokens =
                  usage?.cacheRead ??
                  usage?.cache_read_input_tokens ??
                  usage?.cached_tokens ??
                  null;
                const cacheWriteTokens =
                  usage?.cacheWrite ?? usage?.cache_creation_input_tokens ?? null;

                const durationMs = completedAt - requestStartedAt;
                const ttftMs =
                  firstTokenAt !== null ? firstTokenAt - requestStartedAt : null;

                let tpotMs: number | null = null;
                if (
                  firstTokenAt !== null &&
                  outputTokens !== null &&
                  outputTokens > 1
                ) {
                  tpotMs = (completedAt - firstTokenAt) / (outputTokens - 1);
                }

                const stopReason =
                  ev.type === "done"
                    ? ev.reason
                    : (assistantMsg as { stopReason?: string })?.stopReason ??
                      "error";

                record({
                  ts: new Date(requestStartedAt).toISOString(),
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  runId: params.runId,
                  provider: params.provider,
                  modelId: params.modelId,
                  modelApi: params.modelApi,
                  iterationIndex: currentIteration,
                  requestStartedAt,
                  firstTokenAt,
                  completedAt,
                  ttftMs,
                  tpotMs,
                  durationMs,
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  inputContent,
                  outputContent: outputParts.join(""),
                  stopReason,
                });

                log.info("llm-telemetry recorded", {
                  sessionId: params.sessionId,
                  provider: params.provider,
                  modelId: params.modelId,
                  iterationIndex: currentIteration,
                  ttftMs,
                  tpotMs,
                  inputTokens,
                  outputTokens,
                  durationMs,
                });

                out.end(assistantMsg);
                return;
              }
            }
            // Stream ended without a done/error event — end output stream cleanly.
            out.end();
          } catch (err) {
            // Pass through any error as a stream error record.
            const completedAt = Date.now();
            record({
              ts: new Date(requestStartedAt).toISOString(),
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              runId: params.runId,
              provider: params.provider,
              modelId: params.modelId,
              modelApi: params.modelApi,
              iterationIndex: currentIteration,
              requestStartedAt,
              firstTokenAt,
              completedAt,
              ttftMs: firstTokenAt !== null ? firstTokenAt - requestStartedAt : null,
              tpotMs: null,
              durationMs: completedAt - requestStartedAt,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              inputContent,
              outputContent: outputParts.join(""),
              stopReason: "error",
            });
            out.end();
          }
        })();

        return out;
      };

      // streamFn can return the stream directly or a Promise<stream>.
      if (streamOrPromise instanceof Promise) {
        // Return a new stream that resolves once the inner promise resolves.
        const out = createAssistantMessageEventStream();
        streamOrPromise
          .then((innerStream) => {
            const wrapped2 = wrapStream(innerStream);
            (async () => {
              try {
                for await (const event of wrapped2) {
                  out.push(event);
                }
                out.end();
              } catch {
                out.end();
              }
            })();
          })
          .catch(() => {
            out.end();
          });
        return out as unknown as Awaited<ReturnType<typeof streamFn>>;
      }

      return wrapStream(
        streamOrPromise as unknown as EventStream,
      ) as unknown as Awaited<ReturnType<typeof streamFn>>;
    };

    return wrapped;
  };

  log.info("llm-telemetry logger enabled", { filePath });
  return { enabled: true, wrapStreamFn };
}

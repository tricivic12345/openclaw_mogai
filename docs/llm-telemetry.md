# LLM Telemetry

OpenClaw 内置了 LLM 遥测功能，可以逐轮捕获每次 LLM 调用的完整指标，并以 JSONL 格式导出。

## 功能概述

每次 LLM 调用（包括 Agent 一次对话中的多轮工具调用循环）都会生成一条 JSONL 记录，包含：

| 字段 | 说明 |
|------|------|
| `ts` | 请求开始时间（ISO 8601） |
| `sessionId` | OpenClaw 会话 ID |
| `sessionKey` | OpenClaw 会话 Key |
| `runId` | 本次运行标识 |
| `provider` | 模型提供商（如 `openrouter`、`anthropic`、`openai`） |
| `modelId` | 模型 ID（如 `stepfun/step-3.5-flash:free`） |
| `modelApi` | 底层 API 类型（如 `openai-completions`、`anthropic-messages`） |
| `iterationIndex` | 当前会话中的 LLM 调用轮次（0 起，工具调用循环每次+1） |
| `requestStartedAt` | 请求开始的 Unix epoch 毫秒 |
| `firstTokenAt` | 收到第一个 token 的 Unix epoch 毫秒（无文本输出时为 `null`） |
| `completedAt` | 流结束的 Unix epoch 毫秒 |
| `ttftMs` | **首 Token 时延（TTFT）**，单位毫秒。触发于 `text_start` / `toolcall_start` / `thinking_start` 中最先到达的事件。仅当流完全无输出时为 `null` |
| `tpotMs` | **每 Token 时延（TPOT）**，单位 ms/token。公式：`(completedAt - firstTokenAt) / (outputTokens - 1)` |
| `durationMs` | 总调用时长（毫秒） |
| `inputTokens` | 输入 token 数（若 provider 不报告则为 `null`） |
| `outputTokens` | 输出 token 数（若 provider 不报告则为 `null`） |
| `cacheReadTokens` | 缓存读取 token 数（Anthropic prompt caching） |
| `cacheWriteTokens` | 缓存写入 token 数（Anthropic prompt caching） |
| `inputContent` | 发送给 LLM 的完整输入内容（JSON 序列化的 messages 数组，包含 system prompt 和历史消息） |
| `outputContent` | LLM 返回的完整文本输出（流式 delta 拼接，工具调用轮次为空字符串） |
| `stopReason` | 停止原因：`stop`（正常结束）、`toolUse`（工具调用）、`length`（超长）、`error`、`aborted` |

## 启用方式

遥测功能通过环境变量控制，需要在**启动 Gateway 时**设置（不是在 CLI 命令时）：

```bash
OPENCLAW_LLM_TELEMETRY=true openclaw gateway run --bind loopback --port 18789
```

或使用自定义输出路径：

```bash
OPENCLAW_LLM_TELEMETRY=true \
OPENCLAW_LLM_TELEMETRY_FILE=/path/to/output.jsonl \
openclaw gateway run --bind loopback --port 18789
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLAW_LLM_TELEMETRY` | `false` | 设为 `true`/`1`/`yes`/`on` 启用 |
| `OPENCLAW_LLM_TELEMETRY_FILE` | `~/.openclaw/logs/llm-telemetry.jsonl` | 输出文件路径 |

## 完整运行步骤

### 1. 构建（源码模式）

```bash
cd /home/bob/openclaw
pnpm install
node scripts/tsdown-build.mjs
```

### 2. 启动带遥测的 Gateway

```bash
cd /home/bob/openclaw
OPENCLAW_LLM_TELEMETRY=true \
OPENCLAW_LLM_TELEMETRY_FILE=~/.openclaw/logs/llm-telemetry.jsonl \
node openclaw.mjs gateway run --bind loopback --port 18789
```

或者后台运行：

```bash
OPENCLAW_LLM_TELEMETRY=true \
OPENCLAW_LLM_TELEMETRY_FILE=~/.openclaw/logs/llm-telemetry.jsonl \
nohup node openclaw.mjs gateway run --bind loopback --port 18789 \
  > /tmp/openclaw-gateway.log 2>&1 &
```

### 3. 发送消息

```bash
cd /home/bob/openclaw
# 简单问答（单轮）
node openclaw.mjs agent --message "What is 2+2?" --agent main --thinking off

# 带工具调用（多轮）
node openclaw.mjs agent --message "Run: echo hello" --agent main --thinking off
```

### 4. 查看遥测数据

```bash
# 查看记录数
wc -l ~/.openclaw/logs/llm-telemetry.jsonl

# 格式化查看最新一条
tail -1 ~/.openclaw/logs/llm-telemetry.jsonl | python3 -m json.tool

# 查看所有记录的关键指标
cat ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys
for i, line in enumerate(sys.stdin):
    r = json.loads(line)
    print(f'[{i}] iter={r[\"iterationIndex\"]} ttft={r[\"ttftMs\"]}ms tpot={r[\"tpotMs\"]}ms/tok in={r[\"inputTokens\"]} out={r[\"outputTokens\"]} stop={r[\"stopReason\"]}')
    print(f'    output: {repr(r[\"outputContent\"][:100])}')
"
```

## 示例输出

### 单轮对话（直接回答）

```json
{
  "ts": "2026-03-21T13:53:40.424Z",
  "sessionId": "aa7d25c5-414d-4ac3-ac32-979655384f4b",
  "sessionKey": "main",
  "runId": "run_abc123",
  "provider": "openrouter",
  "modelId": "stepfun/step-3.5-flash:free",
  "modelApi": "openai-completions",
  "iterationIndex": 0,
  "requestStartedAt": 1774100620424,
  "firstTokenAt": 1774100700600,
  "completedAt": 1774100701579,
  "ttftMs": 80176,
  "tpotMs": 11.795,
  "durationMs": 81155,
  "inputTokens": 194298,
  "outputTokens": 84,
  "cacheReadTokens": null,
  "cacheWriteTokens": null,
  "inputContent": "{\"messages\":[{\"role\":\"user\",\"content\":\"What is 3+3? Give just the number.\"}]}",
  "outputContent": "6",
  "stopReason": "stop"
}
```

### 多轮对话（含工具调用）

工具调用场景会产生 2 条记录：

**第 0 轮**（模型决策调用工具）：
```json
{
  "iterationIndex": 0,
  "ttftMs": 10925,
  "tpotMs": 8.806,
  "durationMs": 11744,
  "inputTokens": 194408,
  "outputTokens": 94,
  "outputContent": "[tool:{\"type\":\"toolCall\",\"id\":\"call_307036400f\",\"name\":\"exec\",\"arguments\":{\"command\":\"echo hello_telemetry\"}}]",
  "stopReason": "toolUse"
}
```

> `outputContent` 在工具调用轮次中以 `[tool:{...}]` 格式记录完整工具调用 JSON，包含工具名和参数。TTFT/TPOT 均正常计算（触发时机为 `toolcall_start` 事件）。

**第 1 轮**（模型收到工具结果后回复）：
```json
{
  "iterationIndex": 1,
  "ttftMs": 19632,
  "tpotMs": 9.042,
  "durationMs": 20274,
  "inputTokens": 194488,
  "outputTokens": 72,
  "outputContent": "hello_telemetry",
  "stopReason": "stop"
}
```

## 工作原理

### 代码修改说明

实现分两个文件：

**1. `src/agents/llm-telemetry.ts`**（新增）

核心遥测模块，使用与 `anthropic-payload-log.ts` 相同的 `wrapStreamFn` 模式。

工作流程：
- `createLlmTelemetryLogger()` — 创建 logger 实例（受 `OPENCLAW_LLM_TELEMETRY` 控制）
- `wrapStreamFn(streamFn)` — 包装实际 streamFn，拦截所有流事件
- 在 `for await` 循环中：
  - 捕获第一个 `text_delta` 事件 → 记录 `firstTokenAt`（TTFT）
  - 累积所有 `text_delta.delta` → 构成 `outputContent`
  - 在 `done`/`error` 事件 → 从 `AssistantMessage.usage` 提取 token 数 → 同步写入 JSONL
- 使用 `fs.appendFileSync` 同步写入，确保进程退出前数据不丢失

**2. `src/agents/pi-embedded-runner/run/attempt.ts`**（修改）

在 `anthropicPayloadLogger` 之后添加 `llmTelemetryLogger` 的接入：

```typescript
// 新增导入
import { createLlmTelemetryLogger } from "../../llm-telemetry.js";

// 在 anthropicPayloadLogger 创建之后
const llmTelemetryLogger = createLlmTelemetryLogger({
  env: process.env,
  runId: params.runId,
  sessionId: activeSession.sessionId,
  sessionKey: params.sessionKey,
  provider: params.provider,
  modelId: params.modelId,
  modelApi: params.model.api,
});

// 在 anthropicPayloadLogger.wrapStreamFn 之后
if (llmTelemetryLogger) {
  activeSession.agent.streamFn = llmTelemetryLogger.wrapStreamFn(
    activeSession.agent.streamFn,
  );
}
```

### 重要说明

- **Gateway 进程**：OpenClaw 的实际 LLM 调用在 Gateway 进程中执行，因此遥测环境变量必须在 Gateway 启动时设置，而不是在 CLI 命令时
- **适用所有 Provider**：遥测适用于 Anthropic、OpenAI、OpenRouter、Ollama 等所有提供商，因为它拦截的是通用 streamFn 接口
- **TTFT 测量**：从请求发出到 streamFn 被调用开始计时，直到第一个 `text_delta` 事件到达
- **TPOT 测量**：`(completedAt - firstTokenAt) / (outputTokens - 1)`，仅在有文本输出且 `outputTokens > 1` 时计算
- **全文内容**：`inputContent` 包含完整的 messages 数组（系统 prompt + 历史消息），`outputContent` 是模型生成的完整文本

## 使用 npm 全局安装版本

如果使用 `npm install -g openclaw@latest` 安装的版本，需要修改 systemd 服务或 launchd plist 来添加环境变量：

**Linux (systemd)**：

```bash
systemctl --user edit openclaw-gateway.service
```

添加：
```ini
[Service]
Environment="OPENCLAW_LLM_TELEMETRY=true"
Environment="OPENCLAW_LLM_TELEMETRY_FILE=/home/user/.openclaw/logs/llm-telemetry.jsonl"
```

然后：
```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

注意：全局安装版本不包含此功能，需要从源码编译安装（见上面步骤）。

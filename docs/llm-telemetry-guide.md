# OpenClaw LLM 遥测功能使用说明

本文档描述如何构建、安装、启动带 LLM 遥测功能的 OpenClaw，以及如何查看统计数据。

---

## 一、背景与改动概述

### 功能目标

对每次与 LLM 大模型的交互（含 Agent 工具调用的每一轮）自动记录以下数据，并在对话结束后导出到本地文件：

| 指标 | 说明 |
|------|------|
| **TTFT** | Time To First Token，从发出请求到收到第一个 token 的时延（ms） |
| **TPOT** | Time Per Output Token，每个输出 token 的平均生成时延（ms/token） |
| **输入 token 数** | 本轮发送给模型的 prompt token 总数 |
| **输出 token 数** | 本轮模型返回的 completion token 总数 |
| **输入内容全文** | 发送给模型的完整消息数组（系统 prompt + 历史消息），JSON 格式明文 |
| **输出内容全文** | 模型返回的完整文本；工具调用轮次记录工具名和参数 |

一次 Agent 对话若需要多轮与模型交互（如先调用工具、再生成回复），每轮分别导出一条记录，通过 `iterationIndex` 区分。

### 修改的文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/agents/llm-telemetry.ts` | **新增** | 遥测核心模块，拦截所有 provider 的流式输出 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | **修改** | 在 streamFn 链中接入遥测 logger |
| `~/.config/systemd/user/openclaw-gateway.service` | **修改** | systemd 服务改为指向源码版本，并注入遥测环境变量 |

---

## 二、环境要求

- OS：Linux（已在 Ubuntu 22.04 验证）
- Node.js：22+
- pnpm：已安装
- 源码路径：`/home/bob/openclaw`
- OpenClaw 配置目录：`~/.openclaw`

---

## 三、一次性构建与安装

> **注意**：以下步骤只需执行一次。之后每次开机，gateway 会由 systemd 自动以遥测模式启动。

### 步骤 1：进入源码目录，安装依赖并构建

```bash
cd /home/bob/openclaw
pnpm install
node scripts/tsdown-build.mjs
```

构建成功输出：`BUILD: 0`（无报错）

验证遥测代码已编译进产物：

```bash
grep -rl "OPENCLAW_LLM_TELEMETRY" /home/bob/openclaw/dist/*.js
# 应输出一个 auth-profiles-*.js 文件路径
```

### 步骤 2：停止所有旧 gateway 进程

```bash
pkill -9 -f "openclaw-gateway" 2>/dev/null
pkill -9 -f "node.*openclaw.mjs gateway" 2>/dev/null
systemctl --user stop openclaw-gateway.service 2>/dev/null
sleep 3
rm -f ~/.openclaw/gateway.lock
```

### 步骤 3：写入新的 systemd 服务文件

将以下内容写入 `~/.config/systemd/user/openclaw-gateway.service`（**完整替换**）：

```ini
[Unit]
Description=OpenClaw Gateway (v2026.3.14+telemetry)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/bob/openclaw/openclaw.mjs gateway --port 18789
WorkingDirectory=/home/bob/openclaw
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=60
SuccessExitStatus=0 143
KillMode=control-group
Environment=HOME=/home/bob
Environment=TMPDIR=/tmp
Environment=PATH=/home/bob/.local/bin:/home/bob/.npm-global/bin:/home/bob/bin:/home/bob/.volta/bin:/home/bob/.asdf/shims:/home/bob/.bun/bin:/home/bob/.nvm/current/bin:/home/bob/.fnm/current/bin:/home/bob/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin
Environment=OPENCLAW_GATEWAY_PORT=18789
Environment=OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service
Environment="OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway
Environment=OPENCLAW_SERVICE_VERSION=2026.3.14
Environment=OPENCLAW_RAW_STREAM=1
Environment=OPENCLAW_RAW_STREAM_PATH=/home/bob/.openclaw/logs/raw-stream.jsonl
Environment=OPENCLAW_LLM_TELEMETRY=true
Environment=OPENCLAW_LLM_TELEMETRY_FILE=/home/bob/.openclaw/logs/llm-telemetry.jsonl

[Install]
WantedBy=default.target
```

或者直接用命令覆盖（无需手动编辑）：

```bash
cat > ~/.config/systemd/user/openclaw-gateway.service << 'EOF'
[Unit]
Description=OpenClaw Gateway (v2026.3.14+telemetry)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/bob/openclaw/openclaw.mjs gateway --port 18789
WorkingDirectory=/home/bob/openclaw
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=60
SuccessExitStatus=0 143
KillMode=control-group
Environment=HOME=/home/bob
Environment=TMPDIR=/tmp
Environment=PATH=/home/bob/.local/bin:/home/bob/.npm-global/bin:/home/bob/bin:/home/bob/.volta/bin:/home/bob/.asdf/shims:/home/bob/.bun/bin:/home/bob/.nvm/current/bin:/home/bob/.fnm/current/bin:/home/bob/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin
Environment=OPENCLAW_GATEWAY_PORT=18789
Environment=OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service
Environment="OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway
Environment=OPENCLAW_SERVICE_VERSION=2026.3.14
Environment=OPENCLAW_RAW_STREAM=1
Environment=OPENCLAW_RAW_STREAM_PATH=/home/bob/.openclaw/logs/raw-stream.jsonl
Environment=OPENCLAW_LLM_TELEMETRY=true
Environment=OPENCLAW_LLM_TELEMETRY_FILE=/home/bob/.openclaw/logs/llm-telemetry.jsonl

[Install]
WantedBy=default.target
EOF
```

### 步骤 4：重新加载 systemd 并启动服务

```bash
systemctl --user daemon-reload
systemctl --user start openclaw-gateway.service
```

等待约 30 秒让 gateway 完成初始化，然后验证：

```bash
systemctl --user status openclaw-gateway.service
```

输出中 `Active: active (running)` 即为成功。

验证遥测环境变量已注入进程（将 `<PID>` 替换为上面 status 输出中的 `Main PID`）：

```bash
GATEWAY_PID=$(systemctl --user show -p MainPID --value openclaw-gateway.service)
cat /proc/$GATEWAY_PID/environ | tr '\0' '\n' | grep OPENCLAW_LLM_TELEMETRY
```

应输出：

```
OPENCLAW_LLM_TELEMETRY=true
OPENCLAW_LLM_TELEMETRY_FILE=/home/bob/.openclaw/logs/llm-telemetry.jsonl
```

---

## 四、日常使用

安装完成后，**无需任何额外操作**。

在任意对话界面（Web UI、CLI、Discord、Telegram 等）正常输入问题，遥测数据自动写入：

```
~/.openclaw/logs/llm-telemetry.jsonl
```

每次 LLM 调用完成后立即追加一条记录。一次对话若包含多轮 LLM 交互（工具调用 + 最终回复），每轮写入一条，`iterationIndex` 从 0 递增。

---

## 五、查看统计数据

### 5.1 数据文件位置

```
~/.openclaw/logs/llm-telemetry.jsonl
```

每行一个 JSON 对象（JSONL 格式），按时间追加，不自动清空。

### 5.2 实时监看（推荐）

发消息后立刻在终端看到本轮数据：

```bash
tail -f ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys
for line in sys.stdin:
    r = json.loads(line)
    print(f'[轮{r[\"iterationIndex\"]}] TTFT={r[\"ttftMs\"]}ms  TPOT={r[\"tpotMs\"]}ms/tok  输入={r[\"inputTokens\"]}tok  输出={r[\"outputTokens\"]}tok  停止={r[\"stopReason\"]}')
    print(f'  输出内容: {repr(r[\"outputContent\"][:150])}')
    sys.stdout.flush()
"
```

### 5.3 查看最新一条完整记录

```bash
tail -1 ~/.openclaw/logs/llm-telemetry.jsonl | python3 -m json.tool
```

### 5.4 查看最近 N 条的关键指标

```bash
tail -10 ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys
for i, line in enumerate(sys.stdin):
    r = json.loads(line)
    print(f'--- 第{i+1}条  {r[\"ts\"]} ---')
    print(f'  会话:     {r.get(\"sessionKey\")} / {r.get(\"sessionId\",\"\")[:8]}...')
    print(f'  模型:     {r.get(\"provider\")} / {r.get(\"modelId\")}')
    print(f'  轮次:     iterationIndex={r[\"iterationIndex\"]}')
    print(f'  TTFT:     {r[\"ttftMs\"]} ms')
    print(f'  TPOT:     {r[\"tpotMs\"]} ms/token')
    print(f'  总耗时:   {r[\"durationMs\"]} ms')
    print(f'  输入tok:  {r[\"inputTokens\"]}')
    print(f'  输出tok:  {r[\"outputTokens\"]}')
    print(f'  停止原因: {r[\"stopReason\"]}')
    print(f'  输出内容: {repr(r[\"outputContent\"][:200])}')
    print()
"
```

### 5.5 查看完整输入内容（发给模型的全部消息）

```bash
tail -1 ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys
r = json.load(sys.stdin)
data = json.loads(r['inputContent'])
print(f'=== system prompt ===')
print(str(data.get('system', ''))[:500])
print()
print(f'=== messages ({len(data.get(\"messages\",[]))} 条) ===')
for m in data.get('messages', []):
    role = m.get('role', '?')
    content = m.get('content', '')
    if isinstance(content, list):
        content = ' '.join(c.get('text','') for c in content if c.get('type')=='text')
    print(f'[{role}] {str(content)[:300]}')
    print()
"
```

### 5.6 汇总统计（全部历史数据）

```bash
cat ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys
records = [json.loads(l) for l in sys.stdin]
print(f'总记录数:     {len(records)} 条')
ttfts  = [r['ttftMs']      for r in records if r['ttftMs']      is not None]
tpots  = [r['tpotMs']      for r in records if r['tpotMs']      is not None]
in_tok = [r['inputTokens'] for r in records if r['inputTokens'] is not None]
out_tok= [r['outputTokens']for r in records if r['outputTokens']is not None]
durs   = [r['durationMs']  for r in records if r['durationMs']  is not None]
if ttfts:
    print(f'TTFT:         平均 {sum(ttfts)/len(ttfts):.0f}ms  最小 {min(ttfts)}ms  最大 {max(ttfts)}ms')
if tpots:
    print(f'TPOT:         平均 {sum(tpots)/len(tpots):.2f} ms/token')
if durs:
    print(f'总耗时:       平均 {sum(durs)/len(durs):.0f}ms  最大 {max(durs)}ms')
if in_tok:
    print(f'累计输入tok:  {sum(in_tok):,}')
if out_tok:
    print(f'累计输出tok:  {sum(out_tok):,}')
stops = {}
for r in records:
    stops[r['stopReason']] = stops.get(r['stopReason'], 0) + 1
print(f'停止原因分布: {stops}')
"
```

### 5.7 按会话查看某次对话的所有轮次

```bash
# 先查有哪些 sessionKey
cat ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys
keys = {}
for line in sys.stdin:
    r = json.loads(line)
    k = r.get('sessionKey','?')
    keys[k] = keys.get(k, 0) + 1
for k, n in sorted(keys.items()):
    print(f'  {k}: {n} 条')
"

# 再过滤某个会话
SESSION="agent:main:main"
cat ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys
target = '$SESSION'
for line in sys.stdin:
    r = json.loads(line)
    if r.get('sessionKey') == target:
        print(f'[轮{r[\"iterationIndex\"]}] {r[\"ts\"]}  TTFT={r[\"ttftMs\"]}ms  out={repr(r[\"outputContent\"][:100])}')
"
```

---

## 六、记录字段说明

每条 JSONL 记录包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ts` | string | 请求开始时间（ISO 8601 UTC） |
| `sessionId` | string | 会话 UUID |
| `sessionKey` | string | 会话名称（如 `agent:main:main`） |
| `runId` | string | 本次运行的唯一 ID |
| `provider` | string | 模型提供商（如 `openrouter`、`anthropic`） |
| `modelId` | string | 模型 ID（如 `stepfun/step-3.5-flash:free`） |
| `modelApi` | string | 底层 API 类型（如 `openai-completions`） |
| `iterationIndex` | number | 本次对话中第几轮 LLM 调用，0 起 |
| `requestStartedAt` | number | 请求发出的 Unix epoch 毫秒 |
| `firstTokenAt` | number\|null | 收到首个 token 的 Unix epoch 毫秒 |
| `completedAt` | number | 流结束的 Unix epoch 毫秒 |
| `ttftMs` | number\|null | **TTFT**，首 token 时延（ms）。触发于 `text_start` / `toolcall_start` / `thinking_start` 中最先到达的事件 |
| `tpotMs` | number\|null | **TPOT**，每输出 token 时延（ms/token）。公式：`(completedAt - firstTokenAt) / (outputTokens - 1)` |
| `durationMs` | number | 总调用时长（ms） |
| `inputTokens` | number\|null | 输入 token 数（若 provider 不上报则为 null） |
| `outputTokens` | number\|null | 输出 token 数（若 provider 不上报则为 null） |
| `cacheReadTokens` | number\|null | 缓存读取 token 数（Anthropic prompt caching） |
| `cacheWriteTokens` | number\|null | 缓存写入 token 数（Anthropic prompt caching） |
| `inputContent` | string | 发给模型的完整输入（JSON 序列化），包含 `system` 和 `messages` 数组 |
| `outputContent` | string | 模型返回的完整内容明文。文本轮次为纯文本；工具调用轮次为 `[tool:{...}]` 格式（含工具名和参数） |
| `stopReason` | string | `stop`（正常结束）/ `toolUse`（发起工具调用）/ `length`（超长截断）/ `error` / `aborted` |

### 示例记录（文本回复轮次）

```json
{
  "ts": "2026-03-21T14:26:09.565Z",
  "sessionId": "aa7d25c5-414d-4ac3-ac32-979655384f4b",
  "sessionKey": "agent:main:main",
  "runId": "ddde046a-8458-45d3-8a8a-f3403ded9ef0",
  "provider": "openrouter",
  "modelId": "stepfun/step-3.5-flash:free",
  "modelApi": "openai-completions",
  "iterationIndex": 0,
  "requestStartedAt": 1774100551483,
  "firstTokenAt": 1774100561408,
  "completedAt": 1774100562638,
  "ttftMs": 9925,
  "tpotMs": 11.53,
  "durationMs": 11155,
  "inputTokens": 194205,
  "outputTokens": 90,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "inputContent": "{\"system\":\"You are a personal assistant...\",\"messages\":[{\"role\":\"user\",\"content\":\"3乘以7等于多少\"}]}",
  "outputContent": "21",
  "stopReason": "stop"
}
```

### 示例记录（工具调用轮次）

```json
{
  "ts": "2026-03-21T14:33:52.013Z",
  "sessionId": "aa7d25c5-414d-4ac3-ac32-979655384f4b",
  "sessionKey": "agent:main:main",
  "runId": "ddde046a-8458-45d3-8a8a-f3403ded9ef0",
  "provider": "openrouter",
  "modelId": "stepfun/step-3.5-flash:free",
  "modelApi": "openai-completions",
  "iterationIndex": 0,
  "requestStartedAt": 1774103632013,
  "firstTokenAt": 1774103642503,
  "completedAt": 1774103644228,
  "ttftMs": 10490,
  "tpotMs": 18.55,
  "durationMs": 12215,
  "inputTokens": 194246,
  "outputTokens": 94,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "inputContent": "{\"system\":\"...\",\"messages\":[...]}",
  "outputContent": "[tool:{\"type\":\"toolCall\",\"id\":\"call_5a915d0df6ac4b64\",\"name\":\"exec\",\"arguments\":{\"command\":\"echo hello\"}}]",
  "stopReason": "toolUse"
}
```

---

## 七、服务管理

```bash
# 查看服务状态
systemctl --user status openclaw-gateway.service

# 重启服务（如修改了源码需重新构建后重启）
systemctl --user restart openclaw-gateway.service

# 查看服务日志（最近 100 行）
journalctl --user -u openclaw-gateway.service -n 100

# 实时跟踪服务日志
journalctl --user -u openclaw-gateway.service -f

# 停止服务
systemctl --user stop openclaw-gateway.service

# 禁止开机自启
systemctl --user disable openclaw-gateway.service

# 恢复开机自启
systemctl --user enable openclaw-gateway.service
```

---

## 八、源码修改后的更新流程

每次修改源码后，按以下步骤更新：

```bash
cd /home/bob/openclaw

# 1. 重新构建
node scripts/tsdown-build.mjs

# 2. 重启 gateway 服务（自动加载新构建）
systemctl --user restart openclaw-gateway.service

# 3. 等待约 30 秒后验证
systemctl --user status openclaw-gateway.service
```

---

## 九、遥测数据管理

### 清空历史数据（重新统计）

```bash
> ~/.openclaw/logs/llm-telemetry.jsonl
```

### 备份数据

```bash
cp ~/.openclaw/logs/llm-telemetry.jsonl \
   ~/.openclaw/logs/llm-telemetry-$(date +%Y%m%d-%H%M%S).jsonl
```

### 导出为 CSV

```bash
cat ~/.openclaw/logs/llm-telemetry.jsonl | python3 -c "
import json, sys, csv
records = [json.loads(l) for l in sys.stdin]
if not records: sys.exit()
fields = ['ts','sessionKey','provider','modelId','iterationIndex',
          'ttftMs','tpotMs','durationMs','inputTokens','outputTokens',
          'cacheReadTokens','cacheWriteTokens','stopReason']
w = csv.DictWriter(sys.stdout, fieldnames=fields, extrasaction='ignore')
w.writeheader()
w.writerows(records)
" > ~/llm-telemetry-export.csv
echo "已导出到 ~/llm-telemetry-export.csv"
```

---

## 十、工作原理简述

```
用户输入
    ↓
openclaw agent CLI / Web UI / IM 渠道
    ↓
Gateway 进程（openclaw-gateway，带 OPENCLAW_LLM_TELEMETRY=true）
    ↓
runEmbeddedAttempt()  [src/agents/pi-embedded-runner/run/attempt.ts]
    ↓
llmTelemetryLogger.wrapStreamFn(streamFn)  ← 遥测拦截层
    ↓
实际 LLM API（OpenRouter / Anthropic / OpenAI / Ollama）
    ↓
AssistantMessageEventStream 事件流：
  text_start / toolcall_start → 记录 firstTokenAt（TTFT 锚点）
  text_delta                  → 累积 outputContent
  toolcall_end                → 追加 [tool:{...}] 到 outputContent
  done / error                → 提取 usage（token 数）→ fs.appendFileSync 写入 JSONL
```

遥测模块使用**同步写入**（`fs.appendFileSync`），确保进程退出前数据不丢失。

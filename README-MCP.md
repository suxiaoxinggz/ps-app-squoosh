# Squoosh MCP — 图片压缩双入口平台

同一套图片处理能力，两种入口：

| 入口            | 地址                                                               | 说明                                                                            |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 网页用户        | `https://squoosh.016666666.xyz` 或 `http://squoosh.mistorify.com/` | 原 Squoosh PWA，浏览器 WASM 本地压缩（两域名都可用）                            |
| MCP（AI Agent） | `https://squoosh.016666666.xyz/mcp`                                | JSON-RPC + SSE，8 工具（必须用此域名；mistorify 有 Bot 挑战，程序调用会被 403） |
| 本地 MCP        | `mcp-local/`（stdio，本机运行）                                    | 直接读本地文件路径，零云成本                                                    |
| 压缩后端        | Render Node 服务（sharp）                                          | Worker 队列/同步调用                                                            |

架构：`Agent → Worker 网关（MCP/队列/R2/KV）→ Render Node（sharp 真实压缩）→ R2 临时存储（1 天自动清理）→ 绝对下载 URL`。
job 按 token 隔离，只能查自己的 jobId。staging 环境：`https://squooshmcp.016666666.xyz`（Worker 名 `squoosh-mcp-staging`，资源加 `-staging` 后缀；`squooshmcp.mistorify.com` 同域保护下程序调用会被 403）。

## 快速验证

```bash
curl -s https://squoosh.016666666.xyz/health   # {"ok":true}
curl -s https://squoosh.016666666.xyz/ready    # {"ok":true,"checks":{"worker":"ok","render":"ok"}}
node worker/smoke.js                            # 全链路冒烟
```

## MCP 调用（完整 JSON）

统一请求头：`Content-Type: application/json` + `Accept: application/json, text/event-stream`。
鉴权：`Authorization: Bearer <任意唯一字符串>`——**token 即命名空间**：job 隔离 + 限流都按 token 算。给不同用户/项目发不同 token 即可，不传则全是 `anon` 共用配额。

### 1. initialize（返回 `Mcp-Session-Id` 响应头，后续带上）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

### 2. tools/list（8 工具 + prompts/list 有批量指引）

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

工具：`upload_image`、`list_formats`、`get_options_schema`、`get_image_info`、`smart_compress`、`compress`、`batch_compress`、`get_job_status`。

### 3. smart_compress（一句话，默认 webp q80；小图同步秒回）

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "smart_compress",
    "arguments": {
      "source": { "type": "base64", "value": "<base64图片>" },
      "inline": true
    }
  }
}
```

返回：`{"jobId":"...","sync":true,"status":"done","base64":"...","mime":"image/webp"}`。
规则：单张 ≤2MB 走同步（2 秒内，`sync:true`）；大了自动排队（`sync:false`，轮询）。

### 4. compress（单张，全参数）

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "compress",
    "arguments": {
      "source": { "type": "base64", "value": "<base64图片>" },
      "format": "webp",
      "options": { "quality": 80, "width": 800 },
      "inline": true,
      "idempotencyKey": "user123-batch7"
    }
  }
}
```

`source` 三选一：`{"type":"base64","value":"..."}`｜`{"type":"url","value":"https://..."}`（仅 http/https，8s 超时，超大拒绝）｜`{"type":"r2","value":"<r2Key>"}`；或直接传 `r2Key` 字段。
`idempotencyKey`：重试返回同一 jobId，不重复扣资源。

### 5. batch_compress（多张，最多 20 项，恒异步）

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "batch_compress",
    "arguments": {
      "items": [
        {
          "source": {
            "type": "url",
            "value": "https://picsum.photos/seed/a/800/600"
          },
          "format": "jpeg",
          "options": { "quality": 30 }
        },
        {
          "source": {
            "type": "url",
            "value": "https://picsum.photos/seed/b/800/600"
          },
          "format": "webp",
          "options": { "quality": 80, "width": 400 }
        }
      ]
    }
  }
}
```

### 6. get_job_status（轮询，直到 done；URL 是绝对地址）

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": { "name": "get_job_status", "arguments": { "jobId": "<jobId>" } }
}
```

返回示例：

```json
{
  "jobId": "...",
  "status": "done",
  "items": [
    {
      "id": "item-0",
      "status": "done",
      "size": 27064,
      "mime": "image/jpeg",
      "url": "https://squoosh.016666666.xyz/files/.../item-0-out.jpg?token=anon"
    }
  ]
}
```

### 7. get_image_info（压之前先看）

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "get_image_info",
    "arguments": { "source": { "type": "url", "value": "https://..." } }
  }
}
```

返回：`{"size":12345,"mime":"image/jpeg","width":800,"height":600,"format":"jpeg"}`。

### 8. upload_image（大文件先传后压，拿 r2Key）

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "upload_image",
    "arguments": { "source": { "type": "url", "value": "https://..." } }
  }
}
```

## MCP 客户端配置

远程：

```json
{
  "mcpServers": {
    "squoosh": {
      "url": "https://squoosh.016666666.xyz/mcp",
      "headers": {
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer <你的token>"
      }
    }
  }
}
```

本地（直接读文件，无云成本；先 `cd mcp-local && npm install`）：

```json
{
  "mcpServers": {
    "squoosh-local": {
      "command": "node",
      "args": ["/绝对路径/mcp-local/src/server.js"]
    }
  }
}
```

SSE（可选）：`GET https://squoosh.016666666.xyz/mcp/sse`。

## 限制

- 限流：每 token 20 req/min；单 job 最多 20 图；单图 10MB；同步快路径仅单张 ≤2MB。
- 参数钳制：quality 1~100、宽高上限 4000；格式仅 jpeg/png/webp/avif，其它明确报错。
- 非图片（magic bytes 校验不过）直接拒绝，不会当网盘。
- 异步 job 需轮询（建议 4~5s 间隔；Render 冷启动时首单约 30~60s）。
- R2 结果 1 天自动删除（lifecycle），请及时下载。

## 免费额度与费用风险

- Cloudflare（Workers/R2/KV/Queues）：免费层内零费用。风险点：R2 超 10GB 存储、KV 超读、Queues 超调用量会默默扣费——流量起来后去 Dashboard 看用量。
- Render 免费：750h/月 + 休眠（15 分钟无请求会睡，首单慢）。超了或要常驻需 $7/月。
- 超大批量会排队（队列并发 2，保护免费 Render 不被打爆）。

## 部署与运维

- `worker/`：`wrangler deploy`（生产）/ `wrangler deploy --env staging`（先验 staging）。
  必需 secrets：`RENDER_URL`、`RENDER_SECRET`（两边都要 `secret put`，staging 加 `--env staging`）。
- `server/`：Render Web Service，Root Directory `server`，Build `npm install`，Start `npm start`。
  Render Dashboard 需同步设置环境变量 `RENDER_SECRET`（与 Worker 侧同一值），否则直调无鉴权。
- CI：push 到 dev 自动跑 `worker/smoke.js`（`.github/workflows/smoke.yml`）。
- 原有 `src/`、`codecs/` 未改动。

## Upscale (AI super-resolution)

Two editions, same tool names where it matters:

- **Remote** (`upscale_image`, `smart_upscale` on this MCP): 4-model whitelist
  (general-x4v3 default, anime-v3, cugan-2x, swin-light-x2). Jobs are
  **tile-sharded** — one queue message per 256px tile — because the free-tier
  Render instance (512MB) hard-crashes on multi-tile single requests
  (verified in production: 1 tile always survives, 4+ tiles in one request
  kill the process). Worker stitches patches; output always PNG.
  Small inputs (≤0.5MP) with `inline:true` return synchronously.
- **Local** (`upscale` in `mcp-local/`, stdio): all 10 models incl. x4plus 67MB,
  weights in `~/.cache/squoosh-models` (or `SQUOOSH_MODEL_CACHE`), no MP cap
  (warns over 50MP output). Verified: 1024px photo → 4096px PNG via
  general-x4v3 locally.

Worker-enforced budgets (single source of truth in code, not this doc):
output ≤8000px per side and ≤8MP total. Over-budget fails fast with the
measured reason instead of burning retries.

Measured on production free Render (tile-sharded, per-tile wall ms):
single tiles run ~13–24s each; a 0.5MP photo (12 tiles) completes in ~3–4 min
including queue latency. Local Mac: 1024px → 25 tiles, peak RSS ~237MB.

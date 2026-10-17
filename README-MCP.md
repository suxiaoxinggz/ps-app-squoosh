# Squoosh MCP — 图片压缩双入口平台

同一套图片处理能力，两种入口：

| 入口            | 地址                                | 说明                                 |
| --------------- | ----------------------------------- | ------------------------------------ |
| 网页用户        | `https://squoosh.mistorify.com`     | 原 Squoosh PWA，浏览器 WASM 本地压缩 |
| MCP（AI Agent） | `https://squoosh.mistorify.com/mcp` | JSON-RPC + SSE，异步压缩             |
| 压缩后端        | Render Node 服务（sharp）           | Worker 队列调用                      |

架构：`Agent → Worker 网关（MCP/队列/R2/KV）→ Render Node（sharp 真实压缩）→ R2 临时存储 → 签名下载 URL`。
结果文件 24h 自动清理；job 按 token 隔离，只能查自己的 jobId。

## 快速验证

```bash
curl -s https://squoosh.mistorify.com/health
# {"ok":true}
```

## MCP 调用（完整 JSON）

统一请求头：`Content-Type: application/json` + `Accept: application/json, text/event-stream`。
可选鉴权：`Authorization: Bearer <token>`（不传则为 `anon`；job 与 token 绑定）。

### 1. initialize（会返回 `Mcp-Session-Id` 响应头，后续请求带上）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

### 2. tools/list

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

返回 6 个工具：`upload_image`、`list_formats`、`get_options_schema`、`compress`、`batch_compress`、`get_job_status`
（每个含 `inputSchema`、`outputSchema`、`annotations`）。

### 3. list_formats（只列真实支持的格式）

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "list_formats", "arguments": {} }
}
```

返回示例：`{"formats":[{"id":"jpeg","mime":"image/jpeg","ext":"jpg"}, {"id":"png",...}, {"id":"webp",...}, {"id":"avif",...}]}`。

### 4. get_options_schema

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": { "name": "get_options_schema", "arguments": { "format": "webp" } }
}
```

返回：`{"format":"webp","schema":{"quality":{...},"width":{...},"height":{...},"lossless":{...}}}`。

### 5. compress（单张，异步排队）

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "compress",
    "arguments": {
      "source": { "type": "base64", "value": "<base64图片>" },
      "format": "webp",
      "options": { "quality": 80, "width": 800 }
    }
  }
}
```

`source` 三选一：`{"type":"base64","value":"..."} | {"type":"url","value":"https://..."} | {"type":"r2","value":"<r2Key>"}`。
返回：`{"jobId":"..."}`（状态为 queued，需轮询）。

### 6. batch_compress（多张，最多 20 项）

```json
{
  "jsonrpc": "2.0",
  "id": 6,
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
        },
        {
          "source": {
            "type": "url",
            "value": "https://picsum.photos/seed/c/800/600"
          },
          "format": "avif",
          "options": { "quality": 60 }
        }
      ]
    }
  }
}
```

### 7. get_job_status（轮询，直到 done）

```json
{
  "jsonrpc": "2.0",
  "id": 7,
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
      "url": "/files/.../item-0-out.jpg?token=anon"
    }
  ]
}
```

下载：`GET https://squoosh.mistorify.com/files/<jobId>/<文件名>?token=<token>`。

### 8. upload_image（大文件先传后压）

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

返回 `{"jobId":"...","r2Key":"jobs/.../input-..."}`，再用 `{"r2Key":"..."}` 调 compress。

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "squoosh": {
      "url": "https://squoosh.mistorify.com/mcp",
      "headers": { "Authorization": "Bearer <你的token>" }
    }
  }
}
```

SSE（可选）：`GET https://squoosh.mistorify.com/mcp/sse`（返回 `event: endpoint / data: /mcp` + 心跳）。

## 限制

- 限流：每 token 20 req/min；单 job 最多 20 图；单图 10MB。
- 异步：compress 返回后为 queued，队列处理需几秒到几十秒（含 Render 冷启动），请轮询。
- 临时存储：R2 结果 24h 自动删除，请及时下载。
- 不支持的格式（jxl/qoi 等）会明确报错，不会静默 fallback。

## 部署

- `worker/`：Cloudflare Worker（Hono）+ R2（`squoosh-tmp`）+ KV（`JOBS`）+ Queue（`squoosh-jobs`，`max_concurrency=20`）。
  必需 secret：`RENDER_URL`（`wrangler secret put RENDER_URL`）。
- `server/`：Render Web Service，Root Directory `server`，Build `npm install`，Start `npm start`，Health `/health`。
- 原有 `src/`、`codecs/` 未改动。

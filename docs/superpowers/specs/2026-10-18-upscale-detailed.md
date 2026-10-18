# Upscale（AI 超分）详细设计（可开工版）

Date: 2026-10-18. Base: `2026-10-18-upscale-design.md`（方向版）.
References: bg2x（MIT）`src/workers/super-resolution.worker.ts`（16KB）、
`src/config/models.ts`（10 模型，HF 主 + ModelScope 备）。

## 1. 移植对照表（browser → Node，一一对应，不重发明）

| bg2x（浏览器）                                                   | 我们（server/Node）                                                                                                                              | 说明                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `onnxruntime-web`, EP webgpu→wasm                                | `onnxruntime-node`, EP `cpu`                                                                                                                     | Node 无 WebGPU；线程数取 `os.cpus()`，Render 免费机实测后锁死（先设 1，再试 2）                                             |
| `InferenceSession.create(bytes, {graphOptimizationLevel:'all'})` | 同 API（node 版同名）                                                                                                                            | session 按 modelId 常驻内存复用，不来一张建一次                                                                             |
| RGBA→NCHW Float32，`×1/255`，边缘 replicate                      | 逐行照抄 `extractTile`                                                                                                                           | sharp 解码出 RGBA raw，再喂 tile 提取                                                                                       |
| TILE 256 / OVERLAP 16 / 羽化 `full+ramp`                         | 照抄 `buildBlendWeights`                                                                                                                         | 输出缝否则必有接缝                                                                                                          |
| 4x 模型出 2x（box-filter 下采样，整数比才用）                    | 照抄，可选 `targetScale` 参数                                                                                                                    | 省一半算量，MCP 默认推荐 2x                                                                                                 |
| 输出上限 16384px / 2亿像素                                       | 收紧到 8000px / 5000万像素                                                                                                                       | 保 Render；超了报错指本地版                                                                                                 |
| 模型放 IndexedDB                                                 | 放 Render 磁盘 `/tmp` + 启动预热？否：按需下载到磁盘缓存（Render 磁盘重启丢，丢了重下，可接受）                                                  | 权重 URL 照抄 bg2x 配置，注明来源                                                                                           |
| 单 tile 推理 300s 超时 + GPU 失败回退 CPU                        | 整单 600s 超时＋session 创建 60s 超时（照抄它的 whole-job 超时/`MODEL_LOAD_TIMEOUT` 模型；它没有单 tile 超时，只有 stall 检测），无 GPU 无需回退 | 超时即整张失败，item 记 error；进度只有 queued/processing/done 三态（server 无 tile 级 progress，文档写明，Agent 10s 一询） |

## 2. 模型注册表（server 内建，URL 抄 bg2x， dual-source）

远程白名单 4 个（小）：

- `general-x4v3`（4.9MB，4x，默认）、`anime-v3`（2.5MB，4x）、`cugan-2x`（5.2MB，2x）、`swin-light-x2`（8.1MB，2x）。
  本地全量 +6 个（含 `x4plus` 67MB 等）。model id 不在表 → 报错并列出可选，不 fallback。

## 3. server 实现（`server/src/upscale.js` 新文件，不动压缩代码）

- `POST /upscale {imageBase64, model, targetScale?}`：magic bytes 校验 → sharp 解码 RGBA →
  MP 预算检查（第 5 节标定前保守值：4x 模型输入 ≤2MP，2x 模型 ≤4MP）→ 分块推理 →
  PNG 编码回 base64（超分输出统一 PNG，避免二次有损；转格式走压缩链路）。
- `GET /upscale/models`：返回白名单 + 各自 scale + 体积。
- 模型懒加载 + 常驻：`Map<modelId, session>`，按需 `fetch` 权重（HF→ModelScope），写磁盘缓存。
- 并发：进程内互斥锁（一次只算一张，保 512MB 不爆）；超时的请求直接 503 让 Worker 进 DLQ/记 error。
- 新增依赖只有 `onnxruntime-node` 一个。**风险 R1 验证点**：它 native 体积大，
  Render 免费机 `npm install` 能否装上、装完是否超磁盘——第 1 步只验证这个，
  装不上后面全停。

## 4. Worker 集成（复用压缩链路，不另起存储）

- 新队列 `squoosh-upscale`（并发 1）+ DLQ；KV/R2 同一套，只是 R2 key 换 `upscale/{jobId}/` 前缀。
- `upscale_image {source|r2Key, model?, targetScale?, inline?, idempotencyKey?}`：
  model 缺省 `general-x4v3`；输入 ≤0.5MP 且要 inline → 同步秒回；否则排队。
  状态机、限流、幂等、绝对 URL 全部复用 `submitJob`（需小改：把"压缩"处理函数参数化为"超分"处理函数）。
- `smart_upscale {source}`：默认 `general-x4v3` 4x，一句话。
- `get_job_status` 输出项加 `model`、`scale` 字段；prompts 指引追加超分章节。
- 进度：tile 级进度 Worker 拿不到（Render 一次返回），状态只有 queued/processing/done，
  文档写明轮询 10s，不要让 Agent 1s 一问。

## 5. 实测标定矩阵（先跑再定数，不拍脑袋）

| 输入                    | 模型                | 记录耗时 | 记录内存峰值 | 结论         |
| ----------------------- | ------------------- | -------- | ------------ | ------------ |
| 0.5MP / 1MP / 2MP / 3MP | general-x4v3        | …        | …            | 定 4x 预算线 |
| 1MP / 2MP / 4MP         | swin-light-x2       | …        | …            | 定 2x 预算线 |
| 0.5MP                   | anime-v3 / cugan-2x | …        | …            | 确认能跑     |

标定输出写进 README-MCP（每模型"建议输入上限 + 预估耗时"），超限请求在 Worker 侧直接拒（带数据说话）。

## 6. 在线 /upscale（零风险，可并行）

- bg2x 独立 clone 构建（不动它源码），产物部署到同域 `/upscale`，顶导航双向互链，主题色对齐 Squoosh。
- 模型走 HF/ModelScope 直达用户浏览器 IndexedDB，我们零流量费、零存储。
- 与 MCP 共用同一套"模型白名单文案"，两边说法一致。

## 7. 本地 MCP（`mcp-local` 加 `upscale`）

- `upscale {path, model, output?, targetScale?}`，onnxruntime-node，全 10 模型，
  权重缓存 `~/.cache/squoosh-models`，无 MP 上限（超 5000 万像素只警告）。
- 这是 x4plus 等大模型的唯一出路，文档写明。

## 8. 验收标准

- server：4 白名单模型 × 标定矩阵全过，内存不超 450MB，单张可重现。
- Worker：`upscale_image` 同步/异步/幂等/报错（坏 model id、超限、坏图）各一例通过。
- 在线：`/upscale` 可打开、模型可下载、可出图；导航双向可达。
- 本地：x4plus 跑通一张真图。
- 文档：README-MCP 超分章节 + 实测数据表；smoke 加超分用例。

## 9. 开工顺序（防返工，已考虑依赖）

1. server 装包验证（R1，一天出结论）→ 2. 分块移植 + `/upscale`（最小模型）→
2. 实测矩阵定数 → 4. Worker 队列+工具（此时限额是实测值，一次写对）→
3. 在线嵌入（可与 1~4 并行）→ 6. 本地 upscale → 7. 文档+smoke+推送。

## 10. 执行优先级（P0→P7，严格按序；codegraph 已验证拷贝边界）

- **P0 上机验证（不动仓库逻辑）**：`server/` 内 `npm i onnxruntime-node`，
  从 HF 下最小模型（anime-v3 2.5MB）到本地，跑 1 个 tile。
  只回答 R1（装得上、跑得动）。失败则全停。
- **P1 原样拷贝（不重写算法）**：新建 `server/src/upscale/`，从 bg2x
  `src/workers/super-resolution.worker.ts` 逐行抄纯函数
  （`extractTile`/`buildBlendWeights`/`blendTile`/`downsampleTile`，codegraph 已确认零浏览器依赖），
  文件头保留 bg2x MIT 署名 + 仓库加 `NOTICE-bg2x.md`。
  只换两处边界：输入 `ImageData`→sharp RGBA raw（同形状薄包装），
  输出 `OffscreenCanvas`→raw buffer→sharp；`onnxruntime-web`→`onnxruntime-node`（同名 API）。
- **P2 server 端点**：`/upscale` + `/upscale/models`，复用现有 `gate` 鉴权和参数校验风格。
- **P3 上 Render + 标定**：push 即部署；跑第 5 节矩阵，数字落 README；定 MP 预算。
- **P4 Worker（等 P3 数字，一次写对）**：`submitJob` 处理函数参数化（一处改动同时服务压缩+超分，
  不复制第二套队列逻辑）；新队列 `squoosh-upscale`（并发 1）+DLQ；`upscale_image`/`smart_upscale`/prompts。
- **P5 在线 `/upscale`（与 P1~P4 无依赖，可并行）**：bg2x 独立构建挂载 + 导航。
- **P6 本地 `upscale`**：`mcp-local` 直接 `import` P1 的文件（同一仓库，零重复代码），全 10 模型。
- **P7 收尾**：smoke 超分用例 + README 数据表 + 推送。

**防返工要点**：分块算法只写一次（P1），Worker（P4）等实测数（P3），
本地版（P6）import 不复制；任何一步失败都不污染前面步骤的已验证成果。

# Upscale（AI 超分）完整设计

Date: 2026-10-18
Status: Design for approval. Builds on docs/superpowers/specs/2026-10-18-squoosh-mcp-cloudflare-design.md.

## 0. 核心决策（回应输入尺寸问题）

**不做输入缩放上限，改用分块推理。** bg2x 的 worker 已证明：256px tiles + 16px 羽化重叠，
任意大图都能算（它上限是输出 16384px / 2亿像素）。服务端照抄这套，画质零损失。
真正的限制是**时间**（免费机 CPU 慢），不是尺寸——所以用"分块 + 耗时预算"代替"尺寸一刀切"。

## 1. 模型白名单（复用 bg2x 配置，MIT）

模型 URL 照抄 `bg2x/src/config/models.ts`（HuggingFace 主 + ModelScope 备），注明来源。
不 fork 它仓库，只引用权重地址 + 自己实现推理（避免整站依赖）。

远程（Render 免费机，onnxruntime-node）：

| 模型                     | 大小  | 倍数 | 用途            |
| ------------------------ | ----- | ---- | --------------- |
| realesr-general-x4v3     | 4.9MB | 4x   | 默认通用        |
| real-esrgan-animevideov3 | 2.5MB | 4x   | 动漫/线稿       |
| real-cugan-2x            | 5.2MB | 2x   | 动漫/插画，快速 |
| swin2sr-lightweight-x2   | 8.1MB | 2x   | 照片，省算力    |

本地（mcp-local，本机算力）：以上 4 个 + 全部大模型（含 x4plus 67MB 等 6 个），无 MP 上限（只警告）。

不在白名单的 model id 直接报错 + 列出可选（不静默 fallback）。

## 2. 三端架构

```text
网页用户  → /upscale（bg2x 静态构建嵌入，模型进浏览器 IndexedDB，零服务端成本）
远程 Agent → upscale_image → Worker → 独立队列 squoosh-upscale → Render onnxruntime-node（分块）
本地 Agent → mcp-local upscale → 本机 onnxruntime-node（全模型）
```

独立队列原因：超分单张几分钟，和压缩混用一队会堵死压缩任务。新队列并发 1，配 DLQ。

## 3. 服务端分块推理（server 新增）

- 照搬 bg2x worker 算法：TILE 256 / OVERLAP 16 / 羽化融合；输出上限 8000px 单边、5000 万像素（保护 Render，超了报错建议本地版）。
- `/upscale {imageBase64, model, options}` + `/metadata` 复用。
- **先实测再定数**：0.5/1/2/3MP 输入 × 4 模型，记录耗时/内存，据此定各模型 MP 预算和单 job 超时（初定 10 分钟，轮询 10s）。不拍脑袋写死。
- onnxruntime-node 是 native 依赖，Render 构建会变慢变大，先验证能装上（风险点 #1）。

## 4. MCP 工具（复用现有 job/R2/轮询）

- `upscale_image {source|r2Key, model?, idempotencyKey?}` →
  小图（≤0.5MP）同步秒回（base64 可选 inline），大图排队。`sync` 字段告诉 Agent 有没有在排队。
- `smart_upscale {source}` → 默认 general-x4v3，一句话。
- `get_job_status` 共用（输出项加 `scale`、`model` 字段）。
- prompts 指引追加超分章节。

## 5. 在线 /upscale

- bg2x 独立构建，部署到同域 `/upscale`，顶导航互链 + 主题色对齐。不碰现有 Squoosh 页面和 MCP 代码。
- 模型走 HF/ModelScope 直达浏览器，我们不出流量费。

## 6. 实施顺序（防返工）

1. server：装 onnxruntime-node + 分块移植 + `/upscale`（最小模型先跑通，风险 #1 在此暴露）。
2. Render 实测矩阵 → 定 MP 预算/超时（数据写进 README）。
3. Worker：独立队列 + 消费者 + `upscale_image`/`smart_upscale` + prompts。
4. 在线 `/upscale` 嵌入 + 导航。
5. 本地 `upscale`（全模型）。
6. 文档 + smoke（超分单独用例）+ 推仓库。

## 7. 已知风险

- R1：onnxruntime-node 在 Render 免费机装不上/跑不动 → 降级只留本地版，远程不上。
- R2：免费 CPU 下 4x 大图单张超 10 分钟 → 缩小 MP 预算或只开 2x 模型。
- R3：模型 URL 是第三方（HF/ModelScope），挂了要切镜像——白名单里每模型保留双源。

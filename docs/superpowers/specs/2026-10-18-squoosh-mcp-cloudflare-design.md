# Squoosh MCP on Cloudflare Workers — Design

Date: 2026-10-18
Status: Phase 1-3 implemented (scaffold + upload + compress + status). Deployed: https://squoosh-mcp.suxiaoxinggz.workers.dev

## Intent & Why

Turn the existing Squoosh image-compression PWA into a **Cloudflare Worker-deployable service** that exposes both:

1. The original **online web app** (unchanged UI, served as static assets).
2. A **Model Context Protocol (MCP)** server so AI agents can compress images in batches, with parameters and export formats, and retrieve results via R2 URLs.

Incremental approach: **do not modify existing Squoosh source**. Add a new `worker/` (or `mcp/`) layer that reuses the same wasm codecs and option schemas.

## Goals

- Deploy everything (web app + MCP + processing) to Cloudflare Workers/Pages.
- Support single and batch image compression.
- Support input via base64, URL, and R2 key (flexible for local agent, VPS, cloud).
- Output as R2 signed URLs (temporary, auto-cleaned), never long-term storage.
- Queue-based async processing for unknown scale/concurrency.
- Per-job isolation (jobId + owner token) to avoid cross-user access.
- Reuse existing codec parameters (AVIF/JXL/MozJPEG/WebP/WP2/OxiPNG/QOI/etc.) without duplicating logic.

## Non-goals

- No rewrite of Squoosh UI or wasm codecs.
- No persistent image storage (R2 lifecycle auto-delete).
- No user accounts; auth via API token only.

## Constraints

- Cloudflare Workers CPU/time limits; wasm runs in single-threaded variant (no wasm threads in Worker runtime).
- MCP message size limits → prefer R2 URLs for large outputs.
- Free-tier friendly: use free Workers, Queues, R2, KV.

## Architecture

```
Cloudflare Worker (Hono)
├── Static assets: existing Squoosh PWA (unchanged)
├── /api/*        : compress, batch, job status, upload
├── /mcp          : HTTP MCP (SSE) endpoint
├── Queue consumer: process jobs (wasm)
├── R2 bucket     : temporary input/output (lifecycle 24h)
└── KV (or D1)    : job metadata (owner, status, items, expiry)
```

## MCP Tools

- `upload_image`: { source: base64|url, mime?, filename? } → { r2Key }
- `list_formats`: → { formats: [{ id, label, mime, ext, optionsSchema }] }
- `get_options_schema(format)`: → JSON schema for that encoder/processor
- `compress`: { source, format?, options? } → { jobId } (sync small images may return URL directly)
- `batch_compress`: { items: [{source, format?, options?}] } → { jobId }
- `get_job_status(jobId)`: → { status, progress, items: [{ status, url?, size?, mime? }] }
- `get_result(jobId, itemId?)`: → { url (signed), expiresAt }

## Data Flow

```
agent -> MCP compress/batch -> Worker creates jobId (owner=token) -> enqueue
Queue consumer -> wasm process -> write R2 jobs/{jobId}/out-*.ext
agent -> get_job_status(jobId) -> returns items + signed URLs
R2 lifecycle (24h) auto-deletes objects
```

## Security Isolation

- Every MCP/API request requires `Authorization: Bearer <token>`.
- Job record stores `ownerToken`; all reads/downloads check ownership.
- R2 keys include jobId; signed URLs bind jobId + expiry (default 1h).
- No global listing endpoints.

## Incremental Implementation Plan

Phase 1: Add `worker/` scaffold (Hono) + static asset binding + health check. (No source changes)
Phase 2: Implement `upload_image` + R2 temporary storage + signed URL helper.
Phase 3: Implement `compress` (single) using wasm (single-threaded) + `get_job_status`.
Phase 4: Implement `batch_compress` + Queue consumer + concurrency config.
Phase 5: Implement `list_formats` / `get_options_schema` from existing meta.
Phase 6: MCP endpoint (`/mcp`) wiring all tools.
Phase 7: Deploy config (wrangler.toml) + CI + free-tier resource provisioning.

## Compatibility with Existing Code

- Existing `src/`, `codecs/`, `lib/` remain untouched.
- Worker layer imports codec wasm as assets (built separately) or calls a Node-compatible build.
- Option schemas derived from `codecs/*/enc/*_enc.d.ts` and `src/features/*/shared/meta.ts` (read-only reference).

## Deployment (Cloudflare)

- Use Wrangler with free-tier resources:
  - Worker (or Pages) for compute + static assets
  - R2 bucket (free tier) for temp storage
  - Queue (free tier) for async jobs
  - KV (free tier) for job metadata
- Local dev: `wrangler dev` with local R2/KV emulation.

## Open Questions

- Should sync small images return base64 directly or always R2 URL? (Current decision: R2 URL default; optional `inline=true` for base64)
- Max inline size threshold?
- Queue concurrency default?

```

Then ask approval.<|end|><|start|><|start|>assistant<|channel|>final<|message|>设计文档已写好（草案）。请确认以下几点，确认后我再开始实现：

1. **同步小图**：默认返回 R2 URL，可选 `inline=true` 返回 base64（阈值建议 2MB）。可以吗？
2. **队列并发**：默认并发 4，可配。可以吗？
3. **R2 清理**：Lifecycle 24h + signed URL 1h。可以吗？
4. **开始实现**：先做 Phase 1–3（scaffold + upload + single compress + status），再加 batch/queue/MCP。可以吗？

确认后我就开始写代码（增量，不改现有 src）。>|tool_call_begin|><xml<|message|><rfl:parameter name="function">
write
```

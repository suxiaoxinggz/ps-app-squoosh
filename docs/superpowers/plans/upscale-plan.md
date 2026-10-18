# Upscale Implementation Plan

Spec (binding authority): `docs/superpowers/specs/2026-10-18-upscale-detailed.md`
Repo: `/Users/suxiaoxing/Desktop/app/competition/ps-app-squoosh`, branch `dev`.
Remote backend: `https://ps-app-squoosh.onrender.com` (Render free tier).
Staging worker: `squoosh-mcp-staging` (`wrangler deploy --env staging`).
Prod worker: `squoosh-mcp` (`wrangler deploy`).

## Global Constraints

- Incremental: never modify existing compress behavior, existing files keep working.
- Copy, don't rewrite: tiling math (`extractTile`, `buildBlendWeights`, `blendTile`,
  `downsampleTile`) copied verbatim from bg2x `src/workers/super-resolution.worker.ts`;
  each copied file carries a bg2x MIT attribution header; add repo `NOTICE-bg2x.md`.
- Only these 4 remote models: `general-x4v3` (default), `anime-v3`, `cugan-2x`, `swin-light-x2`.
  Unknown model id must error listing the 4, never silent fallback.
- Weight URLs copied from bg2x `src/config/models.ts` (HuggingFace primary, ModelScope fallback).
- Worker secret `RENDER_SECRET` already set (prod + staging); server gate is soft
  (enforced only when env var present). Never hardcode secrets.
- Prod deploy only after staging verification passes in the same task.
- Commit per task on branch `dev`; push to `origin dev` is pre-authorized by the user.
- Node ESM (`"type": "module"`); no `require()` in new code.
- Test evidence: every task reports exact commands + outputs.

## Task 1: P0 onnxruntime-node spike (no repo logic changes)

In `server/`: `npm install onnxruntime-node` (append to `server/package.json`
dependencies, caret range matchingSharp style `^`). Download model
`real-esrgan-animevideov3` (`https://huggingface.co/skillsafe-ai/realesr-animevideov3/resolve/main/model.onnx`,
~2.5MB) to a scratch path (NOT committed). With `onnxruntime-node`,
`InferenceSession.create` the bytes, build one NCHW Float32 256x256 tile
(values /255), run once, assert output tensor shape is 4x (1024x1024).
Report: install OK/fail, session-create ms, single-tile run ms, output shape.
Do NOT commit node_modules or model bytes. Commit only `server/package.json`
if the install works; if install fails, commit nothing and report BLOCKED.

## Task 2: Vendor tiling + server /upscale endpoints

Create `server/src/upscale/` with: `tiling.js` (verbatim pure functions from bg2x
worker + MIT header), `models.js` (4-model registry with HF+ModelScope URLs),
`session.js` (lazy `Map<modelId, session>`, disk cache under `./.model-cache/`,
60s session-create timeout), `infer.js` (sharp decode to RGBA raw → tiled
inference with whole-job timeout → PNG base64 out; input MP guard:
4x models ≤2MP, 2x models ≤4MP, over → clear error pointing at local edition).
Wire `POST /upscale {imageBase64, model, targetScale?}` and
`GET /upscale/models` in `server/src/index.js` reusing the existing `gate`.
Verify locally: 1x1 png through general-x4v3 returns PNG base64; unknown model
id returns 400 listing the 4. Commit.

## Task 3: Render deploy + calibration matrix

Push triggers Render auto-deploy of `server/`. Wait for deploy, then run the
calibration matrix against production Render: inputs 0.5/1/2MP × general-x4v3,
1/2MP × swin-light-x2, 0.5MP × anime-v3/cugan-2x; record wall ms + success.
Write results table into `README-MCP.md` upscale section and set final MP
budgets in `server/src/upscale/` if measurements demand different values
than Task 2 defaults. Commit docs (+ code if budgets changed).

## Task 4: Worker upscale queue + tools

`wrangler.toml`: new queue `squoosh-upscale` (max_concurrency 1, batch 1) +
DLQ `squoosh-upscale-dlq` (create both via `wrangler queues create` first).
Parameterize `submitJob` processing function so compress and upscale share
one path. Add MCP tools `upscale_image` and `smart_upscale`
(same reply shape as compress: `{jobId, sync, status}`, inline base64 for
sync ≤2MB), extend `get_job_status` items with `model`/`scale`, append
upscale chapter to the `batch_compress_guide` prompt text.
Deploy `--env staging`, verify sync+async+bad-model-id+over-limit cases,
then deploy prod. Commit.

## Task 5: Online /upscale embed

Clone bg2x (shallow) to scratch, build it unmodified, serve its static output
under the worker at path `/upscale` (same ASSETS mechanism as the existing
Squoosh build), add top-nav links both directions, align accent theme color.
Do not modify bg2x source. Verify on staging: page loads, model downloads,
one upscale completes. Then prod. Commit (build output committed like the
existing `build/` directory convention, or scripted — follow the repo's
existing convention).

## Task 6: Local mcp-local upscale

Add `upscale {path, model, output?, targetScale?}` to `mcp-local/src/server.js`
importing Task 2's `server/src/upscale/` modules (no copied fork).
Full 10-model registry for local use, weights cached at `~/.cache/squoosh-models`,
warn-only over 50MP. Verify with a real local PNG through general-x4v3.
Commit.

## Task 7: Docs + smoke + push

`README-MCP.md` upscale chapter (tools JSON, measured budget table from Task 3,
local vs remote guidance). Extend `worker/smoke.js` with one upscale case
(sync tiny image). Run full smoke on prod, push `dev`, report.

// Upscale jobs on the worker side.
//
// The heavy lifting lives on Render (ONNX), one tile per HTTP call to
// POST /upscale/tile so the 512MB free instance never holds more than one
// tile of native memory. This module:
//   - validates model / targetScale and plugs into the shared submitJob path,
//   - plans the tile grid (via /metadata) in a queue step,
//   - runs ONE tile per queue message (max_concurrency = 1),
//   - stitches the patches back into one PNG with the worker-side stitcher.
//
// Storage: same KV (squoosh-tmp) + R2 bucket, keys under `upscale/{jobId}/`.

import type { Env, JobItem, JobRecord, UpscaleTile } from './types';
import {
  base64ToBytes,
  bytesToBase64,
  log,
  renderPost,
  submitJob,
  type JobKindSpec,
} from './services';
import { TILE_STEP } from './tiling';
import { planTiles, stitchToPngBytes } from './upscale-stitch';
import {
  DEFAULT_UPSCALE_MODEL,
  UPSCALE_MODELS,
  findUpscaleModel,
  mpBudget,
  unknownModelMessage,
} from './upscale-models';

export { UPSCALE_MODELS };

/** Inputs this small (with inline:true) are stitched in the submit request. */
export const UPSCALE_SYNC_MP = 0.5;
/** Backend /metadata budget. */
const PLAN_TIMEOUT_MS = 30_000;
/**
 * Per-tile budget. Measured 13-24s/tile on the free Render instance (Task 3);
 * slow models (swin-light-x2) are slower, so stay generous.
 */
const TILE_TIMEOUT_MS = 180_000;
/**
 * The sync path has no queue to retry for it, and the free Render instance
 * does return sporadic 502s (restart / cold wake) between tiles, so a tile is
 * retried in-request. The queue path leaves retries to Cloudflare Queues.
 */
const SYNC_TILE_ATTEMPTS = 3;
const TILE_RETRY_DELAY_MS = 2_000;
export const MAX_OUTPUT_DIM = 8000;
/**
 * Hard ceiling on stitched output. The stitcher holds the whole RGBA canvas
 * plus the encoded PNG in the isolate (R2 `put` needs a known length), so the
 * queue path is capped well below the server's 50MP: at 8MP the canvas is 32MB
 * and the file ~10MB, leaving room for the patch decode inside the 128MB
 * isolate. That means 2x models top out at 2MP input here even though the
 * server accepts 4MP.
 */
export const MAX_OUTPUT_PIXELS = 8_000_000;

/**
 * Effective input budget for a model at output scale `ts`: the server's
 * per-model MP budget, further capped by the stitcher's output ceiling.
 * 4x full scale -> 0.5MP, 2x full scale -> 2MP, 4x at targetScale 2 -> 2MP.
 * Single source of truth for the plan check and the prompt guide text.
 */
export function inputMpLimit(scale: number, ts: number = scale): number {
  return Math.min(mpBudget(scale), MAX_OUTPUT_PIXELS / (ts * ts) / 1e6);
}

function putRecord(env: Env, jobId: string, rec: JobRecord): Promise<void> {
  return env.JOBS.put(jobId, JSON.stringify(rec), { expirationTtl: 86400 });
}

/**
 * An error retrying cannot fix (bad input, over budget, unreadable image):
 * the queue marks the job failed immediately instead of burning retries.
 */
export class PermanentUpscaleError extends Error {}

export function isPermanentUpscaleError(e: unknown): boolean {
  return e instanceof PermanentUpscaleError;
}

async function readInput(env: Env, item: JobItem): Promise<Uint8Array> {
  const obj = await env.BUCKET.get(item.inputKey);
  if (!obj) {
    throw new Error(
      `input missing for ${item.id}. Re-upload via upload_image.`,
    );
  }
  return new Uint8Array(await obj.arrayBuffer());
}

/**
 * Resolve dimensions + budget + tile grid for one item. Throws on any invalid
 * input (unknown model, over budget, unreachable backend).
 */
export async function planUpscaleItem(env: Env, item: JobItem): Promise<void> {
  const m = findUpscaleModel(item.model);
  if (!m) throw new PermanentUpscaleError(unknownModelMessage(item.model));
  const bytes = await readInput(env, item);
  const meta = await renderPost(
    env,
    '/metadata',
    { imageBase64: bytesToBase64(bytes) },
    PLAN_TIMEOUT_MS,
  );
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new PermanentUpscaleError(
      'could not read image dimensions from the backend.',
    );
  }
  const mp = (width * height) / 1e6;
  const ts = item.targetScale ?? m.scale;
  // Report the limit the worker actually enforces (output ceiling included),
  // not the looser server-side per-model budget: the guide text quotes it too.
  const maxInputMp = inputMpLimit(m.scale, ts);
  if (mp > maxInputMp) {
    const scaleNote =
      ts === m.scale
        ? `${m.scale}x model`
        : `${m.scale}x model at targetScale ${ts}`;
    throw new PermanentUpscaleError(
      `input too large (${mp.toFixed(2)}MP). The ${MAX_OUTPUT_DIM}px / ${MAX_OUTPUT_PIXELS / 1e6}MP stitched-output cap allows <=${maxInputMp}MP input for a ${scaleNote}. Resize first, or use the local edition for large images.`,
    );
  }
  const destW = width * ts;
  const destH = height * ts;
  if (destW > MAX_OUTPUT_DIM || destH > MAX_OUTPUT_DIM) {
    throw new PermanentUpscaleError(
      `output ${destW}x${destH} exceeds the ${MAX_OUTPUT_DIM}px limit. Use a smaller image or targetScale.`,
    );
  }
  if (destW * destH > MAX_OUTPUT_PIXELS) {
    // Backstop: inputMpLimit already keeps this under the cap.
    throw new PermanentUpscaleError(
      `output too large (${(destW * destH) / 1e6}MP, max ${MAX_OUTPUT_PIXELS / 1e6}MP). Use a smaller image or targetScale.`,
    );
  }
  const plan = planTiles(width, height);
  item.width = width;
  item.height = height;
  item.mp = mp;
  item.scale = m.scale;
  item.targetScale = ts;
  item.tilesX = plan.tilesX;
  item.tilesY = plan.tilesY;
  item.tiles = plan.tiles.map((t) => ({
    tx: t.tx,
    ty: t.ty,
    status: 'queued' as const,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Call POST /upscale/tile with bounded in-request retries. The sync path uses
 * this (it has no queue to retry for it); the queue path passes attempts=1 and
 * relies on Cloudflare Queues.
 */
async function renderTile(
  env: Env,
  jobId: string,
  tile: UpscaleTile,
  body: any,
  attempts: number,
): Promise<any> {
  let lastErr: any;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await renderPost(env, '/upscale/tile', body, TILE_TIMEOUT_MS);
    } catch (e: any) {
      lastErr = e;
      if (a < attempts) {
        log('upscale.tile.retry', {
          jobId,
          tx: tile.tx,
          ty: tile.ty,
          attempt: a,
          attempts,
          error: e?.message || String(e),
        });
        await sleep(TILE_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

/** ONE tile: ask Render for the patch, park it in R2. */
export async function processUpscaleTile(
  env: Env,
  jobId: string,
  item: JobItem,
  tile: UpscaleTile,
  attempts = 1,
): Promise<void> {
  const bytes = await readInput(env, item);
  const data = await renderTile(
    env,
    jobId,
    tile,
    {
      imageBase64: bytesToBase64(bytes),
      model: item.model,
      x0: tile.tx * TILE_STEP,
      y0: tile.ty * TILE_STEP,
    },
    attempts,
  );
  if (!data?.base64)
    throw new Error(`backend returned no patch for ${tile.tx},${tile.ty}.`);
  const patch = base64ToBytes(data.base64);
  const patchKey = `upscale/${jobId}/tiles/${tile.tx}-${tile.ty}.png`;
  await env.BUCKET.put(patchKey, patch, {
    httpMetadata: { contentType: data.mime || 'image/png' },
  });
  tile.patchKey = patchKey;
  tile.ow = data.ow;
  tile.oh = data.oh;
  tile.size = patch.length;
  tile.status = 'done';
}

/** Blend every patch into the final PNG (streamed into R2) and clean up. */
export async function finalizeUpscaleItem(
  env: Env,
  jobId: string,
  item: JobItem,
): Promise<void> {
  const tiles = item.tiles || [];
  const missing = tiles.filter((t) => t.status !== 'done' || !t.patchKey);
  if (!tiles.length || missing.length) {
    throw new Error(
      `cannot stitch: ${missing.length}/${tiles.length} tile(s) missing.`,
    );
  }
  const scale = item.scale as number;
  const ts = item.targetScale ?? scale;
  const { bytes, width, height } = await stitchToPngBytes({
    width: item.width as number,
    height: item.height as number,
    scale,
    targetScale: ts,
    readPatch: async (tx, ty) => {
      const t = tiles.find((x) => x.tx === tx && x.ty === ty);
      if (!t?.patchKey) throw new Error(`missing patch ${tx},${ty}.`);
      const obj = await env.BUCKET.get(t.patchKey);
      if (!obj) throw new Error(`missing patch object ${t.patchKey}.`);
      return new Uint8Array(await obj.arrayBuffer());
    },
  });
  const outKey = `upscale/${jobId}/output.png`;
  const uploaded = await env.BUCKET.put(outKey, bytes, {
    httpMetadata: { contentType: 'image/png' },
  });
  item.outputKey = outKey;
  item.size = (uploaded as R2Object | null)?.size ?? bytes.length;
  item.mime = 'image/png';
  item.status = 'done';
  log('upscale.stitch', {
    jobId,
    outW: width,
    outH: height,
    tiles: tiles.length,
  });
  await Promise.all(
    tiles.map((t) => (t.patchKey ? env.BUCKET.delete(t.patchKey) : null)),
  );
}

/**
 * Synchronous processor (fast path only): plan + all tiles + stitch inside the
 * submit request. Only reached for inline single images <= UPSCALE_SYNC_MP.
 */
export async function processUpscaleItems(
  env: Env,
  jobId: string,
  items: JobItem[],
): Promise<void> {
  for (const item of items) {
    try {
      if (!item.tiles) await planUpscaleItem(env, item);
      for (const t of item.tiles || []) {
        if (t.status !== 'done') {
          await processUpscaleTile(env, jobId, item, t, SYNC_TILE_ATTEMPTS);
        }
      }
      await finalizeUpscaleItem(env, jobId, item);
    } catch (e: any) {
      item.status = 'error';
      item.error = e?.message || 'upscale failed';
      log('upscale.sync.failed', {
        jobId,
        error: item.error,
        tiles: (item.tiles || [])
          .map((t) => `${t.tx},${t.ty}:${t.status}`)
          .join(' '),
      });
    }
  }
}

/** Fan the job out: tile messages when planned, otherwise one plan message. */
export async function enqueueUpscale(
  env: Env,
  jobId: string,
  _token: string,
  record: JobRecord,
): Promise<void> {
  const item = record.items?.[0];
  const queued = (item?.tiles || []).filter((t) => t.status === 'queued');
  if (queued.length) {
    const messages = queued.map((t) => ({
      body: { kind: 'upscale', phase: 'tile', jobId, tx: t.tx, ty: t.ty },
    }));
    for (let i = 0; i < messages.length; i += 100) {
      await env.UPSCALE_QUEUE.sendBatch(messages.slice(i, i + 100));
    }
    return;
  }
  await env.UPSCALE_QUEUE.send({ kind: 'upscale', phase: 'plan', jobId });
}

export const UPSCALE_KIND: JobKindSpec = {
  name: 'upscale',
  maxItems: 1,
  normalize(it: any) {
    const model = it.model || DEFAULT_UPSCALE_MODEL;
    const m = findUpscaleModel(model);
    if (!m) throw new Error(unknownModelMessage(it.model ?? model));
    let targetScale: number | undefined;
    if (it.targetScale != null) {
      const ts = Number(it.targetScale);
      if (!Number.isInteger(ts) || ts < 1) {
        throw new Error('targetScale must be a positive integer.');
      }
      if (ts > m.scale) {
        throw new Error(
          `targetScale ${ts} exceeds the ${m.scale}x scale of model "${model}". Use a 4x model or a smaller targetScale.`,
        );
      }
      if (m.scale % ts !== 0) {
        throw new Error(
          `targetScale ${ts} must evenly divide the model scale ${m.scale} (e.g. 2 for a 4x model).`,
        );
      }
      targetScale = ts;
    }
    return { model, scale: m.scale, targetScale };
  },
  async plan(env, _jobId, items) {
    await planUpscaleItem(env, items[0]);
  },
  syncEligible(env, items, _totalBytes, opts) {
    if (!opts.inline || items.length !== 1 || !env.RENDER_URL) return false;
    const mp = items[0].mp;
    return Number.isFinite(mp) && (mp as number) <= UPSCALE_SYNC_MP;
  },
  processSync: processUpscaleItems,
  enqueue: enqueueUpscale,
  itemLimitHint: 'Upscaling accepts one image per job.',
};

/** MCP tool entry point for upscale_image / smart_upscale. */
export async function submitUpscaleJob(
  env: Env,
  token: string,
  args: {
    source?: any;
    r2Key?: string;
    model?: string;
    targetScale?: number;
    inline?: boolean;
    idempotencyKey?: string;
  },
) {
  const items = [
    {
      source: args.source,
      r2Key: args.r2Key,
      model: args.model || DEFAULT_UPSCALE_MODEL,
      targetScale: args.targetScale,
    },
  ];
  return submitJob(env, token, items, {
    inline: args.inline === true,
    idempotencyKey: args.idempotencyKey,
    kind: UPSCALE_KIND,
  });
}

/** Persist a terminal error for a job whose queue message exhausted retries. */
export async function markUpscaleFailed(
  env: Env,
  jobId: string,
  message: string,
): Promise<void> {
  const raw = await env.JOBS.get(jobId);
  if (!raw) return;
  const rec = JSON.parse(raw) as JobRecord;
  rec.status = 'error';
  for (const item of rec.items || []) {
    if (item.status !== 'done') {
      item.status = 'error';
      item.error = item.error || message;
    }
    for (const t of item.tiles || []) {
      if (t.status === 'queued') t.error = message;
    }
  }
  await putRecord(env, jobId, rec);
}

/**
 * One queue message:
 *   phase "plan" -> resolve the grid, then fan out one message per tile
 *   phase "tile" -> run exactly that tile, stitch when it was the last one
 */
export async function handleUpscaleQueueMessage(
  env: Env,
  msg: { body: any },
): Promise<void> {
  const { jobId, phase, tx, ty } = msg.body || {};
  if (!jobId) return;
  const raw = await env.JOBS.get(jobId);
  if (!raw) {
    log('upscale.msg.expired', { jobId, phase });
    return;
  }
  const rec = JSON.parse(raw) as JobRecord;
  const item = rec.items?.[0];
  if (!item) return;
  if (item.status === 'done' || item.status === 'error') {
    // Already finalised (duplicate delivery): keep the record consistent.
    rec.status = item.status;
    await putRecord(env, jobId, rec);
    return;
  }

  if (phase === 'plan') {
    if (!item.tiles) await planUpscaleItem(env, item);
    rec.status = 'processing';
    await putRecord(env, jobId, rec);
    await enqueueUpscale(env, jobId, rec.owner, rec);
    log('upscale.plan', {
      jobId,
      tiles: item.tiles?.length || 0,
      width: item.width,
      height: item.height,
    });
    return;
  }

  const tile = (item.tiles || []).find((t) => t.tx === tx && t.ty === ty);
  if (!tile) return;
  if (tile.status !== 'done') await processUpscaleTile(env, jobId, item, tile);
  const tiles = item.tiles || [];
  const done = tiles.filter((t) => t.status === 'done').length;
  if (done === tiles.length) {
    await finalizeUpscaleItem(env, jobId, item);
    rec.status = item.status === 'done' ? 'done' : 'error';
  } else {
    rec.status = 'processing';
  }
  await putRecord(env, jobId, rec);
  log('upscale.tile', {
    jobId,
    tx,
    ty,
    done,
    total: tiles.length,
    status: rec.status,
  });
}

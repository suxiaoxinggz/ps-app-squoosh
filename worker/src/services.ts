import type { Env, JobRecord, JobItem, JobKindName } from './types';

export function ownerTokenFromAuth(auth?: string | null): string {
  return (auth || '').replace(/^Bearer\s+/i, '').trim() || 'anon';
}

export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ event, t: new Date().toISOString(), ...fields }),
  );
}

// ---------- constants ----------
export const MAX_ITEMS_PER_JOB = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const SYNC_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_DIMENSION = 4000;

export const SUPPORTED_FORMATS = ['jpeg', 'png', 'webp', 'avif'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

export function assertSupportedFormat(
  format: string,
): asserts format is SupportedFormat {
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      `unsupported format "${format}". Supported formats: ${SUPPORTED_FORMATS.join(', ')}. Call list_formats to see mime types and extensions.`,
    );
  }
}

export function listFormats() {
  return [
    {
      id: 'jpeg',
      label: 'JPEG',
      mime: 'image/jpeg',
      ext: 'jpg',
      engine: 'sharp',
    },
    { id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', engine: 'sharp' },
    {
      id: 'webp',
      label: 'WebP',
      mime: 'image/webp',
      ext: 'webp',
      engine: 'sharp',
    },
    {
      id: 'avif',
      label: 'AVIF',
      mime: 'image/avif',
      ext: 'avif',
      engine: 'sharp',
    },
  ];
}

export const OPTION_SCHEMAS: Record<string, any> = {
  jpeg: {
    quality: { type: 'number', min: 1, max: 100, default: 80 },
    width: { type: 'number', max: MAX_DIMENSION },
    height: { type: 'number', max: MAX_DIMENSION },
  },
  png: {
    width: { type: 'number', max: MAX_DIMENSION },
    height: { type: 'number', max: MAX_DIMENSION },
  },
  webp: {
    quality: { type: 'number', min: 1, max: 100, default: 80 },
    width: { type: 'number', max: MAX_DIMENSION },
    height: { type: 'number', max: MAX_DIMENSION },
    lossless: { type: 'boolean', default: false },
  },
  avif: {
    quality: { type: 'number', min: 1, max: 100, default: 80 },
    width: { type: 'number', max: MAX_DIMENSION },
    height: { type: 'number', max: MAX_DIMENSION },
  },
};

export function getOptionSchema(format: string) {
  return OPTION_SCHEMAS[format] || null;
}

/** Clamp user options into safe ranges before sending to the engine. */
export function clampOptions(format: string, options: any = {}): any {
  const q = options.quality;
  const out: any = {};
  if (format === 'jpeg' || format === 'webp' || format === 'avif') {
    const n = Number(q);
    out.quality = Number.isFinite(n)
      ? Math.min(100, Math.max(1, Math.round(n)))
      : 80;
  }
  for (const k of ['width', 'height'] as const) {
    const n = Number(options[k]);
    if (Number.isFinite(n) && n > 0)
      out[k] = Math.min(MAX_DIMENSION, Math.round(n));
  }
  if (format === 'webp' && options.lossless) out.lossless = true;
  return out;
}

// ---------- helpers ----------
/** Chunked bytes->base64 to avoid stack blowup on large images. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Minimal magic-byte sniffing. Returns mime or null. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return 'image/gif';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1')
      return 'image/heic';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

function checkImageSize(bytes: Uint8Array) {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (${bytes.length} bytes, max ${MAX_IMAGE_BYTES}). Resize before upload, or use a smaller variant.`,
    );
  }
}

function assertIsImage(bytes: Uint8Array, where: string) {
  if (!sniffImageMime(bytes)) {
    throw new Error(
      `not an image (${where}). Supported inputs: JPEG, PNG, GIF, WebP, AVIF, HEIC, BMP.`,
    );
  }
}

export async function readSource(env: Env, source: any) {
  if (source?.type === 'base64') {
    if (typeof source.value !== 'string' || !source.value.length) {
      throw new Error('base64 source needs a non-empty "value" string.');
    }
    const bytes = base64ToBytes(source.value);
    checkImageSize(bytes);
    assertIsImage(bytes, 'base64 input');
    return {
      bytes,
      mime: sniffImageMime(bytes) || source.mime,
      name: source.filename,
    };
  }
  if (source?.type === 'url') {
    const u = String(source.value || '');
    if (!/^https?:\/\//i.test(u)) {
      throw new Error('url source must be an http(s) URL.');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok)
        throw new Error(
          `fetch failed with status ${res.status}. Check the URL is public.`,
        );
      const len = res.headers.get('content-length');
      if (len && Number(len) > MAX_IMAGE_BYTES) {
        throw new Error(
          `remote image too large (${len} bytes, max ${MAX_IMAGE_BYTES}).`,
        );
      }
      // Bounded stream read: abort as soon as we exceed the cap, even without content-length.
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_IMAGE_BYTES) {
          ctrl.abort();
          throw new Error(
            `remote image too large (>${MAX_IMAGE_BYTES} bytes).`,
          );
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.length;
      }
      checkImageSize(bytes);
      assertIsImage(bytes, 'url input');
      return {
        bytes,
        mime:
          sniffImageMime(bytes) || res.headers.get('content-type') || undefined,
        name: source.filename,
      };
    } catch (e: any) {
      if (e?.name === 'AbortError')
        throw new Error(
          'fetch timed out after 8s. Use a faster host or upload base64.',
        );
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  if (source?.type === 'r2') {
    const obj = await env.BUCKET.get(source.value);
    if (!obj) {
      throw new Error(
        'r2 object not found. Upload first via upload_image, or check the r2Key.',
      );
    }
    const buf = await obj.arrayBuffer();
    const bytes = new Uint8Array(buf);
    checkImageSize(bytes);
    assertIsImage(bytes, 'r2 input');
    return {
      bytes,
      mime: obj.httpMetadata?.contentType,
      name: source.filename,
    };
  }
  throw new Error(
    'invalid source. Use {type:"base64", value:"..."} for small local images, {type:"url", value:"https://..."} for public URLs, or {type:"r2", value:"<r2Key>"} after upload_image.',
  );
}

/** Simple per-token rate limit using KV. Returns null if ok, else retry-after seconds. */
export async function checkRateLimit(
  env: Env,
  token: string,
  limit = 20,
  windowSec = 60,
): Promise<number | null> {
  const key = `ratelimit:${token}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const cur = parseInt((await env.JOBS.get(key)) || '0', 10);
  if (cur >= limit) return windowSec;
  await env.JOBS.put(key, String(cur + 1), { expirationTtl: windowSec });
  return null;
}

function renderHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.RENDER_SECRET) h['X-Render-Secret'] = env.RENDER_SECRET;
  return h;
}

/**
 * POST JSON to the Render backend. `timeoutMs` is optional: compress calls pass
 * nothing (unchanged behaviour), upscale tile calls pass a bound so a hung
 * backend does not pin a queue consumer.
 */
export async function renderPost(
  env: Env,
  path: string,
  body: any,
  timeoutMs?: number,
): Promise<any> {
  if (!env.RENDER_URL) throw new Error('compression backend not configured.');
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(`${env.RENDER_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: renderHeaders(env),
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(
        `backend timed out after ${Math.round((timeoutMs || 0) / 1000)}s.`,
      );
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j: any = await res.json();
      detail = `: ${j?.error || ''}`;
    } catch {
      try {
        detail = `: ${await res.text()}`;
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      `compression backend failed (${res.status})${detail.slice(0, 200)}`,
    );
  }
  return res.json();
}

/** Process already-stored inputs via Render. Shared by sync path and queue consumer. */
export async function processStoredItems(
  env: Env,
  jobId: string,
  items: JobItem[],
): Promise<void> {
  for (const item of items) {
    const obj = await env.BUCKET.get(item.inputKey);
    if (!obj) {
      item.status = 'error';
      item.error = `input missing for ${item.id}. Re-upload via upload_image.`;
      continue;
    }
    const buf = await obj.arrayBuffer();
    const bytes = new Uint8Array(buf);
    try {
      const data = (await renderPost(env, '/compress', {
        imageBase64: bytesToBase64(bytes),
        format: item.format || 'jpeg',
        options: item.options || {},
      })) as any;
      const outBuf = base64ToBytes(data.base64);
      const outKey = `jobs/${jobId}/${item.id}-out.${data.ext || 'jpg'}`;
      await env.BUCKET.put(outKey, outBuf, {
        httpMetadata: { contentType: data.mime },
      });
      item.outputKey = outKey;
      item.status = 'done';
      item.size = outBuf.length;
      item.mime = data.mime;
    } catch (e: any) {
      item.status = 'error';
      item.error = e?.message || 'processing failed';
    }
  }
}

export async function getImageInfo(
  env: Env,
  source: any,
): Promise<{
  size: number;
  mime: string;
  width?: number;
  height?: number;
  format?: string;
}> {
  const { bytes, mime } = await readSource(env, source);
  const info: any = { size: bytes.length, mime: mime || 'unknown' };
  if (env.RENDER_URL) {
    try {
      const meta = (await renderPost(env, '/metadata', {
        imageBase64: bytesToBase64(bytes),
      })) as any;
      info.width = meta.width;
      info.height = meta.height;
      info.format = meta.format;
      if (meta.format) info.mime = info.mime;
    } catch {
      /* metadata is best-effort */
    }
  }
  return info;
}

interface SubmitOpts {
  inline?: boolean;
  idempotencyKey?: string;
  /** Job kind handler; defaults to compression. */
  kind?: JobKindSpec;
}

/**
 * A job kind plugs into the shared submit/queue skeleton. Compression and
 * upscaling differ only in input validation, the per-item processing function,
 * the fast-path gate, and which queue the job goes out on.
 */
export interface JobKindSpec {
  name: JobKindName;
  /** Max items in one job. */
  maxItems: number;
  /** Validate + normalise one input entry. Throws on bad input. */
  normalize(it: any, i: number): Partial<JobItem>;
  /** Process stored inputs synchronously (fast path). */
  processSync(env: Env, jobId: string, items: JobItem[]): Promise<void>;
  /** Extra gate for the single-item fast path (size/MP/backend checks). */
  syncEligible(
    env: Env,
    items: JobItem[],
    totalBytes: number,
    opts: { inline: boolean },
  ): boolean;
  /** Per-kind work done before the sync decision (upscale: tile plan). */
  plan?(env: Env, jobId: string, items: JobItem[]): Promise<void>;
  /** Enqueue the job, fanning out shards when the kind needs it. */
  enqueue(
    env: Env,
    jobId: string,
    token: string,
    record: JobRecord,
  ): Promise<void>;
  /** Hint appended to the "too many items" error. */
  itemLimitHint: string;
}

/** Compression: unchanged behaviour, now expressed as a JobKindSpec. */
export const COMPRESS_KIND: JobKindSpec = {
  name: 'compress',
  maxItems: MAX_ITEMS_PER_JOB,
  normalize(it: any) {
    const format = it.format || 'jpeg';
    assertSupportedFormat(format);
    return { format, options: clampOptions(format, it.options) };
  },
  processSync: processStoredItems,
  syncEligible(env, items, totalBytes) {
    return (
      items.length === 1 && totalBytes <= SYNC_MAX_BYTES && !!env.RENDER_URL
    );
  },
  async enqueue(env, jobId, token, record) {
    await env.QUEUE.send({ kind: 'compress', jobId, token, record });
  },
  itemLimitHint: 'Split into multiple batch_compress calls.',
};

/**
 * Unified submit: small single image -> processed synchronously (fast path);
 * everything else -> queued. Returns {jobId, sync, inlineBase64?}.
 */
export async function submitJob(
  env: Env,
  token: string,
  itemsInput: any[],
  opts: SubmitOpts = {},
): Promise<{
  jobId: string;
  sync: boolean;
  inlineBase64?: string;
  inlineMime?: string;
}> {
  const kind = opts.kind || COMPRESS_KIND;
  if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
    throw new Error(
      'items must be a non-empty array of {source|r2Key, format?, options?}.',
    );
  }
  if (itemsInput.length > kind.maxItems) {
    throw new Error(
      `too many items (${itemsInput.length}, max ${kind.maxItems}). ${kind.itemLimitHint}`,
    );
  }
  if (opts.idempotencyKey) {
    const ik = `idem:${token}:${opts.idempotencyKey}`;
    const existing = await env.JOBS.get(ik);
    if (existing) return { jobId: existing, sync: false };
  }
  const jobId = crypto.randomUUID();
  const items: JobItem[] = [];
  let totalBytes = 0;
  for (let i = 0; i < itemsInput.length; i++) {
    const it = itemsInput[i];
    const norm = kind.normalize(it, i);
    let inputKey: string;
    let inputBytes = 0;
    if (it.r2Key) {
      inputKey = it.r2Key;
      const obj = await env.BUCKET.get(inputKey);
      if (!obj)
        throw new Error(
          `r2 object not found for item ${i}. Upload first via upload_image.`,
        );
      const buf = await obj.arrayBuffer();
      const bytes = new Uint8Array(buf);
      checkImageSize(bytes);
      assertIsImage(bytes, `r2 input (item ${i})`);
      inputBytes = bytes.length;
    } else {
      if (!it.source) throw new Error(`item ${i} needs source or r2Key.`);
      const src = await readSource(env, it.source);
      inputBytes = src.bytes.length;
      inputKey = `jobs/${jobId}/input-${i}-${src.name || 'image'}`;
      await env.BUCKET.put(inputKey, src.bytes, {
        httpMetadata: { contentType: src.mime },
      });
    }
    totalBytes += inputBytes;
    items.push({
      id: `item-${i}`,
      status: 'queued',
      inputKey,
      ...norm,
    });
  }

  // Per-kind pre-decision work: upscale plans tiles inline only when the caller
  // asked for inline bytes, so a cold backend never delays a queued submit.
  if (opts.inline === true && kind.plan) {
    try {
      await kind.plan(env, jobId, items);
    } catch (e: any) {
      log('job.plan.skip', { jobId, error: e?.message || String(e) });
    }
  }

  const wantInline = opts.inline === true;
  const fastPath = kind.syncEligible(env, items, totalBytes, {
    inline: wantInline,
  });
  if (fastPath) {
    await kind.processSync(env, jobId, items);
    const record: JobRecord = {
      id: jobId,
      owner: token,
      status: items.every((x) => x.status === 'done') ? 'done' : 'error',
      kind: kind.name,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
      items,
      inline: wantInline,
    };
    await env.JOBS.put(jobId, JSON.stringify(record), { expirationTtl: 86400 });
    let inlineBase64: string | undefined;
    let inlineMime: string | undefined;
    if (wantInline && items[0].status === 'done' && items[0].outputKey) {
      const out = await env.BUCKET.get(items[0].outputKey);
      if (out) {
        const buf = await out.arrayBuffer();
        if (buf.byteLength <= SYNC_MAX_BYTES) {
          inlineBase64 = bytesToBase64(new Uint8Array(buf));
          inlineMime = items[0].mime;
        }
      }
    }
    if (opts.idempotencyKey) {
      await env.JOBS.put(`idem:${token}:${opts.idempotencyKey}`, jobId, {
        expirationTtl: 86400,
      });
    }
    log('job.submit', {
      jobId,
      kind: kind.name,
      items: items.length,
      sync: true,
    });
    return { jobId, sync: true, inlineBase64, inlineMime };
  }

  const record: JobRecord = {
    id: jobId,
    owner: token,
    status: 'queued',
    kind: kind.name,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    items,
    inline: wantInline,
  };
  await env.JOBS.put(jobId, JSON.stringify(record), { expirationTtl: 86400 });
  await kind.enqueue(env, jobId, token, record);
  if (opts.idempotencyKey) {
    await env.JOBS.put(`idem:${token}:${opts.idempotencyKey}`, jobId, {
      expirationTtl: 86400,
    });
  }
  log('job.submit', {
    jobId,
    kind: kind.name,
    items: items.length,
    sync: false,
  });
  return { jobId, sync: false };
}

/** Absolute download URL for a finished item. */
export function itemDownloadUrl(
  origin: string,
  jobId: string,
  outputKey: string,
  token: string,
): string {
  const name = outputKey.split('/').pop();
  return `${origin.replace(/\/$/, '')}/files/${jobId}/${name}?token=${encodeURIComponent(token)}`;
}

export function jobItemsForClient(rec: any, token: string, origin: string) {
  return rec.items.map((it: any) => ({
    id: it.id,
    status: it.status,
    size: it.size,
    mime: it.mime,
    error: it.error,
    // Upscale-only metadata (omitted for compress items).
    ...(it.model ? { model: it.model } : {}),
    ...(it.scale
      ? {
          scale: it.targetScale ?? it.scale,
          modelScale: it.scale,
          ...(it.width && it.height
            ? { inputWidth: it.width, inputHeight: it.height }
            : {}),
        }
      : {}),
    url:
      it.outputKey && it.status === 'done'
        ? itemDownloadUrl(origin, rec.id, it.outputKey, token)
        : undefined,
  }));
}

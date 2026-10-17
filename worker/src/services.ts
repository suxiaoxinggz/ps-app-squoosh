import type { Env, JobRecord, JobItem } from './types';

export function ownerTokenFromAuth(auth?: string | null): string {
  return (auth || '').replace(/^Bearer\s+/i, '').trim() || 'anon';
}

export async function readSource(env: Env, source: any) {
  if (source?.type === 'base64') {
    const b64 = source.value.replace(/^data:[^;]+;base64,/, '');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: source.mime, name: source.filename };
  }
  if (source?.type === 'url') {
    const res = await fetch(source.value);
    if (!res.ok) throw new Error(`fetch failed ${res.status}`);
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mime: res.headers.get('content-type') || undefined,
      name: source.filename,
    };
  }
  if (source?.type === 'r2') {
    const obj = await env.BUCKET.get(source.value);
    if (!obj)
      throw new Error(
        'r2 object not found. Upload first via upload_image, or check the r2Key.',
      );
    const buf = await obj.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mime: obj.httpMetadata?.contentType,
      name: source.filename,
    };
  }
  throw new Error(
    'invalid source. Use {type:"base64", value:"..."} for small local images, {type:"url", value:"https://..."} for public URLs, or {type:"r2", value:"<r2Key>"} after upload_image.',
  );
}

export const MAX_ITEMS_PER_JOB = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function checkImageSize(bytes: Uint8Array) {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (${bytes.length} bytes, max ${MAX_IMAGE_BYTES}). Resize before upload, or use an R2 key + smaller variant.`,
    );
  }
}

/** Async path: store inputs, enqueue for the queue consumer. Returns jobId. */
export async function createQueuedJob(
  env: Env,
  token: string,
  itemsInput: any[],
  inline: boolean,
) {
  if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
    throw new Error(
      'items must be a non-empty array of {source| r2Key, format?, options?}.',
    );
  }
  if (itemsInput.length > MAX_ITEMS_PER_JOB) {
    throw new Error(
      `too many items (${itemsInput.length}, max ${MAX_ITEMS_PER_JOB}). Split into multiple batch_compress calls.`,
    );
  }
  const jobId = crypto.randomUUID();
  const items: JobItem[] = [];
  for (let i = 0; i < itemsInput.length; i++) {
    const it = itemsInput[i];
    const format = it.format || 'jpeg';
    assertSupportedFormat(format);
    let inputKey: string;
    if (it.r2Key) {
      inputKey = it.r2Key;
      const obj = await env.BUCKET.get(inputKey);
      if (!obj)
        throw new Error(
          `r2 object not found for item ${i}. Upload first via upload_image.`,
        );
    } else {
      if (!it.source) throw new Error(`item ${i} needs source or r2Key.`);
      const src = await readSource(env, it.source);
      checkImageSize(src.bytes);
      inputKey = `jobs/${jobId}/input-${i}-${src.name || 'image'}`;
      await env.BUCKET.put(inputKey, src.bytes, {
        httpMetadata: { contentType: src.mime },
      });
    }
    items.push({
      id: `item-${i}`,
      status: 'queued',
      inputKey,
      format,
      options: it.options,
    });
  }
  const record: JobRecord = {
    id: jobId,
    owner: token,
    status: 'queued',
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    items,
    inline,
  };
  await env.JOBS.put(jobId, JSON.stringify(record), { expirationTtl: 86400 });
  await env.QUEUE.send({ jobId, token, record });
  return jobId;
}

export async function processJobSync(
  env: Env,
  token: string,
  itemsInput: any[],
  inline: boolean,
) {
  const jobId = crypto.randomUUID();
  const items: JobItem[] = [];
  for (let i = 0; i < itemsInput.length; i++) {
    const it = itemsInput[i];
    let inputKey: string;
    let bytes: Uint8Array;
    let mime: string | undefined;
    let name: string | undefined;
    if (it.r2Key) {
      inputKey = it.r2Key;
      const obj = await env.BUCKET.get(inputKey);
      if (!obj) throw new Error('r2 object not found');
      const buf = await obj.arrayBuffer();
      bytes = new Uint8Array(buf);
      mime = obj.httpMetadata?.contentType;
      name = it.filename;
    } else {
      const src = await readSource(env, it.source);
      checkImageSize(src.bytes);
      bytes = src.bytes;
      mime = src.mime;
      name = src.name;
      inputKey = `jobs/${jobId}/input-${i}-${name || 'image'}`;
      await env.BUCKET.put(inputKey, bytes, {
        httpMetadata: { contentType: mime },
      });
    }
    // process via Render if available
    let outputKey: string;
    let size: number;
    let outMime: string;
    let ext: string;
    if (env.RENDER_URL) {
      assertSupportedFormat(it.format || 'jpeg');
      const b64 = bytesToBase64(bytes);
      const res = await fetch(`${env.RENDER_URL.replace(/\/$/, '')}/compress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: b64,
          format: it.format || 'jpeg',
          options: it.options || {},
        }),
      });
      if (!res.ok) throw new Error(`render failed ${res.status}`);
      const data = (await res.json()) as any;
      const outBuf = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
      ext = data.ext || 'jpg';
      outMime = data.mime;
      outputKey = `jobs/${jobId}/item-${i}-out.${ext}`;
      await env.BUCKET.put(outputKey, outBuf, {
        httpMetadata: { contentType: outMime },
      });
      size = outBuf.length;
    } else {
      ext = 'bin';
      outMime = mime || 'application/octet-stream';
      outputKey = `jobs/${jobId}/item-${i}-out.bin`;
      await env.BUCKET.put(outputKey, bytes, {
        httpMetadata: { contentType: outMime },
      });
      size = bytes.length;
    }
    items.push({
      id: `item-${i}`,
      status: 'done',
      inputKey,
      outputKey,
      format: it.format,
      options: it.options,
      size,
      mime: outMime,
    });
  }
  const record: JobRecord = {
    id: jobId,
    owner: token,
    status: 'done',
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    items,
    inline,
  };
  await env.JOBS.put(jobId, JSON.stringify(record), { expirationTtl: 86400 });
  return jobId;
}

export const OPTION_SCHEMAS: Record<string, any> = {
  jpeg: {
    quality: { type: 'number', min: 1, max: 100, default: 80 },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  png: { width: { type: 'number' }, height: { type: 'number' } },
  webp: {
    quality: { type: 'number', min: 1, max: 100, default: 80 },
    width: { type: 'number' },
    height: { type: 'number' },
    lossless: { type: 'boolean', default: false },
  },
  avif: {
    quality: { type: 'number', min: 1, max: 100, default: 80 },
    width: { type: 'number' },
    height: { type: 'number' },
  },
};

export function getOptionSchema(format: string) {
  return OPTION_SCHEMAS[format] || null;
}

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

/** Chunked bytes->base64 to avoid stack blowup on large images. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
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

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
    if (!obj) throw new Error('r2 object not found');
    const buf = await obj.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mime: obj.httpMetadata?.contentType,
      name: source.filename,
    };
  }
  throw new Error('invalid source');
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
      const b64 = btoa(String.fromCharCode(...bytes));
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

export function listFormats() {
  return [
    { id: 'mozjpeg', label: 'MozJPEG', mime: 'image/jpeg', ext: 'jpg' },
    { id: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp' },
    { id: 'avif', label: 'AVIF', mime: 'image/avif', ext: 'avif' },
    { id: 'oxipng', label: 'OxiPNG', mime: 'image/png', ext: 'png' },
    { id: 'jxl', label: 'JPEG XL', mime: 'image/jxl', ext: 'jxl' },
    { id: 'qoi', label: 'QOI', mime: 'image/qoi', ext: 'qoi' },
  ];
}
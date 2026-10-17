import type { Env, JobRecord } from './types';

async function processOne(env: Env, jobId: string, item: any) {
  if (env.RENDER_URL) {
    const obj = await env.BUCKET.get(item.inputKey);
    if (!obj) throw new Error('input missing');
    const buf = await obj.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const res = await fetch(`${env.RENDER_URL.replace(/\/$/, '')}/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: b64,
        format: item.format || 'jpeg',
        quality: 80,
      }),
    });
    if (!res.ok) throw new Error(`render failed ${res.status}`);
    const data = (await res.json()) as any;
    const outBuf = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
    const outKey = `jobs/${jobId}/${item.id}-out.${data.ext || 'jpg'}`;
    await env.BUCKET.put(outKey, outBuf, {
      httpMetadata: { contentType: data.mime },
    });
    item.outputKey = outKey;
    item.status = 'done';
    item.size = outBuf.length;
    item.mime = data.mime;
    return;
  }
  // Fallback: identity copy (no real compression)
  const obj = await env.BUCKET.get(item.inputKey);
  if (!obj) throw new Error('input missing');
  const buf = await obj.arrayBuffer();
  const outKey = `jobs/${jobId}/${item.id}-out.bin`;
  await env.BUCKET.put(outKey, buf, { httpMetadata: obj.httpMetadata });
  item.outputKey = outKey;
  item.status = 'done';
  item.size = buf.byteLength;
  item.mime = obj.httpMetadata?.contentType;
}

export async function handleQueue(batch: MessageBatch<any>, env: Env) {
  for (const msg of batch.messages) {
    const { jobId } = msg.body || {};
    if (!jobId) {
      msg.ack();
      continue;
    }
    const raw = await env.JOBS.get(jobId);
    if (!raw) {
      msg.ack();
      continue;
    }
    const rec = JSON.parse(raw) as JobRecord;
    rec.status = 'processing';
    await env.JOBS.put(jobId, JSON.stringify(rec), { expirationTtl: 86400 });
    try {
      for (const item of rec.items) {
        if (item.status === 'queued') {
          await processOne(env, jobId, item);
        }
      }
      rec.status = 'done';
    } catch (e: any) {
      rec.status = 'error';
      for (const item of rec.items)
        if (item.status === 'queued') item.status = 'error';
    }
    await env.JOBS.put(jobId, JSON.stringify(rec), { expirationTtl: 86400 });
    msg.ack();
  }
}
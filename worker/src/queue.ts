import type { Env, JobRecord } from './types';
import { processStoredItems, log } from './services';
import {
  handleUpscaleQueueMessage,
  isPermanentUpscaleError,
  markUpscaleFailed,
} from './upscale';

/** Queue redelivers up to max_retries (wrangler.toml); this cap marks terminal failure. */
const MAX_ATTEMPTS = 5;

/** Compression consumer (unchanged behaviour): one job message, ack always. */
async function handleCompressMessage(env: Env, msg: Message<any>) {
  const { jobId, record: msgRecord } = msg.body || {};
  if (!jobId) {
    msg.ack();
    return;
  }
  const rec = (
    msgRecord ? msgRecord : JSON.parse((await env.JOBS.get(jobId)) || '{}')
  ) as JobRecord;
  if (!rec || !rec.id) {
    msg.ack();
    return;
  }
  rec.status = 'processing';
  await env.JOBS.put(jobId, JSON.stringify(rec), { expirationTtl: 86400 });
  try {
    await processStoredItems(env, jobId, rec.items);
    rec.status = rec.items.every((i) => i.status === 'done') ? 'done' : 'error';
  } catch (e: any) {
    rec.status = 'error';
    for (const item of rec.items) {
      if (item.status === 'queued' || item.status === 'processing') {
        item.status = 'error';
        item.error = e?.message || 'job failed';
      }
    }
  }
  await env.JOBS.put(jobId, JSON.stringify(rec), { expirationTtl: 86400 });
  const failed = rec.items.filter((i) => i.status === 'error').length;
  log('job.consume', {
    jobId,
    status: rec.status,
    items: rec.items.length,
    failed,
  });
  msg.ack();
}

export async function handleQueue(batch: MessageBatch<any>, env: Env) {
  for (const msg of batch.messages) {
    const body: any = msg.body || {};
    // Messages without a kind predate the upscale queue: compression.
    if (body.kind !== 'upscale') {
      await handleCompressMessage(env, msg);
      continue;
    }
    if (!body.jobId) {
      msg.ack();
      continue;
    }
    try {
      await handleUpscaleQueueMessage(env, msg);
      msg.ack();
    } catch (e: any) {
      const attempts = msg.attempts || 1;
      const permanent = isPermanentUpscaleError(e);
      log('upscale.msg.error', {
        jobId: body.jobId,
        phase: body.phase,
        tx: body.tx,
        ty: body.ty,
        attempts,
        permanent,
        error: e?.message || String(e),
      });
      // Bad input / over budget: fail the job now, retrying cannot help.
      // Backend hiccups: retry, and when the attempts run out record the
      // terminal error before the message lands in the DLQ.
      if (!permanent && attempts < MAX_ATTEMPTS) throw e;
      try {
        await markUpscaleFailed(
          env,
          body.jobId,
          e?.message || 'upscale failed',
        );
      } catch (markErr: any) {
        log('upscale.msg.markFailedError', {
          jobId: body.jobId,
          error: markErr?.message || String(markErr),
        });
      }
      if (permanent) {
        msg.ack();
        continue;
      }
      throw e;
    }
  }
}

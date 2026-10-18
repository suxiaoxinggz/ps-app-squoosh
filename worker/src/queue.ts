import type { Env, JobRecord } from './types';
import { processStoredItems, log } from './services';

export async function handleQueue(batch: MessageBatch<any>, env: Env) {
  for (const msg of batch.messages) {
    const { jobId, record: msgRecord } = msg.body || {};
    if (!jobId) {
      msg.ack();
      continue;
    }
    const rec = (
      msgRecord ? msgRecord : JSON.parse((await env.JOBS.get(jobId)) || '{}')
    ) as JobRecord;
    if (!rec || !rec.id) {
      msg.ack();
      continue;
    }
    rec.status = 'processing';
    await env.JOBS.put(jobId, JSON.stringify(rec), { expirationTtl: 86400 });
    try {
      await processStoredItems(env, jobId, rec.items);
      rec.status = rec.items.every((i) => i.status === 'done')
        ? 'done'
        : 'error';
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
}

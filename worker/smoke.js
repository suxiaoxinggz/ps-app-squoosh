// Post-deploy smoke: compress -> status -> download must all work.
// Usage: BASE=https://squoosh.016666666.xyz node smoke.js
const BASE = process.env.BASE || 'https://squoosh.016666666.xyz';
const H = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const IMG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  if (!cond) failures++;
}

async function rpc(method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
}

const health = await (await fetch(`${BASE}/health`)).json().catch(() => ({}));
check('health', health.ok === true);

const ready = await (await fetch(`${BASE}/ready`)).json().catch(() => ({}));
check('ready', ready.ok === true, JSON.stringify(ready.checks || {}));

const tools =
  (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) || [];
for (const t of [
  'compress',
  'batch_compress',
  'get_job_status',
  'smart_compress',
  'get_image_info',
  'list_formats',
  'upscale_image',
  'smart_upscale',
]) {
  check(`tool:${t}`, tools.includes(t));
}

const c = await rpc('tools/call', {
  name: 'smart_compress',
  arguments: {
    source: { type: 'base64', value: IMG },
    format: 'webp',
    options: { quality: 60 },
  },
});
const sc = c.result?.structuredContent;
check('smart_compress', !!sc?.jobId, `sync=${sc?.sync} status=${sc?.status}`);
if (sc?.jobId && !sc.sync) {
  let done = false;
  for (let i = 0; i < 20; i++) {
    const s = await rpc('tools/call', {
      name: 'get_job_status',
      arguments: { jobId: sc.jobId },
    });
    const d = s.result?.structuredContent;
    if (d?.status === 'done' || d?.status === 'error') {
      done = d.status === 'done';
      check('poll-to-done', done, JSON.stringify(d?.items?.map((x) => x.size)));
      if (done && d.items[0]?.url) {
        const dl = await fetch(new URL(d.items[0].url, BASE));
        check(
          'download',
          dl.status === 200 && dl.headers.get('content-type') === 'image/webp',
        );
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!sc.sync) check('poll-timeout', done);
}

// Upscale: tiny image should take the sync fast path (or queue briefly).
const uc = await rpc('tools/call', {
  name: 'smart_upscale',
  arguments: { source: { type: 'base64', value: IMG } },
});
const us = uc.result?.structuredContent;
check('smart_upscale', !!us?.jobId, `sync=${us?.sync} status=${us?.status}`);
if (us?.jobId && !us.sync) {
  let udone = false;
  for (let i = 0; i < 40; i++) {
    const s = await rpc('tools/call', {
      name: 'get_job_status',
      arguments: { jobId: us.jobId },
    });
    const d = s.result?.structuredContent;
    if (d?.status === 'done' || d?.status === 'error') {
      udone = d.status === 'done';
      check(
        'upscale-done',
        udone,
        JSON.stringify(d?.items?.map((x) => x.size)),
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  check('upscale-poll-timeout', udone);
}

if (failures) {
  console.error(`${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('smoke OK');

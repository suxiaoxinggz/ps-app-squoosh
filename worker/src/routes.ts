import { Hono } from 'hono';
import type { Env } from './types';
import {
  ownerTokenFromAuth,
  readSource,
  submitJob,
  getImageInfo,
  listFormats,
  getOptionSchema,
  checkRateLimit,
  jobItemsForClient,
} from './services';
import { submitUpscaleJob } from './upscale';

const TOOL_DEFS = [
  {
    name: 'upload_image',
    description:
      'Upload an image from base64, a public URL, or an existing R2 key. Returns {jobId, r2Key} for later compress calls. Example source: {"type":"base64","value":"..."} or {"type":"url","value":"https://..."} or {"type":"r2","value":"jobs/..."}.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          description: '{type:"base64"|"url"|"r2", value, mime?, filename?}',
        },
      },
      required: ['source'],
    },
    outputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, r2Key: { type: 'string' } },
      required: ['jobId', 'r2Key'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'list_formats',
    description:
      'List actually supported output formats with label, mime, extension, and engine. Only these ids are accepted by compress/batch_compress/smart_compress.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        formats: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              mime: { type: 'string' },
              ext: { type: 'string' },
              engine: { type: 'string' },
            },
          },
        },
      },
      required: ['formats'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_options_schema',
    description:
      'Get the parameter schema for one output format (quality 1-100, width, height, lossless for webp). Example: {"format":"webp"}.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: 'Format id: jpeg, png, webp, avif',
        },
      },
      required: ['format'],
    },
    outputSchema: {
      type: 'object',
      properties: { format: { type: 'string' }, schema: { type: 'object' } },
      required: ['format', 'schema'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_image_info',
    description:
      'Inspect an image before compressing: returns {size, mime, width, height, format}. Use it to decide target format and resize dimensions.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          description: '{type:"base64"|"url"|"r2", value}',
        },
      },
      required: ['source'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        size: { type: 'number' },
        mime: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        format: { type: 'string' },
      },
      required: ['size', 'mime'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'smart_compress',
    description:
      'One-call smart compression with good defaults (webp, quality 80). Small images return immediately with status done; larger ones queue like compress. For full control use compress/batch_compress.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'object' },
        r2Key: {
          type: 'string',
          description: 'Alternative to source (from upload_image)',
        },
        format: {
          type: 'string',
          description: 'Default webp. jpeg|png|webp|avif.',
        },
        options: { type: 'object', description: 'Default {"quality":80}.' },
        inline: {
          type: 'boolean',
          description: 'If true and result <=2MB, base64 is returned inline.',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Client key: retries return the same jobId.',
        },
      },
      required: ['source'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        sync: { type: 'boolean' },
        status: { type: 'string' },
      },
      required: ['jobId', 'sync', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'compress',
    description:
      'Compress ONE image. Small images (<=2MB) return immediately with status done; larger ones queue — poll get_job_status. Set inline:true to get base64 back directly (<=2MB results only). Example: {"source":{"type":"base64","value":"..."},"format":"webp","options":{"quality":80}}.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'object' },
        r2Key: {
          type: 'string',
          description: 'Alternative to source (from upload_image)',
        },
        format: {
          type: 'string',
          description: 'jpeg|png|webp|avif, default jpeg',
        },
        options: {
          type: 'object',
          description:
            'E.g. {"quality":80,"width":800,"height":600,"lossless":false}',
        },
        inline: {
          type: 'boolean',
          description: 'If true and result <=2MB, base64 is returned inline.',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Client key: retries return the same jobId.',
        },
      },
      required: ['source'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        sync: { type: 'boolean' },
        status: { type: 'string' },
      },
      required: ['jobId', 'sync', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'batch_compress',
    description:
      'Compress MULTIPLE images in one async job (max 20 items, always queued). Returns {jobId}; poll get_job_status for per-item urls. Each item: {source|r2Key, format?, options?}.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Array of {source, format?, options?}, max 20',
        },
        idempotencyKey: { type: 'string' },
      },
      required: ['items'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        sync: { type: 'boolean' },
        status: { type: 'string' },
      },
      required: ['jobId', 'sync', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'get_job_status',
    description:
      'Get status and absolute download urls for a job. Results auto-delete after 24h; download promptly. Returns {jobId, status, items:[{id,status,size,mime,url,error?,model?,scale?}]}. Upscale items also carry model/scale and the input dimensions.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        status: { type: 'string' },
        items: { type: 'array' },
      },
      required: ['jobId', 'status', 'items'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'upscale_image',
    description:
      'AI super-resolution for ONE image (models: general-x4v3 default 4x, anime-v3 4x, cugan-2x 2x, swin-light-x2 2x). Small inputs (<=0.5MP) with inline:true return immediately with status done; everything else queues — poll get_job_status every ~10s, there is no tile-level progress. Output is always PNG. Example: {"source":{"type":"base64","value":"..."},"model":"general-x4v3","targetScale":2,"inline":true}.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'object' },
        r2Key: {
          type: 'string',
          description: 'Alternative to source (from upload_image)',
        },
        model: {
          type: 'string',
          description:
            'general-x4v3 (default, 4x) | anime-v3 (4x) | cugan-2x (2x) | swin-light-x2 (2x). Unknown ids error with the list.',
        },
        targetScale: {
          type: 'number',
          description:
            'Optional output scale that evenly divides the model scale (e.g. 2 for a 4x model) to save compute.',
        },
        inline: {
          type: 'boolean',
          description:
            'If true and the input is <=0.5MP, stitch now and return base64 PNG (<=2MB).',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Client key: retries return the same jobId.',
        },
      },
      required: ['source'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        sync: { type: 'boolean' },
        status: { type: 'string' },
      },
      required: ['jobId', 'sync', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'smart_upscale',
    description:
      'One-call upscale with good defaults (general-x4v3, 4x, PNG out). Same queueing rules as upscale_image: small inputs with inline:true return immediately, the rest queue for get_job_status.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'object' },
        r2Key: {
          type: 'string',
          description: 'Alternative to source (from upload_image)',
        },
        inline: {
          type: 'boolean',
          description:
            'If true and the input is <=0.5MP, stitch now and return base64 PNG (<=2MB).',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Client key: retries return the same jobId.',
        },
      },
      required: ['source'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        sync: { type: 'boolean' },
        status: { type: 'string' },
      },
      required: ['jobId', 'sync', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
] as const;

const PROMPT_DEFS = [
  {
    name: 'batch_compress_guide',
    description:
      'Step-by-step guide for compressing one or many images via this server.',
    arguments: [],
  },
];

const BATCH_GUIDE_TEXT = `Compress images with this server in 4 steps:
1. (Optional, recommended) Call get_image_info with the source to learn size/mime/dimensions.
2. Call list_formats (ids: jpeg, png, webp, avif) and get_options_schema for the chosen format.
3. Call compress (1 image) or batch_compress (up to 20). Small images (<=2MB) finish immediately with status "done"; larger ones return status "queued" — use inline:true to also get base64 back for small results.
4. Poll get_job_status with the jobId until status is "done", then download each item url (absolute URLs, valid ~24h).
Tips: webp quality 80 is a good default (see smart_compress); pass idempotencyKey so client retries never create duplicate jobs.

Upscale (AI super-resolution) with the same server:
1. Call upscale_image with {source|r2Key, model?, targetScale?, inline?}, or smart_upscale for a one-call default. Models: general-x4v3 (default, 4x), anime-v3 (4x), cugan-2x (2x), swin-light-x2 (2x). An unknown model id errors and lists the four — there is no silent fallback.
2. targetScale must evenly divide the model scale (e.g. 2 for a 4x model) and only lowers the output, never raises it.
3. Small inputs (<=0.5MP) with inline:true are stitched inside the call and return base64 immediately; everything else returns status "queued". Poll get_job_status about every 10s: progress is only queued -> processing -> done (tile-level progress is not exposed, and each tile is a separate backend call).
4. Budgets: the stitched output is capped at 8000px per side and 8MP total; at full scale that means 4x models accept <=0.5MP input and 2x models <=2MP. Over-budget requests fail with the measured reason — resize first or use the local edition.
5. Upscale output is always PNG (lossless). Run compress/batch_compress afterwards if you need jpeg/webp/avif.
6. get_job_status items for upscale also carry model, scale, and the input dimensions.`;

function originOf(c: any): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

async function getSessionId(env: Env, req: Request): Promise<string | null> {
  const sid = req.headers.get('mcp-session-id');
  if (!sid) return null;
  const raw = await env.JOBS.get(`mcp:session:${sid}`);
  return raw ? sid : null;
}

async function createSession(env: Env): Promise<string> {
  const sid = crypto.randomUUID();
  await env.JOBS.put(
    `mcp:session:${sid}`,
    JSON.stringify({ createdAt: Date.now() }),
    {
      expirationTtl: 86400,
    },
  );
  return sid;
}

export function registerRoutes(app: Hono<{ Bindings: Env }>, env: Env) {
  // CORS for browser-based MCP clients (harmless for server-side clients).
  app.use('*', async (c, next) => {
    await next();
    c.header('Access-Control-Allow-Origin', '*');
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Accept, Mcp-Session-Id',
    );
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  });
  app.options('*', (c) => new Response(null, { status: 204 }));

  app.get('/health', (c) => c.json({ ok: true }));

  // Readiness: worker bindings + Render backend reachability.
  app.get('/ready', async (c) => {
    const checks: Record<string, string> = { worker: 'ok' };
    if (env.RENDER_URL) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch(`${env.RENDER_URL.replace(/\/$/, '')}/health`, {
          signal: ctrl.signal,
        });
        clearTimeout(t);
        checks.render = r.ok ? 'ok' : `http-${r.status}`;
      } catch (e: any) {
        // Free-tier Render sleeps after idle; first hit may time out while it wakes.
        checks.render = `unreachable (cold start?): ${e?.message || e}`;
      }
    } else {
      checks.render = 'not-configured';
    }
    const ok = checks.render === 'ok';
    return c.json({ ok, checks }, ok ? 200 : 503);
  });

  app.post('/api/upload', async (c) => {
    const body = await c.req.json();
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const rl = await checkRateLimit(env, token);
    if (rl) return c.json({ error: `rate limited. Retry in ${rl}s.` }, 429);
    const jobId = crypto.randomUUID();
    const { bytes, mime, name } = await readSource(env, body.source);
    const key = `jobs/${jobId}/input-${name || 'image'}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    const record = {
      id: jobId,
      owner: token,
      status: 'done',
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      items: [
        {
          id: 'input',
          status: 'done',
          inputKey: key,
          mime,
          size: bytes.length,
        },
      ],
      inline: false,
    };
    await env.JOBS.put(jobId, JSON.stringify(record), { expirationTtl: 86400 });
    return c.json({ jobId, r2Key: key });
  });

  app.post('/api/compress', async (c) => {
    const body = await c.req.json();
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const rl = await checkRateLimit(env, token);
    if (rl) return c.json({ error: `rate limited. Retry in ${rl}s.` }, 429);
    const items = Array.isArray(body.items) ? body.items : [body];
    const r = await submitJob(env, token, items, {
      inline: body.inline === true,
      idempotencyKey: body.idempotencyKey,
    });
    const out: any = {
      jobId: r.jobId,
      sync: r.sync,
      status: r.sync ? 'done' : 'queued',
    };
    if (r.inlineBase64) {
      out.base64 = r.inlineBase64;
      out.mime = r.inlineMime;
    }
    return c.json(out);
  });

  app.get('/api/jobs/:jobId', async (c) => {
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const jobId = c.req.param('jobId');
    const raw = await env.JOBS.get(jobId);
    if (!raw)
      return c.json(
        {
          error: 'job not found. Check the jobId from compress/batch_compress.',
        },
        404,
      );
    const rec = JSON.parse(raw);
    if (rec.owner !== token)
      return c.json({ error: 'forbidden. Jobs are isolated per token.' }, 403);
    return c.json({
      jobId: rec.id,
      status: rec.status,
      items: jobItemsForClient(rec, token, originOf(c)),
    });
  });

  app.get('/files/:jobId/:name', async (c) => {
    const token = c.req.query('token') || '';
    const jobId = c.req.param('jobId');
    const name = c.req.param('name');
    const raw = await env.JOBS.get(jobId);
    if (!raw) return c.text('not found', 404);
    const rec = JSON.parse(raw);
    if (rec.owner !== token) return c.text('forbidden', 403);
    // Resolve through the item so any storage prefix works (upscale outputs
    // live under upscale/{jobId}/, compression outputs under jobs/{jobId}/).
    const item = (rec.items || []).find(
      (it: any) => it.outputKey && it.outputKey.split('/').pop() === name,
    );
    const key = item?.outputKey || `jobs/${jobId}/${name}`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return c.text('not found', 404);
    return new Response(obj.body, {
      headers: {
        'Content-Type':
          obj.httpMetadata?.contentType || 'application/octet-stream',
      },
    });
  });

  app.get('/api/formats', (c) => c.json({ formats: listFormats() }));
  app.get('/api/options/:format', (c) => {
    const s = getOptionSchema(c.req.param('format'));
    if (!s)
      return c.json(
        {
          error: `unknown format "${c.req.param('format')}". See /api/formats.`,
        },
        404,
      );
    return c.json({ format: c.req.param('format'), schema: s });
  });

  async function handleMcpMessage(c: any) {
    const accept = c.req.header('accept') || '';
    if (
      !accept.includes('application/json') &&
      !accept.includes('text/event-stream')
    ) {
      return c.json(
        {
          error:
            'Not Acceptable. Send Accept: application/json, text/event-stream.',
        },
        406,
      );
    }
    const body = await c.req.json();
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const origin = originOf(c);
    const { method, id, params } = body || {};
    if (id === undefined || id === null) {
      return new Response(null, { status: 202 });
    }
    const reply = (result: any, error?: any) =>
      c.json({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });

    if (method === 'initialize') {
      const sid = await createSession(env);
      c.header('Mcp-Session-Id', sid);
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'squoosh-mcp', version: '0.3.0' },
      });
    }
    const sid = await getSessionId(env, c.req.raw);
    if (sid) c.header('Mcp-Session-Id', sid);

    if (method === 'prompts/list') {
      return reply({ prompts: PROMPT_DEFS });
    }
    if (method === 'prompts/get') {
      if (params?.name !== 'batch_compress_guide') {
        return reply(null, {
          code: -32602,
          message: `unknown prompt "${params?.name}".`,
        });
      }
      return reply({
        description:
          'Step-by-step guide for compressing images via this server.',
        messages: [
          { role: 'user', content: { type: 'text', text: BATCH_GUIDE_TEXT } },
        ],
      });
    }
    if (method === 'tools/list') {
      return reply({ tools: TOOL_DEFS });
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const structured = (data: any, summary: string) => ({
        content: [
          { type: 'text', text: summary + '\n' + JSON.stringify(data) },
        ],
        structuredContent: data,
      });
      try {
        const rl = await checkRateLimit(env, token);
        if (rl)
          return reply(null, {
            code: -32000,
            message: `rate limited. Retry in ${rl}s (20 req/min per token).`,
          });
        if (name === 'upload_image') {
          const jobId = crypto.randomUUID();
          const { bytes, mime, name: n } = await readSource(env, args.source);
          const key = `jobs/${jobId}/input-${n || 'image'}`;
          await env.BUCKET.put(key, bytes, {
            httpMetadata: { contentType: mime },
          });
          const record = {
            id: jobId,
            owner: token,
            status: 'done',
            createdAt: Date.now(),
            expiresAt: Date.now() + 86400000,
            items: [
              {
                id: 'input',
                status: 'done',
                inputKey: key,
                mime,
                size: bytes.length,
              },
            ],
            inline: false,
          };
          await env.JOBS.put(jobId, JSON.stringify(record), {
            expirationTtl: 86400,
          });
          return reply(structured({ jobId, r2Key: key }, 'Uploaded.'));
        }
        if (name === 'list_formats') {
          return reply(
            structured({ formats: listFormats() }, 'Supported formats.'),
          );
        }
        if (name === 'get_options_schema') {
          const schema = getOptionSchema(args.format);
          if (!schema)
            return reply(null, {
              code: -32000,
              message: `unknown format "${args.format}". Call list_formats first.`,
            });
          return reply(
            structured(
              { format: args.format, schema },
              `Options for ${args.format}.`,
            ),
          );
        }
        if (name === 'get_image_info') {
          const info = await getImageInfo(env, args.source);
          return reply(structured(info, 'Image info.'));
        }
        if (name === 'smart_compress' || name === 'compress') {
          const items = [
            {
              source: args.source,
              r2Key: args.r2Key,
              format:
                args.format || (name === 'smart_compress' ? 'webp' : 'jpeg'),
              options:
                args.options ||
                (name === 'smart_compress' ? { quality: 80 } : undefined),
            },
          ];
          const r = await submitJob(env, token, items, {
            inline: args.inline === true,
            idempotencyKey: args.idempotencyKey,
          });
          const data: any = {
            jobId: r.jobId,
            sync: r.sync,
            status: r.sync ? 'done' : 'queued',
          };
          if (r.inlineBase64) {
            data.base64 = r.inlineBase64;
            data.mime = r.inlineMime;
          }
          return reply(
            structured(
              data,
              r.sync
                ? 'Done immediately.'
                : 'Queued. Poll get_job_status with this jobId.',
            ),
          );
        }
        if (name === 'upscale_image' || name === 'smart_upscale') {
          const r = await submitUpscaleJob(env, token, {
            source: args.source,
            r2Key: args.r2Key,
            model: args.model,
            targetScale: args.targetScale,
            inline: args.inline === true,
            idempotencyKey: args.idempotencyKey,
          });
          const data: any = {
            jobId: r.jobId,
            sync: r.sync,
            status: r.sync ? 'done' : 'queued',
          };
          if (r.inlineBase64) {
            data.base64 = r.inlineBase64;
            data.mime = r.inlineMime;
          }
          return reply(
            structured(
              data,
              r.sync
                ? 'Upscaled immediately (PNG).'
                : 'Queued. Poll get_job_status about every 10s until done.',
            ),
          );
        }
        if (name === 'batch_compress') {
          const r = await submitJob(env, token, args.items || [], {
            idempotencyKey: args.idempotencyKey,
          });
          return reply(
            structured(
              {
                jobId: r.jobId,
                sync: r.sync,
                status: r.sync ? 'done' : 'queued',
              },
              'Queued. Poll get_job_status with this jobId.',
            ),
          );
        }
        if (name === 'get_job_status') {
          const raw = await env.JOBS.get(args.jobId);
          if (!raw)
            return reply(null, {
              code: -32000,
              message:
                'job not found. Check the jobId returned by compress/batch_compress.',
            });
          const rec = JSON.parse(raw);
          if (rec.owner !== token)
            return reply(null, {
              code: -32001,
              message: 'forbidden. Jobs are isolated per token.',
            });
          const data = {
            jobId: rec.id,
            status: rec.status,
            items: jobItemsForClient(rec, token, origin),
          };
          return reply(structured(data, `Job ${rec.status}.`));
        }
        return reply(null, {
          code: -32601,
          message: `unknown tool "${name}". Call tools/list first.`,
        });
      } catch (e: any) {
        return reply(null, { code: -32000, message: e?.message || 'error' });
      }
    }
    if (method === 'ping') {
      return reply({ ok: true });
    }
    return reply(null, {
      code: -32601,
      message: `method not found: ${method}`,
    });
  }

  app.post('/mcp', handleMcpMessage);
  app.get('/mcp', (c) =>
    c.text(
      'MCP endpoint. POST JSON-RPC with Accept: application/json, text/event-stream.',
      200,
    ),
  );

  app.get('/mcp/sse', async (c) => {
    const sid = await getSessionId(env, c.req.raw);
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('event: endpoint\ndata: /mcp\n\n'));
        const interval = setInterval(() => {
          controller.enqueue(enc.encode(': ping\n\n'));
        }, 15000);
        setTimeout(() => {
          clearInterval(interval);
          controller.close();
        }, 300000);
      },
    });
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    };
    if (sid) headers['Mcp-Session-Id'] = sid;
    return new Response(stream, { headers });
  });

  app.delete('/mcp', async (c) => {
    const sid = c.req.header('mcp-session-id');
    if (sid) await env.JOBS.delete(`mcp:session:${sid}`);
    return new Response(null, { status: 200 });
  });

  // Unknown API paths -> JSON 404 (must come before the SPA fallback).
  app.all('/api/*', (c) =>
    c.json({ error: `unknown api path: ${new URL(c.req.url).pathname}` }, 404),
  );
  app.all('/mcp/*', (c) =>
    c.json({ error: `unknown mcp path: ${new URL(c.req.url).pathname}` }, 404),
  );

  app.get('*', async (c) => env.ASSETS.fetch(c.req.raw));
}

import { Hono } from 'hono';
import type { Env } from './types';
import {
  ownerTokenFromAuth,
  readSource,
  createQueuedJob,
  processJobSync,
  listFormats,
  getOptionSchema,
  checkRateLimit,
} from './services';

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
      'List actually supported output formats with label, mime, extension, and engine. Only these ids are accepted by compress/batch_compress.',
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
          description: 'Format id, e.g. jpeg, png, webp, avif',
        },
      },
      required: ['format'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string' },
        schema: { type: 'object' },
      },
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
    name: 'compress',
    description:
      'Compress ONE image asynchronously. Returns {jobId}; poll get_job_status until status is done, then download item urls. Example: {"source":{"type":"base64","value":"..."},"format":"webp","options":{"quality":80}}.',
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
          description: 'Ignored (always R2 URL). Kept for compat.',
        },
      },
      required: ['source'],
    },
    outputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
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
      'Compress MULTIPLE images in one async job (max 20 items). Returns {jobId}; poll get_job_status for per-item urls. Each item: {source|r2Key, format?, options?}.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Array of {source, format?, options?}, max 20',
        },
        inline: { type: 'boolean' },
      },
      required: ['items'],
    },
    outputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
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
      'Get status and temporary download urls for a job. Results auto-delete after 24h; download promptly. Returns {jobId, status, items:[{id,status,size,mime,url,error?}]}.',
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
] as const;

function jobItemsForClient(rec: any, token: string) {
  return rec.items.map((it: any) => ({
    id: it.id,
    status: it.status,
    size: it.size,
    mime: it.mime,
    error: it.error,
    url:
      it.outputKey && it.status === 'done'
        ? `/files/${rec.id}/${it.outputKey.split('/').pop()}?token=${encodeURIComponent(token)}`
        : undefined,
  }));
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
  app.get('/health', (c) => c.json({ ok: true }));

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

  // Async enqueue (queue consumer does the work) — avoids Worker CPU walls on big batches.
  app.post('/api/compress', async (c) => {
    const body = await c.req.json();
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const rl = await checkRateLimit(env, token);
    if (rl) return c.json({ error: `rate limited. Retry in ${rl}s.` }, 429);
    const items = Array.isArray(body.items) ? body.items : [body];
    const jobId = await createQueuedJob(
      env,
      token,
      items,
      body.inline === true,
    );
    return c.json({ jobId, status: 'queued' });
  });

  // Sync fallback for tiny single images (kept for compat; batch should use async).
  app.post('/api/compress-sync', async (c) => {
    const body = await c.req.json();
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const items = Array.isArray(body.items) ? body.items : [body];
    if (items.length > 4)
      return c.json(
        { error: 'sync limited to 4 items. Use /api/compress.' },
        400,
      );
    const jobId = await processJobSync(env, token, items, true);
    return c.json({ jobId, status: 'done' });
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
      items: jobItemsForClient(rec, token),
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
    const obj = await env.BUCKET.get(`jobs/${jobId}/${name}`);
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
    // Streamable HTTP: require Accept with both types per spec (be lenient: accept either).
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
    const { method, id, params } = body || {};
    // Notifications (no id): acknowledge with 202, no body.
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
        capabilities: { tools: {} },
        serverInfo: { name: 'squoosh-mcp', version: '0.2.0' },
      });
    }
    // All other requests should carry a session id once initialized (lenient if missing).
    const sid = await getSessionId(env, c.req.raw);
    if (sid) c.header('Mcp-Session-Id', sid);

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
          const data = { jobId, r2Key: key };
          return reply(structured(data, 'Uploaded.'));
        }
        if (name === 'list_formats') {
          const data = { formats: listFormats() };
          return reply(structured(data, 'Supported formats.'));
        }
        if (name === 'get_options_schema') {
          const schema = getOptionSchema(args.format);
          if (!schema)
            return reply(null, {
              code: -32000,
              message: `unknown format "${args.format}". Call list_formats first.`,
            });
          const data = { format: args.format, schema };
          return reply(structured(data, `Options for ${args.format}.`));
        }
        if (name === 'compress') {
          const jobId = await createQueuedJob(env, token, [args], false);
          const data = { jobId };
          return reply(
            structured(data, 'Queued. Poll get_job_status with this jobId.'),
          );
        }
        if (name === 'batch_compress') {
          const jobId = await createQueuedJob(
            env,
            token,
            args.items || [],
            false,
          );
          const data = { jobId };
          return reply(
            structured(data, 'Queued. Poll get_job_status with this jobId.'),
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
            items: jobItemsForClient(rec, token),
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

  // Streamable HTTP endpoint (POST) + legacy SSE stream (GET) + session close (DELETE).
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

  app.get('*', async (c) => env.ASSETS.fetch(c.req.raw));
}

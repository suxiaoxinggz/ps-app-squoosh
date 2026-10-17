import { Hono } from 'hono';
import type { Env } from './types';
import {
  ownerTokenFromAuth,
  readSource,
  createJob,
  listFormats,
  getOptionSchema,
} from './services';

export function registerRoutes(app: Hono<{ Bindings: Env }>, env: Env) {
  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/api/upload', async (c) => {
    const body = await c.req.json();
    const token = ownerTokenFromAuth(c.req.header('authorization'));
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
    const items = Array.isArray(body.items) ? body.items : [body];
    const jobId = await createJob(env, token, items, body.inline === true);
    return c.json({ jobId });
  });

  app.get('/api/jobs/:jobId', async (c) => {
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const jobId = c.req.param('jobId');
    const raw = await env.JOBS.get(jobId);
    if (!raw) return c.json({ error: 'not found' }, 404);
    const rec = JSON.parse(raw);
    if (rec.owner !== token) return c.json({ error: 'forbidden' }, 403);
    const items = rec.items.map((it: any) => ({
      id: it.id,
      status: it.status,
      size: it.size,
      mime: it.mime,
      url:
        it.outputKey && it.status === 'done'
          ? `/files/${jobId}/${it.outputKey.split('/').pop()}?token=${encodeURIComponent(token)}`
          : undefined,
    }));
    return c.json({ jobId: rec.id, status: rec.status, items });
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
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.json({ format: c.req.param('format'), schema: s });
  });

  // MCP JSON-RPC
  app.post('/mcp', async (c) => {
    const body = await c.req.json();
    const token = ownerTokenFromAuth(c.req.header('authorization'));
    const { method, id, params } = body || {};
    const reply = (result: any, error?: any) =>
      c.json({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });

    if (method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'squoosh-mcp', version: '0.1.0' },
      });
    }
    if (method === 'tools/list') {
      return reply({
        tools: [
          {
            name: 'upload_image',
            description: 'Upload image (base64/url/r2)',
            inputSchema: {
              type: 'object',
              properties: { source: { type: 'object' } },
              required: ['source'],
            },
          },
          {
            name: 'list_formats',
            description: 'List supported formats',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'get_options_schema',
            description: 'Get option schema for a format',
            inputSchema: {
              type: 'object',
              properties: { format: { type: 'string' } },
              required: ['format'],
            },
          },
          {
            name: 'compress',
            description: 'Compress single image',
            inputSchema: {
              type: 'object',
              properties: {
                source: { type: 'object' },
                format: { type: 'string' },
                options: { type: 'object' },
                inline: { type: 'boolean' },
              },
              required: ['source'],
            },
          },
          {
            name: 'batch_compress',
            description: 'Compress multiple images',
            inputSchema: {
              type: 'object',
              properties: {
                items: { type: 'array' },
                inline: { type: 'boolean' },
              },
              required: ['items'],
            },
          },
          {
            name: 'get_job_status',
            description: 'Get job status and result URLs',
            inputSchema: {
              type: 'object',
              properties: { jobId: { type: 'string' } },
              required: ['jobId'],
            },
          },
        ],
      });
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
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
          return reply({
            content: [
              { type: 'text', text: JSON.stringify({ jobId, r2Key: key }) },
            ],
          });
        }
        if (name === 'list_formats') {
          return reply({
            content: [{ type: 'text', text: JSON.stringify(listFormats()) }],
          });
        }
        if (name === 'get_options_schema') {
          return reply({
            content: [
              {
                type: 'text',
                text: JSON.stringify(getOptionSchema(args.format)),
              },
            ],
          });
        }
        if (name === 'compress') {
          const items = [args];
          const jobId = await createJob(
            env,
            token,
            items,
            args.inline === true,
          );
          return reply({
            content: [{ type: 'text', text: JSON.stringify({ jobId }) }],
          });
        }
        if (name === 'batch_compress') {
          const jobId = await createJob(
            env,
            token,
            args.items || [],
            args.inline === true,
          );
          return reply({
            content: [{ type: 'text', text: JSON.stringify({ jobId }) }],
          });
        }
        if (name === 'get_job_status') {
          const raw = await env.JOBS.get(args.jobId);
          if (!raw) return reply(null, { code: -32000, message: 'not found' });
          const rec = JSON.parse(raw);
          if (rec.owner !== token)
            return reply(null, { code: -32001, message: 'forbidden' });
          const items = rec.items.map((it: any) => ({
            id: it.id,
            status: it.status,
            size: it.size,
            mime: it.mime,
            url:
              it.outputKey && it.status === 'done'
                ? `/files/${rec.id}/${it.outputKey.split('/').pop()}?token=${encodeURIComponent(token)}`
                : undefined,
          }));
          return reply({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  jobId: rec.id,
                  status: rec.status,
                  items,
                }),
              },
            ],
          });
        }
        return reply(null, { code: -32601, message: 'unknown tool' });
      } catch (e: any) {
        return reply(null, { code: -32000, message: e?.message || 'error' });
      }
    }
    return reply(null, { code: -32601, message: 'method not found' });
  });

  app.get('/mcp', (c) => c.text('MCP endpoint. POST JSON-RPC to /mcp', 200));

  app.get('/mcp/sse', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('event: endpoint\\ndata: /mcp\\n\\n'));
        // keep alive
        const interval = setInterval(() => {
          controller.enqueue(enc.encode(': ping\\n\\n'));
        }, 15000);
        // close after 5 min
        setTimeout(() => {
          clearInterval(interval);
          controller.close();
        }, 300000);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('*', async (c) => env.ASSETS.fetch(c.req.raw));
}

// Local stdio MCP: same Squoosh capabilities, local files, no cloud.
// Reads local paths directly, processes with sharp, writes output files.
import fs from 'node:fs';
import sharp from 'sharp';

const FORMATS = ['jpeg', 'png', 'webp', 'avif'];
const SCHEMAS = {
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

function clamp(format, o = {}) {
  const out = {};
  if (format !== 'png') {
    const n = Number(o.quality);
    out.quality = Number.isFinite(n)
      ? Math.min(100, Math.max(1, Math.round(n)))
      : 80;
  }
  for (const k of ['width', 'height']) {
    const n = Number(o[k]);
    if (Number.isFinite(n) && n > 0) out[k] = Math.min(4000, Math.round(n));
  }
  if (format === 'webp' && o.lossless) out.lossless = true;
  return out;
}

function outName(input, format) {
  const ext = format === 'jpeg' ? 'jpg' : format;
  return input.replace(/\.[^.]*$/, '') + '.' + ext;
}

async function compressFile(input, format = 'jpeg', options = {}, output) {
  if (!FORMATS.includes(format))
    throw new Error(
      `unsupported format "${format}". Use ${FORMATS.join(',')}.`,
    );
  const opt = clamp(format, options);
  let p = sharp(input);
  if (opt.width || opt.height) p = p.resize(opt.width, opt.height);
  const q = opt.quality ?? 80;
  if (format === 'png') p = p.png();
  else if (format === 'webp')
    p = p.webp({ quality: q, lossless: !!opt.lossless });
  else if (format === 'avif') p = p.avif({ quality: q });
  else p = p.jpeg({ quality: q });
  const out = output || outName(input, format);
  const info = await p.toFile(out);
  return {
    output: out,
    size: info.size,
    width: info.width,
    height: info.height,
    format: info.format,
  };
}

const TOOLS = [
  {
    name: 'list_formats',
    description: 'List supported output formats.',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_options_schema',
    description: 'Parameter schema for a format.',
    inputSchema: {
      type: 'object',
      properties: { format: { type: 'string' } },
      required: ['format'],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'get_image_info',
    description: 'Width, height, format, size of a local image.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'compress',
    description: 'Compress one local image. Returns output path + sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        format: { type: 'string' },
        options: { type: 'object' },
        output: { type: 'string' },
      },
      required: ['path'],
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'batch_compress',
    description: 'Compress multiple local images (max 20).',
    inputSchema: {
      type: 'object',
      properties: { items: { type: 'array' } },
      required: ['items'],
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'smart_compress',
    description: 'One-call default (webp q80).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        format: { type: 'string' },
        options: { type: 'object' },
        output: { type: 'string' },
      },
      required: ['path'],
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'upscale',
    description:
      'AI super-resolution of a local image (all 10 models, incl. x4plus). Writes a PNG. No MP cap (warns over 50MP output).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local input image path' },
        model: { type: 'string', description: 'Default general-x4v3' },
        targetScale: {
          type: 'number',
          description: 'Downscale output, must divide model scale',
        },
        output: {
          type: 'string',
          description: 'Output PNG path (default: <input>.upscaled.png)',
        },
      },
      required: ['path'],
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

async function callTool(name, args) {
  if (name === 'list_formats')
    return { formats: FORMATS.map((id) => ({ id })) };
  if (name === 'get_options_schema') {
    if (!SCHEMAS[args.format])
      throw new Error(`unknown format "${args.format}"`);
    return { format: args.format, schema: SCHEMAS[args.format] };
  }
  if (name === 'get_image_info') {
    const st = fs.statSync(args.path);
    const meta = await sharp(args.path).metadata();
    return {
      path: args.path,
      size: st.size,
      width: meta.width,
      height: meta.height,
      format: meta.format,
    };
  }
  if (name === 'compress' || name === 'smart_compress') {
    const smart = name === 'smart_compress';
    const before = fs.statSync(args.path).size;
    const r = await compressFile(
      args.path,
      args.format || (smart ? 'webp' : 'jpeg'),
      args.options || (smart ? { quality: 80 } : undefined),
      args.output,
    );
    return { ...r, before };
  }
  if (name === 'batch_compress') {
    const items = args.items || [];
    if (items.length > 20) throw new Error('max 20 items');
    const out = [];
    for (const it of items) {
      try {
        const before = fs.statSync(it.path).size;
        out.push({
          path: it.path,
          status: 'done',
          ...(await compressFile(
            it.path,
            it.format || 'jpeg',
            it.options,
            it.output,
          )),
          before,
        });
      } catch (e) {
        out.push({
          path: it.path,
          status: 'error',
          error: e?.message || String(e),
        });
      }
    }
    return { items: out };
  }
  if (name === 'upscale') {
    const { findLocalModel, LOCAL_EXTRA_MODELS } =
      await import('./upscale-models.js');
    const { inferUpscale } = await import('../../server/src/upscale/infer.js');
    const model = args.model || 'general-x4v3';
    if (!findLocalModel(model)) {
      throw new Error(
        `unknown model "${model}". Available: ${['general-x4v3', 'anime-v3', 'cugan-2x', 'swin-light-x2', ...LOCAL_EXTRA_MODELS.map((m) => m.id)].join(', ')}`,
      );
    }
    const input = fs.readFileSync(args.path);
    const meta = await sharp(args.path).metadata();
    const mp = ((meta.width || 0) * (meta.height || 0)) / 1e6;
    const out =
      args.output || args.path.replace(/\.[^.]*$/, '') + '.upscaled.png';
    const r = await inferUpscale({
      imageBase64: input.toString('base64'),
      model,
      targetScale: args.targetScale,
      models: LOCAL_EXTRA_MODELS,
      limits: { maxInputMp: 1e9, maxOutputMp: 1e9, maxOutputDim: 1e9 },
    });
    if (mp * (args.targetScale || findLocalModel(model).scale) ** 2 > 50) {
      console.error(
        `warning: output over 50MP — slow and memory-heavy, continuing anyway`,
      );
    }
    fs.writeFileSync(out, Buffer.from(r.base64, 'base64'));
    return {
      path: args.path,
      output: out,
      size: fs.statSync(out).size,
      width: r.width,
      height: r.height,
      model,
      before: input.length,
    };
  }
  throw new Error(`unknown tool "${name}"`);
}

// Minimal stdio JSON-RPC loop (one JSON object per line).
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { method, id, params } = msg;
    const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
    try {
      if (method === 'initialize')
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'squoosh-mcp-local', version: '0.1.0' },
          },
        });
      else if (method === 'tools/list')
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      else if (method === 'tools/call') {
        const data = await callTool(params?.name, params?.arguments || {});
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
          },
        });
      } else if (id === undefined) {
        /* notification: ignore */
      } else
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
    } catch (e) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: e?.message || String(e) },
      });
    }
  }
});

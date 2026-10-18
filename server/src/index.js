import express from 'express';
import cors from 'cors';
import sharp from 'sharp';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

// Shared-secret gate for backend endpoints. Soft-enabled: enforced only
// once RENDER_SECRET is set, so existing deploys keep working.
function gate(req, res, next) {
  if (
    process.env.RENDER_SECRET &&
    req.headers['x-render-secret'] !== process.env.RENDER_SECRET
  ) {
    return res
      .status(401)
      .json({ error: 'unauthorized. Call via the Cloudflare Worker gateway.' });
  }
  next();
}

app.post('/metadata', gate, async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64)
      return res.status(400).json({ error: 'imageBase64 required.' });
    const buf = Buffer.from(
      imageBase64.replace(/^data:[^;]+;base64,/, ''),
      'base64',
    );
    const meta = await sharp(buf).metadata();
    res.json({
      width: meta.width,
      height: meta.height,
      format: meta.format,
      size: buf.length,
    });
  } catch (e) {
    res
      .status(400)
      .json({ error: `unreadable image: ${e?.message || String(e)}` });
  }
});

const OPTION_SCHEMAS = {
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

app.get('/options/:format', (req, res) => {
  const f = req.params.format;
  if (!OPTION_SCHEMAS[f])
    return res.status(404).json({ error: 'unknown format' });
  res.json({ format: f, schema: OPTION_SCHEMAS[f] });
});

app.post('/compress', gate, async (req, res) => {
  try {
    const { imageBase64, format = 'jpeg', options = {} } = req.body || {};
    if (!imageBase64)
      return res.status(400).json({
        error: 'imageBase64 required. Send base64 (data-uri prefix optional).',
      });
    if (!['jpeg', 'png', 'webp', 'avif'].includes(format))
      return res.status(400).json({
        error: `unsupported format "${format}". Use jpeg|png|webp|avif.`,
      });
    const buf = Buffer.from(
      imageBase64.replace(/^data:[^;]+;base64,/, ''),
      'base64',
    );
    if (buf.length > 10 * 1024 * 1024)
      return res.status(413).json({
        error: `image too large (${buf.length} bytes, max 10485760).`,
      });
    let pipeline = sharp(buf);
    if (options.width || options.height)
      pipeline = pipeline.resize(options.width, options.height);
    let outBuf;
    let mime = 'image/jpeg';
    let ext = 'jpg';
    const q = options.quality ?? 80;
    if (format === 'png') {
      outBuf = await pipeline.png().toBuffer();
      mime = 'image/png';
      ext = 'png';
    } else if (format === 'webp') {
      outBuf = await pipeline
        .webp({ quality: q, lossless: !!options.lossless })
        .toBuffer();
      mime = 'image/webp';
      ext = 'webp';
    } else if (format === 'avif') {
      outBuf = await pipeline.avif({ quality: q }).toBuffer();
      mime = 'image/avif';
      ext = 'avif';
    } else {
      outBuf = await pipeline.jpeg({ quality: q }).toBuffer();
    }
    res.json({
      base64: outBuf.toString('base64'),
      mime,
      ext,
      size: outBuf.length,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('listening on', port));

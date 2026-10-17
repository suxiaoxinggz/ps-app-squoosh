import express from 'express';
import cors from 'cors';
import sharp from 'sharp';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/compress', async (req, res) => {
  try {
    const {
      imageBase64,
      format = 'jpeg',
      quality = 80,
      width,
      height,
    } = req.body || {};
    if (!imageBase64)
      return res.status(400).json({ error: 'imageBase64 required' });
    const buf = Buffer.from(
      imageBase64.replace(/^data:[^;]+;base64,/, ''),
      'base64',
    );
    let pipeline = sharp(buf);
    if (width || height) pipeline = pipeline.resize(width, height);
    let outBuf;
    let mime = 'image/jpeg';
    let ext = 'jpg';
    if (format === 'png') {
      outBuf = await pipeline.png().toBuffer();
      mime = 'image/png';
      ext = 'png';
    } else if (format === 'webp') {
      outBuf = await pipeline.webp({ quality }).toBuffer();
      mime = 'image/webp';
      ext = 'webp';
    } else if (format === 'avif') {
      outBuf = await pipeline.avif({ quality }).toBuffer();
      mime = 'image/avif';
      ext = 'avif';
    } else {
      outBuf = await pipeline.jpeg({ quality }).toBuffer();
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
import sharp from 'sharp';
import ort from 'onnxruntime-node';
import { TILE_SIZE, extractTile, buildBlendWeights, blendTile, downsampleTile } from './tiling.js';
import { findModel } from './models.js';
import { getSession } from './session.js';

const MAX_OUTPUT_DIM = 8000;
const MAX_OUTPUT_PIXELS = 50_000_000;

export async function inferUpscale({ imageBase64, model, targetScale }) {
  const m = findModel(model);
  if (!m) throw new Error(`unknown model ${model}. Available: ${['general-x4v3','anime-v3','cugan-2x','swin-light-x2'].join(', ')}`);
  const buf = Buffer.from(imageBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  const meta = await sharp(buf).metadata();
  const width = meta.width;
  const height = meta.height;
  const mp = (width * height) / 1e6;
  const scale = m.scale;
  // MP budget: 4x models <=2MP, 2x models <=4MP
  const limit = scale === 4 ? 2 : 4;
  if (mp > limit) {
    throw new Error(`input too large (${mp.toFixed(2)}MP). ${scale}x models accept <=${limit}MP. Use local edition for larger images.`);
  }
  const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const imageData = { data, width, height };
  const ts = targetScale ?? scale;
  const rawFactor = scale / ts;
  const downsample = ts < scale && Number.isInteger(rawFactor);
  const blendScale = downsample ? ts : scale;
  const blendW = width * blendScale;
  const blendH = height * blendScale;
  const outW = width * ts;
  const outH = height * ts;
  if (blendW > MAX_OUTPUT_DIM || blendH > MAX_OUTPUT_DIM || blendW * blendH > MAX_OUTPUT_PIXELS) throw new Error('output too large');
  if (outW !== blendW || outH !== blendH) {
    if (outW > MAX_OUTPUT_DIM || outH > MAX_OUTPUT_DIM || outW * outH > MAX_OUTPUT_PIXELS) throw new Error('output too large');
  }
  const outData = new Uint8ClampedArray(blendW * blendH * 4);
  const session = await getSession(model);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tilesX = Math.max(1, Math.ceil((width - 16) / (256 - 16)));
  const tilesY = Math.max(1, Math.ceil((height - 16) / (256 - 16)));
  const totalTiles = tilesX * tilesY;
  const tileBuffer = new Float32Array(3 * TILE_SIZE * TILE_SIZE);
  const weights = buildBlendWeights(blendScale);
  let done = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    const ay = ty === 0 ? weights.full : weights.ramp;
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * (TILE_SIZE - 16);
      const y0 = ty * (TILE_SIZE - 16);
      const refill = () => extractTile(imageData, x0, y0, tileBuffer);
      refill();
      const tileTensor = new ort.Tensor('float32', tileBuffer, [1, 3, TILE_SIZE, TILE_SIZE]);
      const tileOut = await session.run({ [inputName]: tileTensor });
      const raw = tileOut[outputName].data;
      const tileData = downsample ? downsampleTile(raw, TILE_SIZE * scale, rawFactor) : raw;
      const ax = tx === 0 ? weights.full : weights.ramp;
      blendTile(outData, tileData, x0, y0, blendW, blendH, blendScale, ax, ay);
      done++;
    }
  }
  // encode PNG
  let pngBuf;
  if (outW !== blendW || outH !== blendH) {
    // resize via sharp
    const stitched = await sharp(Buffer.from(outData), { raw: { width: blendW, height: blendH, channels: 4 } }).png().toBuffer();
    pngBuf = await sharp(stitched).resize(outW, outH).png().toBuffer();
  } else {
    pngBuf = await sharp(Buffer.from(outData), { raw: { width: blendW, height: blendH, channels: 4 } }).png().toBuffer();
  }
  return { base64: pngBuf.toString('base64'), mime: 'image/png', width: outW, height: outH };
}

import sharp from 'sharp';
import ort from 'onnxruntime-node';
import {
  TILE_SIZE,
  TILE_OVERLAP,
  TILE_STEP,
  extractTile,
  buildBlendWeights,
  blendTile,
  downsampleTile,
} from './tiling.js';
import { MODELS } from './models.js';
import { getSession } from './session.js';

const MAX_OUTPUT_DIM = 8000;
const MAX_OUTPUT_PIXELS = 50_000_000;

async function _inferUpscale({
  imageBase64,
  model,
  targetScale,
  models = [],
  limits = {},
}) {
  const all = [...MODELS, ...models];
  const m = all.find((x) => x.id === model);
  if (!m)
    throw new Error(
      `unknown model ${model}. Available: ${all.map((x) => x.id).join(', ')}`,
    );
  const buf = Buffer.from(
    imageBase64.replace(/^data:[^;]+;base64,/, ''),
    'base64',
  );
  // Single canonical decode: dimensions come from the decoded object itself,
  // never from a separate metadata() call (progressive JPEG / EXIF orientation
  // can report different dims and corrupt the tile math downstream).
  const { data, info: rawInfo } = await sharp(buf)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = rawInfo.width;
  const height = rawInfo.height;
  const imageData = { data, width, height };
  const mp = (width * height) / 1e6;
  const scale = m.scale;
  const limit = limits.maxInputMp ?? (scale === 4 ? 2 : 4);
  if (mp > limit) {
    throw new Error(
      `input too large (${mp.toFixed(2)}MP). ${scale}x models accept <=${limit}MP. Use local edition for larger images.`,
    );
  }
  const ts = targetScale ?? scale;
  const rawFactor = scale / ts;
  const downsample = ts < scale && Number.isInteger(rawFactor);
  const blendScale = downsample ? ts : scale;
  const blendW = width * blendScale;
  const blendH = height * blendScale;
  const outW = width * ts;
  const outH = height * ts;
  const maxDim = limits.maxOutputDim ?? MAX_OUTPUT_DIM;
  const maxPx = limits.maxOutputMp
    ? limits.maxOutputMp * 1e6
    : MAX_OUTPUT_PIXELS;
  if (blendW > maxDim || blendH > maxDim || blendW * blendH > maxPx)
    throw new Error('output too large');
  if (outW !== blendW || outH !== blendH) {
    if (outW > maxDim || outH > maxDim || outW * outH > maxPx)
      throw new Error('output too large');
  }
  const outData = new Uint8ClampedArray(blendW * blendH * 4);
  const session = await getSession(model, models);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tilesX = Math.max(1, Math.ceil((width - TILE_OVERLAP) / TILE_STEP));
  const tilesY = Math.max(1, Math.ceil((height - TILE_OVERLAP) / TILE_STEP));
  const totalTiles = tilesX * tilesY;
  const tileBuffer = new Float32Array(3 * TILE_SIZE * TILE_SIZE);
  const weights = buildBlendWeights(blendScale);
  let done = 0;
  let peakRss = process.memoryUsage().rss;
  for (let ty = 0; ty < tilesY; ty++) {
    const ay = ty === 0 ? weights.full : weights.ramp;
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * TILE_STEP;
      const y0 = ty * TILE_STEP;
      const refill = () => extractTile(imageData, x0, y0, tileBuffer);
      refill();
      const tileTensor = new ort.Tensor('float32', tileBuffer, [
        1,
        3,
        TILE_SIZE,
        TILE_SIZE,
      ]);
      const tileOut = await session.run({ [inputName]: tileTensor });
      const raw = tileOut[outputName].data;
      const tileData = downsample
        ? downsampleTile(raw, TILE_SIZE * scale, rawFactor)
        : raw;
      const ax = tx === 0 ? weights.full : weights.ramp;
      blendTile(outData, tileData, x0, y0, blendW, blendH, blendScale, ax, ay);
      done++;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (done % 2 === 0 && global.gc) global.gc();
      if (done % 4 === 0) {
        console.log(
          JSON.stringify({
            event: 'upscale.tile',
            done,
            total: totalTiles,
            rss: process.memoryUsage().rss,
          }),
        );
      }
    }
  }
  let pngBuf;
  if (outW !== blendW || outH !== blendH) {
    const stitched = await sharp(Buffer.from(outData), {
      raw: { width: blendW, height: blendH, channels: 4 },
    })
      .png()
      .toBuffer();
    pngBuf = await sharp(stitched)
      .resize(outW, outH, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
  } else {
    pngBuf = await sharp(Buffer.from(outData), {
      raw: { width: blendW, height: blendH, channels: 4 },
    })
      .png()
      .toBuffer();
  }
  return {
    base64: pngBuf.toString('base64'),
    mime: 'image/png',
    width: outW,
    height: outH,
    peakRss,
  };
}

// Single-tile inference endpoint support: runs ONE tile and returns its raw
// output patch as a small PNG, so a caller (worker) can stitch patches.
// Keeps per-request native memory at single-tile level.
export async function inferTilePatch({
  imageBase64,
  model,
  x0,
  y0,
  models = [],
}) {
  const all = [...MODELS, ...models];
  const m = all.find((x) => x.id === model);
  if (!m)
    throw new Error(
      `unknown model ${model}. Available: ${all.map((x) => x.id).join(', ')}`,
    );
  const buf = Buffer.from(
    imageBase64.replace(/^data:[^;]+;base64,/, ''),
    'base64',
  );
  // Same canonical decode as _inferUpscale (see above): never trust a
  // separate metadata() call for tile math inputs.
  const { data, info: rawInfo } = await sharp(buf)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const imageData = { data, width: rawInfo.width, height: rawInfo.height };
  const scale = m.scale;
  const tileBuffer = new Float32Array(3 * TILE_SIZE * TILE_SIZE);
  extractTile(imageData, x0, y0, tileBuffer);
  const session = await getSession(model, models);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tileTensor = new ort.Tensor('float32', tileBuffer, [
    1,
    3,
    TILE_SIZE,
    TILE_SIZE,
  ]);
  const tileOut = await session.run({ [inputName]: tileTensor });
  const raw = tileOut[outputName].data;
  const ow = TILE_SIZE * scale;
  const oh = TILE_SIZE * scale;
  // float32 planar [0..1] -> 8-bit interleaved RGB. Uint8ClampedArray clamps and
  // rounds exactly like blendTile's writes, so a patch serialised here and
  // blended by the worker matches this process's whole-image output within
  // 1 LSB in feather overlaps (patches are quantized to 8-bit at the seam).
  const plane = ow * oh;
  const patch8 = new Uint8ClampedArray(3 * plane);
  for (let i = 0; i < plane; i++) {
    patch8[i * 3] = raw[i] * 255;
    patch8[i * 3 + 1] = raw[plane + i] * 255;
    patch8[i * 3 + 2] = raw[2 * plane + i] * 255;
  }
  const patch = await sharp(Buffer.from(patch8.buffer), {
    raw: { width: ow, height: oh, channels: 3 },
  })
    .png()
    .toBuffer();
  if (global.gc) global.gc();
  return {
    base64: patch.toString('base64'),
    mime: 'image/png',
    x0,
    y0,
    ow,
    oh,
  };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(new Error(`upscale timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function inferUpscale(args) {
  return withTimeout(_inferUpscale(args), 300000, 'upscale');
}

export async function inferTile(args) {
  return withTimeout(inferTilePatch(args), 60000, 'upscale-tile');
}

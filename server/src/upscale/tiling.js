// MIT License — vendored from isixe/bg2x (src/workers/super-resolution.worker.ts)
// Copyright (c) isixe. See NOTICE-bg2x.md. Pure functions, no browser deps.
// Only the tiling helpers are exported; onnxruntime-web -> onnxruntime-node
// boundary is handled by session.js / infer.js.

const TILE_SIZE = 256;
const TILE_OVERLAP = 16;
const TILE_STEP = TILE_SIZE - TILE_OVERLAP;

export { TILE_SIZE, TILE_OVERLAP, TILE_STEP };

export function extractTile(imageData, x0, y0, out) {
  const { data, width, height } = imageData;
  const plane = TILE_SIZE * TILE_SIZE;
  const inv = 1 / 255;
  if (x0 + TILE_SIZE <= width && y0 + TILE_SIZE <= height) {
    for (let ly = 0; ly < TILE_SIZE; ly++) {
      let si = ((y0 + ly) * width + x0) * 4;
      let di = ly * TILE_SIZE;
      const diEnd = di + TILE_SIZE;
      for (; di < diEnd; di++, si += 4) {
        out[di] = data[si] * inv;
        out[plane + di] = data[si + 1] * inv;
        out[2 * plane + di] = data[si + 2] * inv;
      }
    }
    return;
  }
  for (let ly = 0; ly < TILE_SIZE; ly++) {
    const sy = Math.min(height - 1, Math.max(0, y0 + ly));
    const rowBase = sy * width;
    const outRow = ly * TILE_SIZE;
    for (let lx = 0; lx < TILE_SIZE; lx++) {
      const sx = Math.min(width - 1, Math.max(0, x0 + lx));
      const si = (rowBase + sx) * 4;
      const di = outRow + lx;
      out[di] = data[si] * inv;
      out[plane + di] = data[si + 1] * inv;
      out[2 * plane + di] = data[si + 2] * inv;
    }
  }
}

export function buildBlendWeights(blendScale) {
  const ow = TILE_SIZE * blendScale;
  const overlap = TILE_OVERLAP * blendScale;
  const full = new Float32Array(ow).fill(1);
  const ramp = new Float32Array(ow);
  for (let o = 0; o < ow; o++) {
    ramp[o] = Math.min(1, o / overlap);
  }
  return { full, ramp };
}

export function downsampleTile(src, ow, factor) {
  const owT = ow / factor;
  const planeSrc = ow * ow;
  const planeDst = owT * owT;
  const dst = new Float32Array(3 * planeDst);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < owT; y++) {
    const sy0 = y * factor;
    for (let x = 0; x < owT; x++) {
      const sx0 = x * factor;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        let si = (sy0 + dy) * ow + sx0;
        for (let dx = 0; dx < factor; dx++, si++) {
          r += src[si];
          g += src[planeSrc + si];
          b += src[2 * planeSrc + si];
        }
      }
      const di = y * owT + x;
      dst[di] = r * inv;
      dst[planeDst + di] = g * inv;
      dst[2 * planeDst + di] = b * inv;
    }
  }
  return dst;
}

export function blendTile(out, tile, x0, y0, destW, destH, blendScale, ax, ay) {
  const ow = TILE_SIZE * blendScale;
  const plane = ow * ow;
  const baseX = x0 * blendScale;
  const baseY = y0 * blendScale;
  for (let oy = 0; oy < ow; oy++) {
    const gy = baseY + oy;
    if (gy >= destH) break;
    const aY = ay[oy];
    const tileRow = oy * ow;
    for (let ox = 0; ox < ow; ox++) {
      const gx = baseX + ox;
      if (gx >= destW) break;
      const ti = tileRow + ox;
      const r = tile[ti] * 255;
      const g = tile[plane + ti] * 255;
      const b = tile[2 * plane + ti] * 255;
      const di = (gy * destW + gx) * 4;
      const a = aY * ax[ox];
      if (a >= 1) {
        out[di] = r;
        out[di + 1] = g;
        out[di + 2] = b;
      } else {
        const inv = 1 - a;
        out[di] = out[di] * inv + r * a;
        out[di + 1] = out[di + 1] * inv + g * a;
        out[di + 2] = out[di + 2] * inv + b * a;
      }
      out[di + 3] = 255;
    }
  }
}

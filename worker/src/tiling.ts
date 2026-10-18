// MIT License — vendored from isixe/bg2x (src/workers/super-resolution.worker.ts)
// Copyright (c) isixe. See NOTICE-bg2x.md.
//
// Worker copy of the bg2x tiling helpers. `buildBlendWeights`, `downsampleTile`
// and `blendTile` are copied VERBATIM from server/src/upscale/tiling.js (same
// repo, same license) so the worker-side stitcher and the server-side
// whole-image path feather tiles identically. `extractTile` stays server-side:
// the worker never extracts tiles itself, it asks POST /upscale/tile for one
// patch at a time.
//
// Do not "optimise" the math here without changing server/src/upscale/tiling.js
// in the same commit — the two must stay pixel-identical.

export const TILE_SIZE = 256;
export const TILE_OVERLAP = 16;
export const TILE_STEP = TILE_SIZE - TILE_OVERLAP;

export function buildBlendWeights(blendScale: number) {
  const ow = TILE_SIZE * blendScale;
  const overlap = TILE_OVERLAP * blendScale;
  const full = new Float32Array(ow).fill(1);
  const ramp = new Float32Array(ow);
  for (let o = 0; o < ow; o++) {
    ramp[o] = Math.min(1, o / overlap);
  }
  return { full, ramp };
}

export function downsampleTile(
  src: Float32Array,
  ow: number,
  factor: number,
): Float32Array {
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

export function blendTile(
  out: Uint8ClampedArray,
  tile: Float32Array,
  x0: number,
  y0: number,
  destW: number,
  destH: number,
  blendScale: number,
  ax: Float32Array,
  ay: Float32Array,
): void {
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

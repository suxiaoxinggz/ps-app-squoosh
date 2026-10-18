// Worker-side stitcher for the sharded upscale pipeline.
//
// POST /upscale/tile (Task 3 fix round 4) runs ONE ONNX tile per HTTP call so
// the free-tier Render instance never accumulates multi-tile native memory.
// This module is the other half of that contract: it fans a job out to per-tile
// calls and blends the returned patches back into one image, using the same
// feathering as the whole-image path.
//
// The blend math is copied verbatim from server/src/upscale/tiling.js (see
// ./tiling.ts, bg2x MIT attribution). The patches arrive as RGB PNGs (colour
// type 2, no alpha) while `blendTile` writes into an RGBA canvas; the decoder
// keeps the interleaved layout and `blendTile` sets alpha to 255 itself, so the
// RGB/RGBA mismatch is handled at the decode boundary: channels 3 -> 4 planes.

import {
  TILE_SIZE,
  TILE_STEP,
  buildBlendWeights,
  blendTile,
  downsampleTile,
} from './tiling';
import { decodePng, encodePngRgbBytes, type DecodedPng } from './png';

export interface TileCoord {
  tx: number;
  ty: number;
}

export interface TilePlan {
  tilesX: number;
  tilesY: number;
  total: number;
  tiles: TileCoord[];
}

/** Same tiling grid as server/src/upscale/infer.js `_inferUpscale`. */
export function planTiles(width: number, height: number): TilePlan {
  const tilesX = Math.max(1, Math.ceil((width - 16) / TILE_STEP));
  const tilesY = Math.max(1, Math.ceil((height - 16) / TILE_STEP));
  const tiles: TileCoord[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) tiles.push({ tx, ty });
  }
  return { tilesX, tilesY, total: tiles.length, tiles };
}

/** Interleaved RGB(A) patch -> planar float32 [0..1] planes (what blendTile wants). */
function toPlanarFloat(dec: DecodedPng): Float32Array {
  if (dec.channels < 3) {
    throw new Error(
      `unexpected patch channels ${dec.channels} (expected RGB or RGBA).`,
    );
  }
  const plane = dec.width * dec.height;
  const out = new Float32Array(3 * plane);
  const inv = 1 / 255;
  const ch = dec.channels;
  const data = dec.data;
  for (let i = 0, p = 0; i < plane; i++, p += ch) {
    out[i] = data[p] * inv;
    out[plane + i] = data[p + 1] * inv;
    out[2 * plane + i] = data[p + 2] * inv;
  }
  return out;
}

export interface StitchOptions {
  width: number;
  height: number;
  /** Model native scale (2 or 4). */
  scale: number;
  /** Effective output scale; defaults to `scale`. */
  targetScale?: number;
  /** Fetch one patch as PNG bytes (from R2). */
  readPatch: (tx: number, ty: number) => Promise<Uint8Array>;
}

export interface StitchResult {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Blend every patch into one canvas and encode it as an RGB PNG.
 *
 * Patches are consumed one at a time (R2 -> decode -> blend -> drop) so peak
 * memory stays at canvas + one patch + the encoded file, even for an 8MP
 * output.
 */
export async function stitchToPngBytes(
  opts: StitchOptions,
): Promise<StitchResult> {
  const { width, height, scale, readPatch } = opts;
  const ts = opts.targetScale ?? scale;
  const downsample = ts < scale;
  const rawFactor = downsample ? scale / ts : 1;
  const blendScale = downsample ? ts : scale;
  const destW = width * ts;
  const destH = height * ts;

  const plan = planTiles(width, height);
  const weights = buildBlendWeights(blendScale);
  // Verbatim blendTile writes RGBA (out[di+3] = 255); canvas keeps that layout.
  const canvas = new Uint8ClampedArray(destW * destH * 4);
  const expectOw = TILE_SIZE * scale;

  for (let ty = 0; ty < plan.tilesY; ty++) {
    const ay = ty === 0 ? weights.full : weights.ramp;
    for (let tx = 0; tx < plan.tilesX; tx++) {
      const png = await readPatch(tx, ty);
      const dec = await decodePng(png);
      if (dec.width !== expectOw || dec.height !== expectOw) {
        throw new Error(
          `patch ${tx},${ty} is ${dec.width}x${dec.height}, expected ${expectOw}x${expectOw}.`,
        );
      }
      let planar = toPlanarFloat(dec);
      if (downsample) planar = downsampleTile(planar, expectOw, rawFactor);
      const ax = tx === 0 ? weights.full : weights.ramp;
      blendTile(
        canvas,
        planar,
        tx * TILE_STEP,
        ty * TILE_STEP,
        destW,
        destH,
        blendScale,
        ax,
        ay,
      );
    }
  }

  return {
    bytes: await encodePngRgbBytes(destW, destH, canvas, 4),
    width: destW,
    height: destH,
  };
}

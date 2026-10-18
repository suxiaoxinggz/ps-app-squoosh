// Minimal, dependency-free PNG codec for the Workers runtime.
//
// The worker has no sharp / canvas / createImageBitmap, so the stitcher needs
// its own PNG reader for the per-tile patches returned by POST /upscale/tile
// (sharp emits 8-bit non-interlaced truecolour, colour type 2 / RGB) and its
// own PNG writer for the final stitched image.
//
// Decoder: 8-bit, non-interlaced, colour types 0/2/4/6 (grey, RGB, grey+alpha,
// RGBA) — enough for every patch sharp produces and useful for tests.
// Encoder: 8-bit truecolour (RGB) from an RGBA byte buffer, streaming so a
// 16MP canvas is never doubled in memory (raw scanlines are fed row by row
// into CompressionStream; IDAT chunks are emitted as they come out).
//
// CompressionStream('deflate') is the zlib (RFC 1950) wrapper, which is exactly
// what PNG IDAT requires.

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function ihdrData(width: number, height: number, colorType: number) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colorType; // 2 = truecolour RGB
  d[10] = 0; // compression: deflate
  d[11] = 0; // filter method: adaptive
  d[12] = 0; // interlace: none
  return d;
}

// ---------------- decode ----------------

export interface DecodedPng {
  width: number;
  height: number;
  /** 1 = grey, 2 = grey+alpha, 3 = RGB, 4 = RGBA */
  channels: number;
  /** Interleaved samples, `channels` bytes per pixel, row-major. */
  data: Uint8Array;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const collected = (async () => {
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        chunks.push(value);
        total += value.length;
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  })();
  await writer.write(data);
  await writer.close();
  return collected;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(
  raw: Uint8Array,
  out: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): void {
  const stride = width * bpp;
  let ri = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ri++];
    const rowStart = y * stride;
    const upStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[ri + i];
      const a = i >= bpp ? out[rowStart + i - bpp] : 0;
      const b = y > 0 ? out[upStart + i] : 0;
      const c = y > 0 && i >= bpp ? out[upStart + i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4:
          v = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filter}`);
      }
      out[rowStart + i] = v & 0xff;
    }
    ri += stride;
  }
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (bytes.length < 8) throw new Error('not a PNG (too short).');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('not a PNG (bad signature).');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let sawIhdr = false;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  while (off + 12 <= bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 4);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(
      bytes[off + 4],
      bytes[off + 5],
      bytes[off + 6],
      bytes[off + 7],
    );
    const dataOff = off + 8;
    if (dataOff + len + 4 > bytes.length) throw new Error('truncated PNG.');
    if (type === 'IHDR') {
      const h = new DataView(bytes.buffer, bytes.byteOffset + dataOff, 13);
      width = h.getUint32(0);
      height = h.getUint32(4);
      bitDepth = bytes[dataOff + 8];
      colorType = bytes[dataOff + 9];
      interlace = bytes[dataOff + 12];
      sawIhdr = true;
    } else if (type === 'IDAT') {
      const d = bytes.subarray(dataOff, dataOff + len);
      idat.push(d);
      idatLen += d.length;
    } else if (type === 'IEND') {
      break;
    }
    off = dataOff + len + 4;
  }
  if (!sawIhdr) throw new Error('PNG missing IHDR.');
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8).`);
  }
  if (interlace !== 0) throw new Error('interlaced PNG is not supported.');
  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 6
            ? 4
            : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}.`);
  if (!width || !height) throw new Error('PNG has zero dimensions.');

  const merged = new Uint8Array(idatLen);
  let mo = 0;
  for (const c of idat) {
    merged.set(c, mo);
    mo += c.length;
  }
  const raw = await inflate(merged);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error('truncated PNG image data.');
  }
  const out = new Uint8Array(stride * height);
  unfilter(raw, out, width, height, channels);
  return { width, height, channels, data: out };
}

// ---------------- encode ----------------

/**
 * Encode an RGB PNG from an RGBA byte buffer (alpha dropped) and return the
 * whole file.
 *
 * The canvas is fed row by row into CompressionStream, so no raw scanline
 * buffer is ever materialised; only the deflate output and the final file are
 * held. R2's `put` needs a known length, which is exactly why the output is
 * collected rather than streamed.
 */
export async function encodePngRgbBytes(
  width: number,
  height: number,
  rgba: Uint8Array,
  srcChannels = 4,
): Promise<Uint8Array> {
  const widthBytes = width * 3;
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        idat.push(value);
        idatLen += value.length;
      }
    }
  })();

  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(1 + widthBytes); // fresh: write() may retain it
    let si = y * width * srcChannels;
    let di = 1;
    for (let x = 0; x < width; x++) {
      row[di++] = rgba[si];
      row[di++] = rgba[si + 1];
      row[di++] = rgba[si + 2];
      si += srcChannels;
    }
    await writer.write(row); // honours deflate backpressure
  }
  await writer.close();
  await pump;

  // One IDAT chunk per deflate output chunk, each with its own 12-byte header.
  const total = 8 + (12 + 13) + (idatLen + 12 * idat.length) + 12;
  const out = new Uint8Array(total);
  out.set(PNG_SIG, 0);
  let off = 8;
  const push = (type: string, data: Uint8Array) => {
    const dv = new DataView(out.buffer);
    dv.setUint32(off, data.length);
    for (let i = 0; i < 4; i++) out[off + 4 + i] = type.charCodeAt(i);
    out.set(data, off + 8);
    dv.setUint32(
      off + 8 + data.length,
      crc32(out.subarray(off + 4, off + 8 + data.length)),
    );
    off += 12 + data.length;
  };
  push('IHDR', ihdrData(width, height, 2));
  for (const c of idat) push('IDAT', c);
  idat.length = 0;
  push('IEND', new Uint8Array(0));
  return out;
}

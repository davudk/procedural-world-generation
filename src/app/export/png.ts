/**
 * Minimal PNG encoder (M9 export): 8-bit RGBA and 16-bit greyscale, per-row adaptive filtering
 * (the usual minimum-sum-of-absolute-differences heuristic) and zlib through the platform's
 * `CompressionStream('deflate')` (which emits RFC 1950 zlib, exactly what IDAT wants).
 */
export type Deflate = (data: Uint8Array) => Promise<Uint8Array>;

export interface PngImage {
  width: number;
  height: number;
  /** 6 = RGBA (8-bit), 0 = greyscale (16-bit). */
  colorType: 0 | 6;
  bitDepth: 8 | 16;
  /** Raw scanlines, big-endian samples, `width × channels × bytesPerSample` bytes per row. */
  pixels: Uint8Array;
  /** tEXt chunks (Latin-1 keys and values). */
  text?: Record<string, string>;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const platformDeflate: Deflate = async (data) => {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** RGBA8 image (e.g. from `readPixels` / `ImageData`) → PNG bytes. */
export function encodeRgba8(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, text?: Record<string, string>, deflate: Deflate = platformDeflate): Promise<Uint8Array> {
  const pixels = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return encodePng({ width, height, colorType: 6, bitDepth: 8, pixels, ...(text ? { text } : {}) }, deflate);
}

/** 16-bit greyscale from integer samples 0…65535 (row-major, row 0 at the top). */
export function encodeGray16(width: number, height: number, samples: Uint16Array, text?: Record<string, string>, deflate: Deflate = platformDeflate): Promise<Uint8Array> {
  if (samples.length !== width * height) return Promise.reject(new Error(`PNG: expected ${width * height} samples, got ${samples.length}`));
  const pixels = new Uint8Array(width * height * 2);
  for (let i = 0; i < samples.length; i++) {
    pixels[2 * i] = samples[i] >>> 8;
    pixels[2 * i + 1] = samples[i] & 0xff;
  }
  return encodePng({ width, height, colorType: 0, bitDepth: 16, pixels, ...(text ? { text } : {}) }, deflate);
}

export async function encodePng(img: PngImage, deflate: Deflate = platformDeflate): Promise<Uint8Array> {
  const { width, height } = img;
  const bpp = (img.colorType === 6 ? 4 : 1) * (img.bitDepth / 8);
  const stride = width * bpp;
  if (img.pixels.length !== stride * height) throw new Error(`PNG: expected ${stride * height} bytes, got ${img.pixels.length}`);
  const filtered = filterRows(img.pixels, stride, height, bpp);
  const idat = await deflate(filtered);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = img.bitDepth;
  ihdr[9] = img.colorType;
  // [10] compression 0, [11] filter method 0, [12] no interlace.

  const chunks: [string, Uint8Array][] = [['IHDR', ihdr]];
  for (const [k, v] of Object.entries(img.text ?? {})) chunks.push(['tEXt', latin1(`${k.slice(0, 79)}\0${v}`)]);
  chunks.push(['IDAT', idat], ['IEND', new Uint8Array(0)]);

  const total = SIGNATURE.length + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let o = SIGNATURE.length;
  for (const [type, data] of chunks) {
    ov.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(data, o + 8);
    ov.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  return out;
}

/** Prefixes each row with the filter type (0–4) whose output has the smallest sum of |signed bytes|. */
function filterRows(px: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = px[row + i];
        const a = i >= bpp ? px[row + i - bpp] : 0;
        const b = prev >= 0 ? px[prev + i] : 0;
        const cc = prev >= 0 && i >= bpp ? px[prev + i - bpp] : 0;
        const v = (x - predict(f, a, b, cc)) & 0xff;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  return out;
}

/** PNG filter predictor for byte `x` with left `a`, up `b`, up-left `c` (filters 0–4). */
export function predict(f: number, a: number, b: number, c: number): number {
  switch (f) {
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >>> 1;
    case 4: {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    default:
      return 0;
  }
}

function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i] = c < 256 ? c : 63; // '?'
  }
  return b;
}

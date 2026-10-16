import type { GlyphMetrics, GlyphSource } from './glyphs';
import { STYLE_WATER, type GlyphStyle } from './labelStyle';
import { ShelfPacker, sdfFromAlpha } from './sdf';

/** Atlas raster font size (px); labels are drawn at ~10–26 CSS px, so ≤ 2.6× minification at DPR 1. */
const FONT_PX = 40;
/** SDF spread (px at FONT_PX): enough for a ~2.5 CSS px halo on the smallest labels. */
const SPREAD = 10;
const BUFFER = SPREAD + 1;
const ATLAS_W = 1024;
const ATLAS_H0 = 512;
const ATLAS_H_MAX = 4096;
const FAMILY = `Georgia, 'Times New Roman', 'Noto Serif', 'DejaVu Serif', 'Liberation Serif', serif`;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Runtime SDF glyph atlas (research 04 §5.2): glyphs are rasterised with Canvas2D at 40 px (upright serif
 * for land, italic serif for water), turned into a signed distance field with an exact EDT (sdf.ts),
 * shelf-packed into a single-channel texture and uploaded incrementally. New characters are added on demand;
 * the atlas grows in height (1024 × 512 → … → 1024 × 4096) and existing glyphs never move.
 */
export class GlyphAtlas implements GlyphSource {
  readonly fontPx = FONT_PX;
  readonly spread = SPREAD;
  readonly width = ATLAS_W;
  height = ATLAS_H0;
  readonly texture: WebGLTexture;
  private data = new Uint8Array(ATLAS_W * ATLAS_H0);
  private readonly packer = new ShelfPacker(ATLAS_W, ATLAS_H0, 1);
  private readonly map = new Map<string, GlyphMetrics>();
  private readonly ctx: Ctx;
  private readonly canvasSize = FONT_PX * 3;
  private dirtyY0 = Infinity;
  private dirtyY1 = -1;
  private resized = true;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const n = this.canvasSize;
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Ctx | null;
    if (!ctx) throw new Error('Canvas2D is not available for the label glyph atlas.');
    this.ctx = ctx;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Number of glyphs rasterised so far. */
  get count(): number {
    return this.map.size;
  }

  glyph(style: GlyphStyle, ch: string): GlyphMetrics {
    const key = style + ch;
    let g = this.map.get(key);
    if (!g) {
      g = this.rasterise(style, ch);
      this.map.set(key, g);
    }
    return g;
  }

  /** Uploads new glyphs (call before drawing; binds TEXTURE_2D on the active unit). */
  flush(): void {
    const gl = this.gl;
    if (!this.resized && this.dirtyY1 < 0) return;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.resized) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.width, this.height, 0, gl.RED, gl.UNSIGNED_BYTE, this.data);
    } else {
      const y0 = this.dirtyY0, y1 = this.dirtyY1;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, this.width, y1 - y0, gl.RED, gl.UNSIGNED_BYTE, this.data.subarray(y0 * this.width, y1 * this.width));
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.resized = false;
    this.dirtyY0 = Infinity;
    this.dirtyY1 = -1;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }

  private rasterise(style: GlyphStyle, ch: string): GlyphMetrics {
    const ctx = this.ctx;
    ctx.font = `${style === STYLE_WATER ? 'italic ' : ''}${FONT_PX}px ${FAMILY}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const m = ctx.measureText(ch);
    const advance = m.width;
    const left = Math.ceil(m.actualBoundingBoxLeft);
    const right = Math.ceil(m.actualBoundingBoxRight);
    const asc = Math.ceil(m.actualBoundingBoxAscent);
    const desc = Math.ceil(m.actualBoundingBoxDescent);
    const gw = Math.min(this.canvasSize - 2 * BUFFER, left + right);
    const gh = Math.min(this.canvasSize - 2 * BUFFER, asc + desc);
    const empty: GlyphMetrics = { ax: 0, ay: 0, aw: 0, ah: 0, left: 0, top: 0, advance };
    if (gw <= 0 || gh <= 0 || ch.trim() === '') return empty;
    const w = gw + 2 * BUFFER, h = gh + 2 * BUFFER;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillText(ch, BUFFER + left, BUFFER + asc);
    const img = ctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = img[4 * i + 3];
    const sdf = sdfFromAlpha(alpha, w, h, SPREAD);
    let pos = this.packer.pack(w, h);
    while (!pos && this.height < ATLAS_H_MAX) {
      this.grow();
      pos = this.packer.pack(w, h);
    }
    if (!pos) return empty; // atlas full: draw nothing for this character
    for (let y = 0; y < h; y++) this.data.set(sdf.subarray(y * w, (y + 1) * w), (pos.y + y) * this.width + pos.x);
    this.dirtyY0 = Math.min(this.dirtyY0, pos.y);
    this.dirtyY1 = Math.max(this.dirtyY1, pos.y + h);
    return { ax: pos.x, ay: pos.y, aw: w, ah: h, left: -left - BUFFER, top: -asc - BUFFER, advance };
  }

  private grow(): void {
    const h = Math.min(ATLAS_H_MAX, this.height * 2);
    const d = new Uint8Array(this.width * h);
    d.set(this.data);
    this.data = d;
    this.height = h;
    this.packer.resize(this.width, h);
    this.resized = true;
  }
}

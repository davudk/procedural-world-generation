import type { GlyphStyle } from './labelStyle';

/** Metrics of one atlas glyph; all lengths in atlas px at the atlas font size (`GlyphSource.fontPx`). */
export interface GlyphMetrics {
  /** Atlas rectangle (px); aw = ah = 0 for glyphs without ink (space). */
  ax: number;
  ay: number;
  aw: number;
  ah: number;
  /** Offset of the bitmap's top-left corner from the pen position on the baseline (y down). */
  left: number;
  top: number;
  /** Horizontal advance. */
  advance: number;
}

/** Provides glyph metrics, rasterising new glyphs on demand (implemented by GlyphAtlas; faked in tests). */
export interface GlyphSource {
  readonly fontPx: number;
  /** SDF spread in atlas px (value 0.5 at the edge, 0/1 at ±spread). */
  readonly spread: number;
  glyph(style: GlyphStyle, ch: string): GlyphMetrics;
}

/** Splits a string into user-perceived characters (code points; combining marks stay attached). */
export function glyphChars(text: string): string[] {
  const out: string[] = [];
  for (const ch of text.normalize('NFC')) {
    if (out.length > 0 && /\p{M}/u.test(ch)) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

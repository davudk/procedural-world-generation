import type { Landmark, LandmarkKind } from '../../shared/landmarks';

/** Glyph styles in the atlas. */
export const STYLE_LAND = 0; // upright serif
export const STYLE_WATER = 1; // italic serif
export type GlyphStyle = typeof STYLE_LAND | typeof STYLE_WATER;

/** How a label is laid out on screen. */
export type LabelMode = 'point' | 'rotated' | 'path';

export interface LabelStyle {
  style: GlyphStyle;
  /** Upper case (cartographic convention for ranges, continents, seas). */
  caps: boolean;
  /** Extra space between letters, in em. */
  letterSpacingEm: number;
  /** Font size in CSS px. */
  sizePx: number;
  mode: LabelMode;
  /** Vertical offset of the text centre from the anchor, in em (negative = above), for point symbols. */
  offsetEm: number;
  /** Hero emphasis: slightly bolder and larger. */
  emphasis: number;
}

const WATER: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['river', 'lake', 'ocean', 'sea', 'bay', 'gulf', 'strait', 'fjord', 'lagoon', 'reef']);
const CAPS: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['continent', 'range', 'ocean', 'sea']);
/** Point symbols whose name sits above the point instead of covering it. */
const ABOVE: ReadonlySet<LandmarkKind> = new Set<LandmarkKind>(['peak', 'hill', 'pass', 'volcano', 'waterfall', 'cape', 'caldera', 'crater']);

/** [min, max] font size (CSS px) by kind, interpolated by importance. */
function sizeRange(kind: LandmarkKind): [number, number] {
  switch (kind) {
    case 'continent': return [17, 26];
    case 'ocean': return [16, 24];
    case 'sea': return [13, 19];
    case 'range': return [11.5, 17];
    case 'island': case 'archipelago': case 'gulf': case 'desert': case 'erg': case 'icecap': case 'plateau': case 'grassland': return [11.5, 16];
    case 'river': case 'fjord': case 'strait': return [11, 14.5];
    default: return [11, 14.5];
  }
}

export function isWaterKind(kind: LandmarkKind): boolean {
  return WATER.has(kind);
}

export function labelStyle(l: Landmark): LabelStyle {
  const caps = CAPS.has(l.kind);
  const [lo, hi] = sizeRange(l.kind);
  const imp = Math.min(1, Math.max(0, l.importance));
  let sizePx = lo + (hi - lo) * Math.sqrt(imp);
  if (l.hero) sizePx *= 1.1;
  let letterSpacingEm = 0.02;
  if (l.kind === 'range') letterSpacingEm = 0.32;
  else if (l.kind === 'continent' || l.kind === 'ocean') letterSpacingEm = 0.24;
  else if (caps) letterSpacingEm = 0.14;
  else if (l.kind === 'river' || l.kind === 'fjord' || l.kind === 'strait') letterSpacingEm = 0.06;
  let mode: LabelMode = 'point';
  if (l.path && l.path.length >= 4 && (l.kind === 'river' || l.kind === 'fjord' || l.kind === 'strait' || l.kind === 'canyon' || l.kind === 'gorge' || l.kind === 'rift')) mode = 'path';
  else if (Number.isFinite(l.angle)) mode = 'rotated';
  return {
    style: WATER.has(l.kind) ? STYLE_WATER : STYLE_LAND,
    caps,
    letterSpacingEm,
    sizePx,
    mode,
    offsetEm: ABOVE.has(l.kind) ? -0.85 : 0,
    emphasis: l.hero ? 1 : 0,
  };
}

/** Text shown for a landmark under a style. */
export function labelText(l: Landmark, s: LabelStyle): string {
  const t = l.name.trim();
  return s.caps ? t.toLocaleUpperCase() : t;
}

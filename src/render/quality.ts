/**
 * Render quality tiers (M9 mobile pass, research 04 §8.5). Phones and tablets share a few hundred MB
 * of GPU memory per tab with everything else and run hot at DPR 3, so they draw fewer pixels, skip
 * MSAA, build a 2048² detail map and select coarser CDLOD nodes. The choice is a pure function of a
 * device probe so it can be unit-tested; `probeDevice` reads the probe in the browser.
 */
export type QualityTier = 'high' | 'medium' | 'low';
export type QualityChoice = 'auto' | QualityTier;

export interface DeviceProbe {
  devicePixelRatio: number;
  /** `(pointer: coarse)` matches: the primary input is a finger. */
  coarsePointer: boolean;
  /** Smaller side of the screen in CSS px. */
  minScreenCss: number;
  /** `navigator.deviceMemory` in GB (Chromium only, capped at 8), or null. */
  deviceMemoryGB: number | null;
  /** Unmasked GL renderer string when available (e.g. "Adreno (TM) 740", "Apple GPU"). */
  renderer: string;
  /** `navigator.userAgentData.mobile`, or a UA sniff fallback. */
  mobileUA: boolean;
}

export interface QualitySettings {
  tier: QualityTier;
  /** Cap on the drawing-buffer pixels per CSS px (DPR × render scale). */
  maxPixelRatio: number;
  /** Render scale on very dense screens (DPR ≥ 2.5): 0.75 on mobile, so DPR 3 draws 2.25 px per CSS px. */
  denseScale: number;
  /** MSAA samples for the scene framebuffer (0 = off). */
  msaa: number;
  /** Largest close-zoom detail map (texels per side). */
  maxDetail: 2048 | 4096;
  /** CDLOD: target on-screen size of one grid cell (larger → fewer, coarser nodes). */
  vertexPx: number;
  /** Frame-rate cap while nothing moves (animated water keeps ticking at this rate). */
  idleFps: number;
}

/** GPU families found only in phones and tablets. "Apple GPU" is not here: Safari on a Mac reports it too. */
const MOBILE_GPU = /\b(adreno|mali|powervr|immortalis|xclipse|videocore|sgx)\b/i;

/** Picks the tier for a device: touch-first, mobile GPUs and ≤ 2 GB devices are `low`, ≤ 4 GB `medium`. */
export function autoTier(p: DeviceProbe): QualityTier {
  const mobile = p.mobileUA || MOBILE_GPU.test(p.renderer) || (p.coarsePointer && p.minScreenCss <= 1100);
  if (mobile || (p.deviceMemoryGB !== null && p.deviceMemoryGB <= 2)) return 'low';
  if (p.deviceMemoryGB !== null && p.deviceMemoryGB <= 4) return 'medium';
  return 'high';
}

export function qualitySettings(tier: QualityTier): QualitySettings {
  switch (tier) {
    case 'low':
      return { tier, maxPixelRatio: 2.25, denseScale: 0.75, msaa: 0, maxDetail: 2048, vertexPx: 4, idleFps: 30 };
    case 'medium':
      return { tier, maxPixelRatio: 1.5, denseScale: 1, msaa: 2, maxDetail: 2048, vertexPx: 3.5, idleFps: 30 };
    case 'high':
      return { tier, maxPixelRatio: 2, denseScale: 1, msaa: 4, maxDetail: 4096, vertexPx: 3, idleFps: 30 };
  }
}

/** Settings for a user choice (`auto` resolves through `autoTier`). */
export function pickQuality(choice: QualityChoice, p: DeviceProbe): QualitySettings {
  return qualitySettings(choice === 'auto' ? autoTier(p) : choice);
}

/** Drawing-buffer pixels per CSS px for the current DPR (which changes when a window moves between screens). */
export function pixelRatio(q: QualitySettings, dpr: number): number {
  const d = Math.max(1, dpr || 1);
  return Math.min(q.maxPixelRatio, d >= 2.5 ? d * q.denseScale : d);
}

export function parseQualityChoice(s: string | null | undefined): QualityChoice | null {
  return s === 'auto' || s === 'high' || s === 'medium' || s === 'low' ? s : null;
}

/** Reads the probe in the browser (the GL context supplies the renderer string). */
export function probeDevice(gl: WebGL2RenderingContext | null): DeviceProbe {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  let renderer = '';
  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  }
  const mobileUA = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
  return {
    devicePixelRatio: window.devicePixelRatio || 1,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    minScreenCss: Math.min(screen.width, screen.height),
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    renderer,
    mobileUA,
  };
}

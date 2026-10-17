import type { Vec3 } from './ground';

/**
 * What the input controller, the compass and the 3D view need from a camera: the flat `OrbitCamera`
 * and the sphere's `GlobeCamera` both implement it (research 10 §6.4), so gestures, keys and the
 * compass work unchanged on both shapes. Screen coordinates are CSS px from the canvas top-left.
 */
export interface ViewCamera {
  viewW: number;
  viewH: number;
  readonly fovY: number;
  /** 0 = looking straight down. */
  readonly pitch: number;
  /** Compass heading the camera faces (0 = north up, positive clockwise). */
  readonly bearing: number;
  /** World point under a screen pixel (in the camera's world space), or null. */
  pick(sx: number, sy: number): Vec3 | null;
  /** Grab pan: moves the view so that world point `p` appears under (sx, sy). */
  dragTo(p: Vec3, sx: number, sy: number): void;
  /** Pans by metres along the screen axes on the ground. */
  panBy(right: number, forward: number): void;
  panScreen(dx: number, dy: number, sx?: number, sy?: number): void;
  zoomAt(sx: number, sy: number, factor: number): void;
  pinchAt(sx: number, sy: number, factor: number): void;
  rotateBy(dBearing: number, dPitch: number): void;
  rotateAt(sx: number, sy: number, dBearing: number): void;
  resetNorth(): void;
  /** Whole world (or planet) in view, north up. */
  fitWorld(): void;
  metresPerPixel(): number;
}

/**
 * Hands the canvas's CSS size to the cameras. A hidden or collapsed page reports 0 × 0 (or one zero
 * side); the cameras divide by both sides (aspect, metres per pixel, fit distance), so a zero would
 * turn the distance and target into NaN and, through the footprint, every detailed ground height.
 * Such sizes are skipped and the cameras keep the last real one. Returns true when a size was applied.
 */
export function applyViewSize(cams: readonly ViewCamera[], w: number, h: number): boolean {
  if (!(w >= 1 && h >= 1 && Number.isFinite(w) && Number.isFinite(h))) return false;
  for (const c of cams) {
    c.viewW = w;
    c.viewH = h;
  }
  return true;
}

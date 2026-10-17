import { surfaceDir } from '../shared/cube';
import type { Landmark } from '../shared/landmarks';

/**
 * Landmark helpers for the app on both world shapes: where to fly for a landmark, the inspector's
 * "nearest named place" and coordinates for the Atlas. Sphere landmarks carry (face, u, v)
 * (shared/landmarks.ts), converted with the planet radius; flat ones are map metres.
 */

/** Eye distance that frames a landmark: its extent spans about half the screen height. */
export function frameDistance(l: Landmark, fovY: number): number {
  return Math.max(9000, (l.extentM * 2) / (2 * Math.tan(fovY / 2)));
}

/** Unit vector of a sphere landmark's anchor (null for flat landmarks). */
export function landmarkDir(l: Landmark, radiusM: number): { x: number; y: number; z: number } | null {
  if (l.face === undefined) return null;
  const d = new Float64Array(3);
  surfaceDir(l.face, l.x, l.y, radiusM, d);
  return { x: d[0], y: d[1], z: d[2] };
}

/** "62.4° N, 14.1° E" (one decimal). */
export function latLonText(lat: number, lon: number, digits = 1): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** Latitude / longitude text of a sphere landmark, or '' for flat ones. */
export function landmarkLatLon(l: Landmark, radiusM: number): string {
  const d = landmarkDir(l, radiusM);
  if (!d) return '';
  return latLonText((Math.asin(Math.max(-1, Math.min(1, d.z))) * 180) / Math.PI, (Math.atan2(d.y, d.x) * 180) / Math.PI);
}

/** Score of a landmark at distance d (m) from the inspected point: the most important one whose extent covers it wins. */
function coverScore(l: Landmark, d: number): number {
  const r = Math.max(2000, l.extentM * 0.6);
  return d > r ? 0 : l.importance * (1 - d / r) + 0.001;
}

/** The most important landmark whose extent covers a flat map point (metres). */
export function nearestLandmark(list: readonly Landmark[], xm: number, ym: number): Landmark | null {
  let best: Landmark | null = null;
  let bestScore = 0;
  for (const l of list) {
    if (l.face !== undefined) continue;
    const s = coverScore(l, Math.hypot(l.x - xm, l.y - ym));
    if (s > bestScore) {
      bestScore = s;
      best = l;
    }
  }
  return best;
}

/** The same on a sphere: p is any vector toward the point, distances along the surface. */
export function nearestLandmarkOnGlobe(list: readonly Landmark[], p: { x: number; y: number; z: number }, radiusM: number): Landmark | null {
  const r = Math.hypot(p.x, p.y, p.z) || 1;
  const px = p.x / r, py = p.y / r, pz = p.z / r;
  const d = new Float64Array(3);
  let best: Landmark | null = null;
  let bestScore = 0;
  for (const l of list) {
    if (l.face === undefined) continue;
    surfaceDir(l.face, l.x, l.y, radiusM, d);
    const c = px * d[0] + py * d[1] + pz * d[2];
    const s = coverScore(l, radiusM * Math.acos(Math.max(-1, Math.min(1, c))));
    if (s > bestScore) {
      bestScore = s;
      best = l;
    }
  }
  return best;
}

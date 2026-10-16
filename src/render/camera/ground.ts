/**
 * 3D world space (M2+): metres, x east, y north, z up (right-handed). The world covers
 * [0, size] × [0, size]; raster row 0 is the NORTH edge, so map row r ↔ y = size − (r + 0.5)·cell.
 * Rendered heights include the current vertical exaggeration.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What the camera needs to know about the terrain (implemented by render/heightField.ts). */
export interface GroundQuery {
  /** World width in metres. */
  readonly size: number;
  /** Rendered terrain height (m, exaggeration applied; water surface where above terrain). */
  heightAt(x: number, y: number): number;
  /** First intersection of the ray o + t·d (t ≥ 0) with the rendered surface, or null. */
  raycast(o: Vec3, d: Vec3): Vec3 | null;
}

/** Converts between map coordinates (km from the top-left, y down; used by the 2D viewer and
 * layers) and 3D world metres (y north). */
export function mapKmToWorld(xKm: number, yKm: number, size: number): { x: number; y: number } {
  return { x: xKm * 1000, y: size - yKm * 1000 };
}

export function worldToMapKm(x: number, y: number, size: number): { xKm: number; yKm: number } {
  return { xKm: x / 1000, yKm: (size - y) / 1000 };
}

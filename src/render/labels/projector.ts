import type { Vec3 } from '../camera/ground';

/** The camera state labels need (OrbitCamera and GlobeCamera satisfy it). */
export interface LabelCamera {
  eye(): Vec3;
  readonly pitch: number;
  readonly bearing: number;
  readonly fovY: number;
  viewW: number;
  viewH: number;
  metresPerPixel(): number;
  /**
   * Screen right, screen up and view direction in world space, when the camera has its own frame
   * (the globe camera: planet-centred, the frame turns with the target). Without it the flat
   * camera's z-up basis is derived from pitch and bearing.
   */
  axes?(): { r: Vec3; u: Vec3; f: Vec3 };
}

/**
 * Per-frame cached copy of OrbitCamera.project (same basis and maths, without recomputing the eye and the
 * trigonometry for every point). World coordinates (x east, y north, z up, metres; on a globe
 * planet-centred metres in the camera's own frame) → CSS px.
 */
export class Projector {
  ex = 0; ey = 0; ez = 0;
  rx = 1; ry = 0; rz = 0;
  ux = 0; uy = 1; uz = 0;
  fx = 0; fy = 0; fz = -1;
  private tx = 1; private ty = 1;
  w = 1; h = 1;
  /** Metres per pixel per metre of depth: 2·tan(fov/2) / viewH. */
  pxScale = 1;
  /** Last projected point: screen x, y (CSS px) and view depth (m). */
  sx = 0; sy = 0; depth = 0;

  update(cam: LabelCamera): void {
    const e = cam.eye();
    this.ex = e.x; this.ey = e.y; this.ez = e.z;
    if (cam.axes) {
      const { r, u, f } = cam.axes();
      this.rx = r.x; this.ry = r.y; this.rz = r.z;
      this.ux = u.x; this.uy = u.y; this.uz = u.z;
      this.fx = f.x; this.fy = f.y; this.fz = f.z;
    } else {
      const sb = Math.sin(cam.bearing), cb = Math.cos(cam.bearing);
      const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
      this.rx = cb; this.ry = -sb; this.rz = 0;
      this.ux = sb * cp; this.uy = cb * cp; this.uz = sp;
      this.fx = sb * sp; this.fy = cb * sp; this.fz = -cp;
    }
    this.w = cam.viewW;
    this.h = cam.viewH;
    this.ty = Math.tan(cam.fovY / 2);
    this.tx = this.ty * (cam.viewW / cam.viewH);
    this.pxScale = (2 * this.ty) / Math.max(1, cam.viewH);
  }

  /** Projects into (sx, sy, depth); false when the point is behind the eye (closer than `minDepth`). */
  project(x: number, y: number, z: number, minDepth = 1e-3): boolean {
    const px = x - this.ex, py = y - this.ey, pz = z - this.ez;
    const depth = px * this.fx + py * this.fy + pz * this.fz;
    this.depth = depth;
    if (!(depth > minDepth)) return false;
    const nx = (px * this.rx + py * this.ry + pz * this.rz) / depth / this.tx;
    const ny = (px * this.ux + py * this.uy + pz * this.uz) / depth / this.ty;
    this.sx = (nx + 1) * 0.5 * this.w;
    this.sy = (1 - ny) * 0.5 * this.h;
    return true;
  }

  /** Metres per CSS pixel at the last projected point. */
  mppAtDepth(depth = this.depth): number {
    return depth * this.pxScale;
  }
}

import type { Layer } from '../shared/protocol';
import { projectSphereLayer } from './sphereProjection';
import type { GlobeCamera } from './camera/globeCamera';

const W = 168;
const H = 84;

/**
 * Minimap for sphere worlds (research 10 §6.8, its second mode): a small equirectangular map with
 * the camera footprint, traced along the screen border on the sphere (rays past the limb take the
 * nearest limb point) and split where it crosses the antimeridian. Click or drag to fly there.
 */
export class GlobeMinimap {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private base: ImageData | null = null;
  private dragging = false;
  private readonly dpr: number;

  constructor(parent: HTMLElement, private readonly cam: GlobeCamera) {
    this.el = document.createElement('canvas');
    this.el.className = 'minimap minimap-globe';
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.el.width = W * this.dpr;
    this.el.height = H * this.dpr;
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
    this.el.hidden = true;
    parent.prepend(this.el);
    this.ctx = this.el.getContext('2d')!;
    const go = (e: PointerEvent): void => {
      const r = this.el.getBoundingClientRect();
      const lon = ((e.clientX - r.left) / r.width) * 360 - 180;
      const lat = 90 - ((e.clientY - r.top) / r.height) * 180;
      this.cam.flyToLatLon(Math.max(-89.5, Math.min(89.5, lat)), lon);
    };
    this.el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.el.setPointerCapture(e.pointerId);
      go(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (this.dragging) go(e);
    });
    this.el.addEventListener('pointerup', () => (this.dragging = false));
  }

  /** Builds the shaded-relief thumbnail from a six-face elevation layer. */
  setTerrain(layer: Layer): void {
    const eq = projectSphereLayer(layer, 'equirect');
    const w = this.el.width;
    const h = this.el.height;
    const img = this.ctx.createImageData(w, h);
    const d = eq.data;
    const cellM = (eq.worldKm * 1000) / eq.w;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(eq.h - 2, Math.floor((y / h) * eq.h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(eq.w - 2, Math.floor((x / w) * eq.w));
        const v = d[sy * eq.w + sx];
        const dx = (d[sy * eq.w + sx + 1] - v) / cellM;
        const dy = (d[(sy + 1) * eq.w + sx] - v) / cellM;
        const shade = v > 0 ? Math.min(1.4, Math.max(0.45, 1 - 6 * (dx + dy))) : 1;
        const [r, g, b] = color(v);
        const o = (y * w + x) * 4;
        img.data[o] = r * shade;
        img.data[o + 1] = g * shade;
        img.data[o + 2] = b * shade;
        img.data[o + 3] = 255;
      }
    }
    this.base = img;
  }

  draw(): void {
    if (!this.base || this.el.hidden) return;
    const c = this.ctx;
    const w = this.el.width;
    const h = this.el.height;
    c.putImageData(this.base, 0, 0);
    const cam = this.cam;
    const R = cam.radius;
    const pts: [number, number][] = [];
    const K = 12;
    const edge = (x0: number, y0: number, x1: number, y1: number): void => {
      for (let i = 0; i < K; i++) {
        const t = i / K;
        const p = cam.sphereHit(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, R);
        const r = Math.hypot(p.x, p.y, p.z);
        const lat = Math.asin(p.z / r);
        const lon = Math.atan2(p.y, p.x);
        pts.push([((lon / Math.PI + 1) / 2) * w, (0.5 - lat / Math.PI) * h]);
      }
    };
    const vw = cam.viewW, vh = cam.viewH;
    edge(0, 0, vw, 0);
    edge(vw, 0, vw, vh);
    edge(vw, vh, 0, vh);
    edge(0, vh, 0, 0);
    c.lineWidth = Math.max(1, w / 160);
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.beginPath();
    pts.forEach(([x, y], i) => {
      const prev = pts[(i + pts.length - 1) % pts.length];
      // Break the line where it wraps around the antimeridian.
      if (i === 0 || Math.abs(x - prev[0]) > w / 2) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    const [x0, y0] = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(x0 - last[0]) <= w / 2) c.lineTo(x0, y0);
    c.stroke();
    const [lat, lon] = cam.latLon();
    c.fillStyle = 'rgba(255,255,255,0.95)';
    c.beginPath();
    c.arc(((lon + 180) / 360) * w, ((90 - lat) / 180) * h, 2 * this.dpr, 0, 2 * Math.PI);
    c.fill();
  }
}

function color(h: number): [number, number, number] {
  if (h < 0) {
    const t = Math.min(1, -h / 5000) ** 0.45;
    return [84 - 74 * t, 158 - 128 * t, 189 - 120 * t];
  }
  const stops: [number, number, number, number][] = [
    [0, 92, 140, 84], [400, 140, 163, 97], [1200, 199, 179, 120], [2500, 143, 112, 87], [4000, 191, 186, 184], [6000, 247, 247, 250],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (h <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = (h - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  return [247, 247, 250];
}

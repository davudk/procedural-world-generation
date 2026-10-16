import type { Layer } from '../shared/protocol';
import { DRY } from './heightField';
import type { OrbitCamera } from './camera/orbitCamera';

const SIZE = 168;

/**
 * Minimap (research 04 §7.4): a shaded-relief thumbnail rendered once per elevation update, with the
 * camera footprint drawn every frame. Click or drag to fly there.
 */
export class Minimap {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private base: ImageData | null = null;
  private worldM = 1;
  private dragging = false;

  constructor(parent: HTMLElement, private readonly cam: OrbitCamera) {
    this.el = document.createElement('canvas');
    this.el.className = 'minimap';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.el.width = SIZE * dpr;
    this.el.height = SIZE * dpr;
    this.el.style.width = `${SIZE}px`;
    this.el.style.height = `${SIZE}px`;
    parent.prepend(this.el);
    this.ctx = this.el.getContext('2d')!;
    const go = (e: PointerEvent): void => {
      const r = this.el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * this.worldM;
      const y = this.worldM - ((e.clientY - r.top) / r.height) * this.worldM;
      this.cam.flyTo(x, y);
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

  setTerrain(layer: Layer, water: Layer | null = null): void {
    const wl = water && water.w === layer.w ? water.data : null;
    const W = this.el.width;
    const img = this.ctx.createImageData(W, W);
    const n = layer.w;
    const d = layer.data;
    const cell = (layer.worldKm * 1000) / n;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const sx = Math.min(n - 2, Math.floor((x / W) * n));
        const sy = Math.min(n - 2, Math.floor((y / W) * n));
        const h0 = d[sy * n + sx];
        const lvl = wl ? wl[sy * n + sx] : DRY - 1;
        // Lakes: colour as water by depth below their level.
        const h = lvl > DRY && lvl > h0 && h0 >= 0 ? -Math.min(400, lvl - h0) * 3 : h0;
        const dx = (d[sy * n + sx + 1] - h) / cell;
        const dy = (d[(sy + 1) * n + sx] - h) / cell;
        const shade = h > 0 ? Math.min(1.4, Math.max(0.45, 1 - 6 * (dx + dy))) : 1;
        const [r, g, b] = color(h);
        const o = (y * W + x) * 4;
        img.data[o] = r * shade;
        img.data[o + 1] = g * shade;
        img.data[o + 2] = b * shade;
        img.data[o + 3] = 255;
      }
    }
    this.base = img;
    this.worldM = layer.worldKm * 1000;
  }

  /** Redraws the thumbnail and the camera footprint (call once per frame). */
  draw(): void {
    if (!this.base) return;
    const c = this.ctx;
    const W = this.el.width;
    c.putImageData(this.base, 0, 0);
    const cam = this.cam;
    const pts: [number, number][] = [];
    const corners: [number, number][] = [[0, 0], [cam.viewW, 0], [cam.viewW, cam.viewH], [0, cam.viewH]];
    for (const [sx, sy] of corners) {
      const p = cam.planeHit(sx, sy, 0);
      if (p) pts.push([(p.x / this.worldM) * W, (1 - p.y / this.worldM) * W]);
    }
    if (pts.length < 3) return;
    c.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
    c.closePath();
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fill();
    c.lineWidth = Math.max(1, W / 160);
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.stroke();
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

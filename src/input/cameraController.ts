import type { Camera } from '../render/camera2d';

const PAN_SPEED_PX = 1100; // CSS px / second at any zoom
const EDGE_PX = 8;
const ZOOM_STEP = 0.0016;  // mouse wheel, per delta pixel
const PINCH_STEP = 0.01;   // trackpad pinch (ctrl+wheel), per delta pixel
const GESTURE_GAP_MS = 140; // wheel events closer than this belong to the same gesture
const ZOOM_EASE = 18;      // 1/s, exponential approach to target zoom

/**
 * Map camera input (ported from pathfinding-demo): trackpad two-finger pan, pinch zoom (ctrl+wheel, and
 * Safari gesture events), smooth mouse-wheel zoom anchored at the cursor, left- or middle-drag grab pan,
 * and arrow keys. Screen-edge pan exists but is off by default.
 */
export class CameraController {
  private readonly keys = new Set<string>();
  private pointerInside = false;
  private px = 0;
  private py = 0;
  private dragging = false;
  private dragWorldX = 0;
  private dragWorldY = 0;
  private zoomTarget: number;
  private zoomAnchorX = 0;
  private zoomAnchorY = 0;
  private lastWheelAt = -Infinity;
  private lastWheelKind: 'mouse' | 'trackpad' = 'mouse';
  edgePan = false;
  /** Set while touch pointers are down: iOS also reports the pinch as gesture events, which must not zoom twice. */
  touching = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cam: Camera,
    private readonly bounds: () => { w: number; h: number },
  ) {
    this.zoomTarget = cam.zoom;
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerenter', () => { this.pointerInside = true; });
    canvas.addEventListener('pointerleave', () => { this.pointerInside = false; });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.installSafariGestures();
    window.addEventListener('keydown', (e) => {
      if (!isTypingTarget(e.target)) this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointerInside = false;
    });
  }

  /** Jumps the camera (e.g. minimap click, control-group double tap). */
  centerOn(x: number, y: number): void {
    this.cam.centerX = x;
    this.cam.centerY = y;
  }

  setZoom(z: number): void {
    this.zoomTarget = z;
    this.cam.zoom = z;
  }

  /** Touch grab pan: moves the world with the finger by a screen-space delta. */
  panScreen(dx: number, dy: number): void {
    this.cam.centerX -= dx / this.cam.zoom;
    this.cam.centerY -= dy / this.cam.zoom;
  }

  /** Touch pinch: scales the zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  pinchAt(sx: number, sy: number, factor: number): void {
    const z = this.clampZoom(this.cam.zoom * factor);
    this.cam.zoomAt(sx, sy, z);
    this.zoomTarget = z;
  }

  update(dtSec: number): void {
    const cam = this.cam;
    // Smooth zoom toward target, keeping the anchor world point fixed under the cursor.
    if (Math.abs(this.zoomTarget - cam.zoom) > 1e-4 * cam.zoom) {
      const k = 1 - Math.exp(-ZOOM_EASE * dtSec);
      cam.zoomAt(this.zoomAnchorX, this.zoomAnchorY, cam.zoom + (this.zoomTarget - cam.zoom) * k);
    }

    if (!this.dragging) {
      let dx = 0;
      let dy = 0;
      const k = this.keys;
      if (k.has('ArrowLeft')) dx -= 1;
      if (k.has('ArrowRight')) dx += 1;
      if (k.has('ArrowUp')) dy -= 1;
      if (k.has('ArrowDown')) dy += 1;
      if (this.edgePan && this.pointerInside && document.hasFocus()) {
        if (this.px <= EDGE_PX) dx -= 1;
        if (this.px >= cam.viewW - EDGE_PX) dx += 1;
        if (this.py <= EDGE_PX) dy -= 1;
        if (this.py >= cam.viewH - EDGE_PX) dy += 1;
      }
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        const step = (PAN_SPEED_PX * dtSec) / cam.zoom / len;
        cam.centerX += dx * step;
        cam.centerY += dy * step;
      }
    }
    const b = this.bounds();
    cam.clampTo(b.w, b.h);
  }

  private readonly onMove = (e: PointerEvent): void => {
    this.pointerInside = true;
    this.px = e.offsetX;
    this.py = e.offsetY;
    if (this.dragging) {
      // Grab: keep the world point under the cursor.
      this.cam.centerX = this.dragWorldX - (e.offsetX - this.cam.viewW * 0.5) / this.cam.zoom;
      this.cam.centerY = this.dragWorldY - (e.offsetY - this.cam.viewH * 0.5) / this.cam.zoom;
    }
  };

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    this.dragging = true;
    this.dragWorldX = this.cam.screenToWorldX(e.offsetX);
    this.dragWorldY = this.cam.screenToWorldY(e.offsetY);
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return;
    this.dragging = false;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  /**
   * Wheel input. macOS trackpads send two-finger scroll as plain wheel events (→ pan) and
   * pinch as ctrl+wheel (→ zoom); a physical mouse wheel zooms. See `classifyWheel`.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const now = performance.now();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cam.viewH : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;

    if (e.ctrlKey) {
      // Pinch (or ctrl + mouse wheel): apply immediately so it tracks the fingers.
      const z = this.clampZoom(this.cam.zoom * Math.exp(-dy * PINCH_STEP));
      this.cam.zoomAt(e.offsetX, e.offsetY, z);
      this.zoomTarget = z;
      return;
    }

    // A gesture keeps its classification for its whole event stream (including momentum).
    const kind = now - this.lastWheelAt < GESTURE_GAP_MS ? this.lastWheelKind : classifyWheel(e);
    this.lastWheelAt = now;
    this.lastWheelKind = kind;

    if (kind === 'trackpad') {
      this.cam.centerX += dx / this.cam.zoom;
      this.cam.centerY += dy / this.cam.zoom;
      return;
    }
    this.zoomTarget = this.clampZoom(this.zoomTarget * Math.exp(-dy * ZOOM_STEP));
    this.zoomAnchorX = e.offsetX;
    this.zoomAnchorY = e.offsetY;
  };

  /** Safari pinch arrives as non-standard gesture events; block page zoom and map scale to camera zoom. */
  private installSafariGestures(): void {
    let startZoom = 1;
    let ax = 0;
    let ay = 0;
    type GestureEv = Event & { scale: number; clientX: number; clientY: number };
    this.canvas.addEventListener('gesturestart', (ev) => {
      ev.preventDefault();
      if (this.touching) return;
      const g = ev as GestureEv;
      startZoom = this.cam.zoom;
      const r = this.canvas.getBoundingClientRect();
      ax = g.clientX - r.left;
      ay = g.clientY - r.top;
    });
    this.canvas.addEventListener('gesturechange', (ev) => {
      ev.preventDefault();
      if (this.touching) return;
      const z = this.clampZoom(startZoom * (ev as GestureEv).scale);
      this.cam.zoomAt(ax, ay, z);
      this.zoomTarget = z;
    });
    this.canvas.addEventListener('gestureend', (ev) => ev.preventDefault());
  }

  private clampZoom(z: number): number {
    return Math.min(this.cam.maxZoom, Math.max(this.cam.minZoom, z));
  }
}

/**
 * Mouse wheel vs trackpad scroll (same heuristics as Mapbox GL): line/page delta modes and
 * macOS mouse deltas (multiples of 4.000244140625) are wheels; horizontal motion or small /
 * fractional deltas are trackpads; whole-number notches of ≥ 100 px are wheels.
 */
export function classifyWheel(e: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>): 'mouse' | 'trackpad' {
  if (e.deltaMode !== 0) return 'mouse';
  if (e.deltaX !== 0) return 'trackpad';
  const dy = e.deltaY;
  if (dy !== 0 && dy % 4.000244140625 === 0) return 'mouse';
  if (Number.isInteger(dy) && Math.abs(dy) >= 100) return 'mouse';
  return 'trackpad';
}

export function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

import type { Vec3 } from '../render/camera/ground';
import type { ViewCamera } from '../render/camera/viewCamera';
import { classifyWheel, isTypingTarget } from './cameraController';

const ZOOM_STEP = 0.0016;    // mouse wheel, per delta pixel
const PINCH_STEP = 0.01;     // trackpad pinch (ctrl+wheel), per delta pixel
const GESTURE_GAP_MS = 140;  // wheel events closer than this belong to the same gesture
const ROTATE_PER_PX = 0.006; // rad of bearing per px of rotate-drag
const TILT_PER_PX = 0.005;   // rad of pitch per px of rotate-drag / two-finger tilt
const KEY_PAN = 0.8;         // view widths per second
const KEY_ZOOM = 1.6;        // e-folds of distance per second
const KEY_ROTATE = 1.4;      // rad/s
const KEY_TILT = 0.9;        // rad/s
const CLICK_SLOP_PX = 4;
const TAP_SLOP_PX = 10;
const TOUCH_DECIDE_PX = 12;  // finger travel before two-finger tilt vs pinch/rotate is decided
const TILT_PARALLEL = 10 * (Math.PI / 180);
const TILT_VERTICAL = 30 * (Math.PI / 180);

type MouseMode = 'none' | 'grab' | 'rotate';
type TouchMode = 'idle' | 'pending' | 'pan' | 'decide' | 'gesture' | 'tilt';

interface Pt {
  x: number;
  y: number;
}

/**
 * 3D camera input (research 04 §7.3), ported from cameraController.ts / pathfinding-demo's touchController.ts:
 *   trackpad two-finger scroll → pan · pinch (ctrl+wheel, Safari gesture scale) → zoom at cursor ·
 *   Safari gesture rotation → rotate · mouse wheel → eased zoom at cursor · left drag → grab pan ·
 *   right / middle / ⌃ drag → rotate (x) and tilt (y) · keys: arrows, +/−, Q/E, R/F, Home, N ·
 *   touch: 1 finger pan, 2 fingers pan + pinch + rotate, 2 fingers moving up/down in parallel → tilt.
 * Listens on the canvas; only key, pointer-up and blur events go to the window.
 */
export class OrbitController {
  /** When false every input is ignored (the canvas is shared with the 2D debug view). */
  enabled = true;
  /** Click / tap without a drag, in CSS px. */
  onTap?: ((sx: number, sy: number) => void) | undefined;
  /** Set while touch pointers are down: iOS also reports the pinch as gesture events, which must not apply twice. */
  touching = false;

  private readonly keys = new Set<string>();
  private lastWheelAt = -Infinity;
  private lastWheelKind: 'mouse' | 'trackpad' = 'mouse';

  private mouseMode: MouseMode = 'none';
  private mouseId = -1;
  private grabbed: Vec3 | null = null;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = false;

  private readonly pts = new Map<number, Pt>();
  private touchMode: TouchMode = 'idle';
  private touchGrab: Vec3 | null = null;
  private tStart = new Map<number, Pt>();
  private tLast: { cx: number; cy: number; d: number; a: number } = { cx: 0, cy: 0, d: 1, a: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** The camera driven (swapped for the globe camera while a sphere is shown). */
    public cam: ViewCamera,
  ) {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
    this.installSafariGestures();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());
  }

  /** Held keys (pan / zoom / rotate / tilt). Call each frame, before `cam.update(dt)`. */
  update(dtSec: number): void {
    if (!this.enabled) {
      if (this.keys.size || this.mouseMode !== 'none' || this.pts.size) this.reset();
      return;
    }
    const k = this.keys;
    if (k.size === 0) return;
    const cam = this.cam;
    let dx = 0, dy = 0;
    if (k.has('ArrowLeft')) dx -= 1;
    if (k.has('ArrowRight')) dx += 1;
    if (k.has('ArrowUp')) dy += 1;
    if (k.has('ArrowDown')) dy -= 1;
    if ((dx !== 0 || dy !== 0) && this.mouseMode !== 'grab') {
      const step = (KEY_PAN * cam.metresPerPixel() * cam.viewW * dtSec) / Math.hypot(dx, dy);
      cam.panBy(dx * step, (dy * step) / Math.cos(cam.pitch));
    }
    let z = 0;
    if (k.has('Equal') || k.has('NumpadAdd')) z -= 1;
    if (k.has('Minus') || k.has('NumpadSubtract')) z += 1;
    if (z !== 0) cam.zoomAt(cam.viewW / 2, cam.viewH / 2, Math.exp(z * KEY_ZOOM * dtSec));
    let rb = 0, rp = 0;
    if (k.has('KeyQ')) rb -= 1;
    if (k.has('KeyE')) rb += 1;
    if (k.has('KeyR')) rp += 1;
    if (k.has('KeyF')) rp -= 1;
    if (rb !== 0 || rp !== 0) cam.rotateBy(rb * KEY_ROTATE * dtSec, rp * KEY_TILT * dtSec);
  }

  private reset(): void {
    this.keys.clear();
    this.mouseMode = 'none';
    this.grabbed = null;
    this.pts.clear();
    this.touchMode = 'idle';
    this.touching = false;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Home') {
      e.preventDefault();
      this.cam.fitWorld();
      return;
    }
    if (e.code === 'KeyN') {
      this.cam.resetNorth();
      return;
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
    this.keys.add(e.code);
  };

  // ---- Mouse / pen ------------------------------------------------------------------------------

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') {
      this.touchDown(e);
      return;
    }
    if (this.mouseMode !== 'none') return;
    const rotate = e.button === 1 || e.button === 2 || (e.button === 0 && e.ctrlKey);
    if (!rotate && e.button !== 0) return;
    e.preventDefault();
    this.mouseMode = rotate ? 'rotate' : 'grab';
    this.mouseId = e.pointerId;
    this.downX = this.lastX = e.offsetX;
    this.downY = this.lastY = e.offsetY;
    this.moved = false;
    this.grabbed = rotate ? null : this.cam.pick(e.offsetX, e.offsetY);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer: moves still arrive while over the canvas.
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') {
      this.touchMove(e);
      return;
    }
    if (this.mouseMode === 'none' || e.pointerId !== this.mouseId) return;
    const x = e.offsetX, y = e.offsetY;
    if (Math.hypot(x - this.downX, y - this.downY) > CLICK_SLOP_PX) this.moved = true;
    if (this.mouseMode === 'grab') {
      if (this.grabbed) this.cam.dragTo(this.grabbed, x, y);
    } else {
      this.cam.rotateBy((x - this.lastX) * ROTATE_PER_PX, -(y - this.lastY) * TILT_PER_PX);
    }
    this.lastX = x;
    this.lastY = y;
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      if (e.currentTarget === this.canvas) this.touchUp(e);
      return;
    }
    if (this.mouseMode === 'none' || e.pointerId !== this.mouseId) return;
    const wasGrab = this.mouseMode === 'grab';
    this.mouseMode = 'none';
    this.grabbed = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (wasGrab && !this.moved && this.enabled && e.type === 'pointerup') this.onTap?.(this.downX, this.downY);
  };

  // ---- Wheel and Safari gestures ----------------------------------------------------------------

  /**
   * macOS trackpads send two-finger scroll as plain wheel events (→ pan) and pinch as ctrl+wheel
   * (→ zoom); a physical mouse wheel zooms (eased). See `classifyWheel`.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    const cam = this.cam;
    const now = performance.now();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cam.viewH : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;

    if (e.ctrlKey) {
      cam.pinchAt(e.offsetX, e.offsetY, Math.exp(dy * PINCH_STEP));
      return;
    }

    // A gesture keeps its classification for its whole event stream (including momentum).
    const kind = now - this.lastWheelAt < GESTURE_GAP_MS ? this.lastWheelKind : classifyWheel(e);
    this.lastWheelAt = now;
    this.lastWheelKind = kind;

    if (kind === 'trackpad') {
      const mpp = cam.metresPerPixel();
      cam.panBy(dx * mpp, (-dy * mpp) / Math.cos(cam.pitch));
      return;
    }
    cam.zoomAt(e.offsetX, e.offsetY, Math.exp(dy * ZOOM_STEP));
  };

  /** Safari pinch / rotate arrive as non-standard gesture events; block page zoom and map them to the camera. */
  private installSafariGestures(): void {
    let lastScale = 1;
    let lastRot = 0;
    let ax = 0;
    let ay = 0;
    type GestureEv = Event & { scale: number; rotation: number; clientX: number; clientY: number };
    this.canvas.addEventListener('gesturestart', (ev) => {
      ev.preventDefault();
      if (this.touching || !this.enabled) return;
      const g = ev as GestureEv;
      lastScale = 1;
      lastRot = 0;
      const r = this.canvas.getBoundingClientRect();
      ax = g.clientX - r.left;
      ay = g.clientY - r.top;
    });
    this.canvas.addEventListener('gesturechange', (ev) => {
      ev.preventDefault();
      if (this.touching || !this.enabled) return;
      const g = ev as GestureEv;
      if (g.scale > 0) this.cam.pinchAt(ax, ay, lastScale / g.scale);
      const dRot = g.rotation - lastRot;
      if (dRot !== 0) this.cam.rotateAt(ax, ay, -dRot * (Math.PI / 180));
      lastScale = g.scale;
      lastRot = g.rotation;
    });
    this.canvas.addEventListener('gestureend', (ev) => ev.preventDefault());
  }

  // ---- Touch ------------------------------------------------------------------------------------

  private local(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private touchDown(e: PointerEvent): void {
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (e.g. synthetic events).
    }
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    this.touching = true;
    if (this.pts.size === 1) {
      this.touchMode = 'pending';
      this.downX = p.x;
      this.downY = p.y;
      this.touchGrab = this.cam.pick(p.x, p.y);
    } else if (this.pts.size === 2) {
      this.startTwo();
    }
  }

  private touchMove(e: PointerEvent): void {
    if (!this.pts.has(e.pointerId)) return;
    e.preventDefault();
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    switch (this.touchMode) {
      case 'pending':
        if (Math.hypot(p.x - this.downX, p.y - this.downY) <= TAP_SLOP_PX) break;
        this.touchMode = 'pan';
        if (this.touchGrab) this.cam.dragTo(this.touchGrab, p.x, p.y);
        break;
      case 'pan':
        if (this.touchGrab) this.cam.dragTo(this.touchGrab, p.x, p.y);
        break;
      case 'decide':
        this.decideTwo();
        break;
      case 'gesture': {
        const g = this.two();
        if (!g) break;
        const l = this.tLast;
        this.cam.panScreen(g.cx - l.cx, g.cy - l.cy, g.cx, g.cy);
        this.cam.pinchAt(g.cx, g.cy, l.d / g.d);
        this.cam.rotateAt(g.cx, g.cy, -wrap(g.a - l.a));
        this.tLast = g;
        break;
      }
      case 'tilt': {
        const g = this.two();
        if (!g) break;
        this.cam.rotateBy(0, -(g.cy - this.tLast.cy) * TILT_PER_PX);
        this.tLast = g;
        break;
      }
      case 'idle':
        break;
    }
  }

  private touchUp(e: PointerEvent): void {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.pts.size === 0) {
      if (this.touchMode === 'pending' && e.type === 'pointerup' && this.enabled) this.onTap?.(this.downX, this.downY);
      this.touchMode = 'idle';
      this.touchGrab = null;
      this.touching = false;
      return;
    }
    if (this.pts.size >= 2) {
      this.startTwo();
    } else {
      // One finger left: keep panning with it, without a jump.
      const rest = this.pts.values().next().value!;
      this.touchMode = 'pan';
      this.touchGrab = this.cam.pick(rest.x, rest.y);
    }
  }

  private startTwo(): void {
    const g = this.two();
    if (!g) return;
    this.touchMode = 'decide';
    this.tStart = new Map([...this.pts].slice(0, 2).map(([id, p]) => [id, { ...p }]));
    this.tLast = g;
  }

  /** Two fingers moving up/down in parallel tilt; anything else pans + pinches + rotates. */
  private decideTwo(): void {
    const moves: Pt[] = [];
    for (const [id, s] of this.tStart) {
      const p = this.pts.get(id);
      if (p) moves.push({ x: p.x - s.x, y: p.y - s.y });
    }
    if (moves.length < 2) return;
    const [m0, m1] = moves as [Pt, Pt];
    if (Math.max(Math.hypot(m0.x, m0.y), Math.hypot(m1.x, m1.y)) < TOUCH_DECIDE_PX) return;
    const vertical = (m: Pt): boolean => Math.abs(Math.atan2(Math.abs(m.x), Math.abs(m.y))) <= TILT_VERTICAL;
    const parallel = Math.abs(wrap(Math.atan2(m0.y, m0.x) - Math.atan2(m1.y, m1.x))) <= TILT_PARALLEL;
    const tilt = parallel && vertical(m0) && vertical(m1) && Math.sign(m0.y) === Math.sign(m1.y);
    this.touchMode = tilt ? 'tilt' : 'gesture';
    // Apply the motion so far from the gesture's start, so nothing is lost to the dead zone.
    const g = this.two();
    if (!g) return;
    const start = this.twoOf([...this.tStart.values()]);
    if (start) this.tLast = start;
    if (tilt) {
      this.cam.rotateBy(0, -(g.cy - this.tLast.cy) * TILT_PER_PX);
      this.tLast = g;
    } else {
      const l = this.tLast;
      this.cam.panScreen(g.cx - l.cx, g.cy - l.cy, g.cx, g.cy);
      this.cam.pinchAt(g.cx, g.cy, l.d / g.d);
      this.cam.rotateAt(g.cx, g.cy, -wrap(g.a - l.a));
      this.tLast = g;
    }
  }

  private two(): { cx: number; cy: number; d: number; a: number } | null {
    return this.twoOf([...this.pts.values()]);
  }

  private twoOf(ps: Pt[]): { cx: number; cy: number; d: number; a: number } | null {
    const a = ps[0], b = ps[1];
    if (!a || !b) return null;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      a: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

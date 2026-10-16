import './compass.css';
import type { OrbitCamera } from '../render/camera/orbitCamera';

const ROTATE_PER_PX = 0.012; // rad of bearing per px of horizontal drag
const CLICK_SLOP_PX = 3;

/**
 * Compass widget: the needle points to north on screen (and leans with the pitch). Click → eased north up;
 * horizontal drag → rotate, turning the dial in the drag direction. Positioned bottom-left by compass.css;
 * override `.compass` placement in the caller's CSS if needed.
 */
export class Compass {
  readonly el: HTMLDivElement;
  private readonly rose: HTMLDivElement;
  private lastBearing = NaN;
  private lastPitch = NaN;

  constructor(parent: HTMLElement, private readonly cam: OrbitCamera) {
    this.el = document.createElement('div');
    this.el.className = 'compass';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'button');
    this.el.setAttribute('aria-label', 'Compass: click for north up, drag to rotate');
    this.el.title = 'Click: north up · drag: rotate';
    this.rose = document.createElement('div');
    this.rose.className = 'compass-rose';
    this.rose.innerHTML =
      '<svg viewBox="-16 -16 32 32" aria-hidden="true">' +
      '<path class="compass-n" d="M0 -12 L4 0 L-4 0 Z"/>' +
      '<path class="compass-s" d="M0 12 L4 0 L-4 0 Z"/>' +
      '<text class="compass-label" x="0" y="-12.5" text-anchor="middle">N</text>' +
      '</svg>';
    this.el.append(this.rose);
    parent.append(this.el);

    let startX = 0;
    let lastX = 0;
    let dragging = false;
    let moved = false;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      moved = false;
      startX = lastX = e.clientX;
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - startX) > CLICK_SLOP_PX) moved = true;
      if (moved) this.cam.rotateBy(-(e.clientX - lastX) * ROTATE_PER_PX, 0);
      lastX = e.clientX;
    });
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
      if (!moved && e.type === 'pointerup') this.cam.resetNorth();
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.cam.resetNorth();
      }
    });
    this.update();
  }

  /** Call each frame; touches the DOM only when the bearing or pitch changed. */
  update(): void {
    const b = this.cam.bearing, p = this.cam.pitch;
    if (b === this.lastBearing && p === this.lastPitch) return;
    this.lastBearing = b;
    this.lastPitch = p;
    this.rose.style.transform = `rotateX(${p.toFixed(4)}rad) rotate(${(-b).toFixed(4)}rad)`;
  }
}

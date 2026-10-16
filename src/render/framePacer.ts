/**
 * Idle frame cap (M9). While anything moves (camera, eased zoom, label fades, detail build, new data)
 * every animation frame is drawn; once things settle, frames are throttled to `idleFps` so animated
 * water keeps moving without burning a full 60–120 Hz. A scene with nothing animated (`animated`
 * false, e.g. the 2D raster view) stops redrawing entirely until something changes.
 */
export class FramePacer {
  /** Keep drawing at full rate for this long after the last busy frame (eases out flings and fades). */
  settleMs = 250;
  private lastBusy = -Infinity;
  private lastDraw = -Infinity;

  constructor(public idleFps = 30) {}

  /**
   * Call once per requestAnimationFrame. Returns true when this frame should be drawn.
   * `busy`: something changed since the last drawn frame. `animated`: the scene changes with time.
   */
  shouldDraw(now: number, busy: boolean, animated: boolean): boolean {
    if (busy) this.lastBusy = now;
    let draw: boolean;
    if (now - this.lastBusy < this.settleMs) draw = true;
    else if (!animated || this.idleFps <= 0) draw = false;
    // A few ms of slack so vsync jitter does not halve the rate (60 Hz → every 2nd frame, 120 Hz → every 4th).
    else draw = now - this.lastDraw >= 1000 / this.idleFps - 4;
    if (draw) this.lastDraw = now;
    return draw;
  }

  /** Forces the next frame to draw (resize, new data, context restored). */
  wake(now = performance.now()): void {
    this.lastBusy = now;
  }
}

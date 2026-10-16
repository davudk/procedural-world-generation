import './viewControls.css';
import { isTypingTarget } from '../input/cameraController';
import { DEFAULT_VIEW, formatSeason, formatTime, type ViewSettings } from '../render/lighting/sun';

const STORE_KEY = 'pwg.view';
/** Animated time of day: hours per second (a day in a minute). */
const HOURS_PER_SEC = 0.4;

/**
 * "View" controls of the realistic 3D view (M9): time of day, season, clouds and time animation.
 * These are render settings, not world config: they live in localStorage, not the URL. T toggles
 * the animation; double-click a slider to reset it.
 */
export class ViewControls {
  readonly el: HTMLDivElement;
  private readonly s: ViewSettings;
  private readonly time: HTMLInputElement;
  private readonly timeOut: HTMLSpanElement;
  private readonly season: HTMLInputElement;
  private readonly seasonOut: HTMLSpanElement;
  private readonly clouds: HTMLInputElement;
  private readonly play: HTMLButtonElement;
  private last = 0;

  constructor(parent: HTMLElement, private readonly onChange: (s: Readonly<ViewSettings>) => void) {
    this.s = { ...DEFAULT_VIEW, ...readStored(), animate: false };
    this.el = document.createElement('div');
    this.el.className = 'view-ctl';
    this.el.innerHTML =
      '<label class="exag" title="Time of day (double-click: default afternoon)">time <input type="range" min="0" max="24" step="0.05" />' +
      '<span class="view-out"></span><button type="button" class="view-play" title="Animate the time of day (T)">▶</button></label>' +
      '<label class="exag" title="Season (double-click: default summer)">season <input type="range" min="0" max="1" step="0.005" /><span class="view-out"></span></label>' +
      '<label class="exag view-check" title="Clouds and cloud shadows"><input type="checkbox" /> clouds</label>';
    const inputs = this.el.querySelectorAll('input');
    const outs = this.el.querySelectorAll<HTMLSpanElement>('.view-out');
    this.time = inputs[0];
    this.season = inputs[1];
    this.clouds = inputs[2];
    this.timeOut = outs[0];
    this.seasonOut = outs[1];
    this.play = this.el.querySelector<HTMLButtonElement>('.view-play')!;
    parent.append(this.el);

    this.time.addEventListener('input', () => this.set({ time: Number(this.time.value) }));
    this.season.addEventListener('input', () => this.set({ season: Number(this.season.value) }));
    this.clouds.addEventListener('change', () => this.set({ clouds: this.clouds.checked }));
    this.time.addEventListener('dblclick', () => this.set({ time: DEFAULT_VIEW.time }));
    this.season.addEventListener('dblclick', () => this.set({ season: DEFAULT_VIEW.season }));
    this.play.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggleAnimate();
    });
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.code !== 'KeyT') return;
      this.toggleAnimate();
    });
    this.sync();
    this.onChange(this.s);
  }

  toggleAnimate(): void {
    this.set({ animate: !this.s.animate });
    if (this.s.animate) {
      this.last = performance.now();
      requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (now: number): void => {
    if (!this.s.animate) return;
    const dt = Math.min(0.5, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.set({ time: (this.s.time + dt * HOURS_PER_SEC) % 24 }, false);
    requestAnimationFrame(this.tick);
  };

  private set(p: Partial<ViewSettings>, store = true): void {
    Object.assign(this.s, p);
    this.sync();
    this.onChange(this.s);
    if (store) writeStored(this.s);
  }

  private sync(): void {
    this.time.value = String(this.s.time);
    this.timeOut.textContent = formatTime(this.s.time);
    this.season.value = String(this.s.season);
    this.seasonOut.textContent = formatSeason(this.s.season);
    this.clouds.checked = this.s.clouds;
    this.play.textContent = this.s.animate ? '❚❚' : '▶';
    this.play.classList.toggle('on', this.s.animate);
  }
}

function readStored(): Partial<ViewSettings> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<Record<keyof ViewSettings, unknown>>;
    const out: Partial<ViewSettings> = {};
    if (typeof v.time === 'number' && v.time >= 0 && v.time <= 24) out.time = v.time;
    if (typeof v.season === 'number' && v.season >= 0 && v.season <= 1) out.season = v.season;
    if (typeof v.clouds === 'boolean') out.clouds = v.clouds;
    return out;
  } catch {
    return {};
  }
}

function writeStored(s: ViewSettings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ time: s.time, season: s.season, clouds: s.clouds }));
  } catch {
    // Storage may be unavailable (private mode); the settings just aren't remembered.
  }
}

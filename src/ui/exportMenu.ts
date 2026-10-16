import './exportMenu.css';

export interface ExportAction {
  id: string;
  label: string;
  hint: string;
  /** Runs on click; the returned text (if any) is shown as the status line. */
  run(): Promise<string | void> | string | void;
}

export interface ExportMenuOptions {
  actions: readonly ExportAction[];
  /** Render quality choice shown at the bottom of the menu. */
  quality: { value: string; options: readonly [string, string][]; onChange(v: string): void; note(): string };
}

/**
 * Export popover (PLAN.md §10): screenshot, heightmap, colour map, world JSON and share link, plus the
 * render-quality override (M9). Opened from a top-bar button; Escape or a click outside closes it.
 */
export class ExportMenu {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly qualityNote: HTMLElement;
  private busy = false;

  constructor(parent: HTMLElement, private readonly anchor: HTMLElement, opts: ExportMenuOptions) {
    this.el = document.createElement('div');
    this.el.className = 'export-menu hidden';
    this.el.setAttribute('role', 'menu');
    const title = document.createElement('div');
    title.className = 'export-title';
    title.textContent = 'Export';
    this.el.append(title);
    for (const a of opts.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'export-item';
      b.dataset.id = a.id;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = '<span class="export-label"></span><span class="export-hint"></span>';
      b.querySelector('.export-label')!.textContent = a.label;
      b.querySelector('.export-hint')!.textContent = a.hint;
      b.addEventListener('click', () => void this.runAction(a, b));
      this.el.append(b);
    }
    this.status = document.createElement('div');
    this.status.className = 'export-status';
    this.status.setAttribute('aria-live', 'polite');

    const q = document.createElement('label');
    q.className = 'export-quality';
    q.textContent = 'Render quality ';
    const sel = document.createElement('select');
    for (const [v, text] of opts.quality.options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      sel.append(o);
    }
    sel.value = opts.quality.value;
    this.qualityNote = document.createElement('div');
    this.qualityNote.className = 'export-hint';
    this.qualityNote.textContent = opts.quality.note();
    sel.addEventListener('change', () => {
      opts.quality.onChange(sel.value);
      this.qualityNote.textContent = opts.quality.note();
    });
    q.append(sel);
    this.el.append(this.status, q, this.qualityNote);
    parent.append(this.el);

    anchor.addEventListener('click', () => this.toggle());
    document.addEventListener('pointerdown', (e) => {
      if (this.open && !this.el.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.toggle(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.toggle(false);
    });
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  toggle(show = !this.open): void {
    this.el.classList.toggle('hidden', !show);
    this.anchor.setAttribute('aria-expanded', String(show));
    if (show) this.status.textContent = '';
  }

  private async runAction(a: ExportAction, b: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    b.disabled = true;
    this.status.textContent = `${a.label}…`;
    try {
      const msg = await a.run();
      this.status.textContent = msg ?? `${a.label}: done`;
    } catch (err) {
      console.error(err);
      this.status.textContent = `${a.label} failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
      b.disabled = false;
    }
  }
}

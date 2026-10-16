/** Browser glue for the Export menu: save a blob through an `<a download>` click, copy text. */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadBytes(bytes: Uint8Array, filename: string, type: string): void {
  downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), filename);
}

/** RGBA8 pixels (row 0 at the top) → PNG blob through a 2D canvas (the browser's own, fast encoder). */
export async function rgbaToPngBlob(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Promise<Blob> {
  const data = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height);
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height);
    c.getContext('2d')!.putImageData(data, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d')!.putImageData(data, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

/** Copies text to the clipboard; falls back to a hidden textarea + execCommand where the API is missing. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** File-name stem for a world: `world-<seed>[-<archetype>]`. */
export function fileStem(seed: number, archetype: string, defaultArchetype: string): string {
  const a = archetype === defaultArchetype ? '' : `-${archetype.replace(/[^a-z0-9-]+/gi, '-')}`;
  return `world-${seed >>> 0}${a}`;
}

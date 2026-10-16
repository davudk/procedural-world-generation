import type { WorldView } from '../../render/worldView';
import { DEFAULT_ARCHETYPE } from '../../shared/config/archetypes';
import { resolve } from '../../shared/config/resolve';
import type { WorldSpec } from '../../shared/config/types';
import { specToQuery } from '../../shared/config/url';
import type { Landmark, WorldTraits } from '../../shared/landmarks';
import type { Layer } from '../../shared/protocol';
import type { ExportAction } from '../../ui/exportMenu';
import { copyText, downloadBlob, downloadBytes, fileStem, rgbaToPngBlob } from './download';
import { encodeGray16 } from './png';
import { buildWorldJson, colorizeLayer, heightmapScale, quantizeHeights } from './worldExport';

/** What the export actions read from the app (getters, so they always see the current world). */
export interface ExportContext {
  world: WorldView;
  spec(): WorldSpec;
  mode(): '3d' | '2d';
  layer(id: string): Layer | undefined;
  /** The layer the map is currently coloured by (layer picker). */
  shownLayer(): Layer | undefined;
  landmarks(): readonly Landmark[];
  traits(): WorldTraits | null;
}

/** The Export menu entries (PLAN.md §10): PNG screenshot, 16-bit heightmap, colour map, world JSON, share link. */
export function exportActions(ctx: ExportContext): ExportAction[] {
  const stem = (): string => {
    const s = ctx.spec();
    return fileStem(s.seed, s.archetype, DEFAULT_ARCHETYPE);
  };
  const shareUrl = (): string => `${location.origin}${location.pathname}?${specToQuery(ctx.spec())}`;
  return [
    {
      id: 'screenshot',
      label: 'Screenshot (PNG)',
      hint: 'The current 3D view with labels',
      async run() {
        if (ctx.mode() !== '3d') return 'Switch to the 3D view first';
        const shot = ctx.world.capture(performance.now() / 1000);
        if (!shot) return 'The graphics context is lost; try again in a moment';
        downloadBlob(await rgbaToPngBlob(shot.width, shot.height, shot.pixels), `${stem()}-view.png`);
        return `Saved ${shot.width}×${shot.height} screenshot`;
      },
    },
    {
      id: 'heightmap',
      label: 'Heightmap (16-bit PNG)',
      hint: 'Macro elevation grid (scale in the world JSON)',
      async run() {
        const e = ctx.layer('elevation');
        if (!e) return 'No elevation yet';
        const scale = heightmapScale(e);
        const text = {
          Software: 'Procedural World',
          Description: `Elevation, metres = ${scale.minM} + v / 65535 * ${scale.maxM - scale.minM}; ${e.worldKm} km square, row 0 = north`,
        };
        const png = await encodeGray16(e.w, e.h, quantizeHeights(e, scale), text);
        // One file per click (several downloads at once trigger a browser prompt); the scale is in the
        // PNG's tEXt chunk and in the world JSON's `heightmap` block.
        downloadBytes(png, `${stem()}-height-${e.w}.png`, 'image/png');
        return `Saved ${e.w}² heightmap (${scale.minM} … ${scale.maxM} m)`;
      },
    },
    {
      id: 'colormap',
      label: 'Colour map (PNG)',
      hint: 'The selected layer at grid resolution',
      async run() {
        const l = ctx.shownLayer();
        if (!l) return 'No layer yet';
        const rgba = colorizeLayer(l);
        downloadBlob(await rgbaToPngBlob(l.w, l.h, rgba), `${stem()}-${l.id}-${l.w}.png`);
        return `Saved ${l.label} (${l.w}²)`;
      },
    },
    {
      id: 'json',
      label: 'World (JSON)',
      hint: 'Seed, settings, traits and named places',
      run() {
        const spec = ctx.spec();
        const json = buildWorldJson({
          spec,
          query: specToQuery(spec),
          shareUrl: shareUrl(),
          resolved: resolve(spec).values,
          elevation: ctx.layer('elevation') ?? null,
          traits: ctx.traits(),
          landmarks: ctx.landmarks(),
        });
        downloadBytes(new TextEncoder().encode(JSON.stringify(json, null, 2)), `${stem()}.json`, 'application/json');
        return `Saved world with ${json.landmarks.length} named places`;
      },
    },
    {
      id: 'link',
      label: 'Copy share link',
      hint: 'Seed, preset and your settings in a URL',
      async run() {
        const url = shareUrl();
        return (await copyText(url)) ? 'Link copied' : `Copy this link:\n${url}`;
      },
    },
  ];
}

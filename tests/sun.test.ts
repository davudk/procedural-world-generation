import { describe, expect, it } from 'vitest';
import { DEFAULT_SEASON, DEFAULT_TIME, formatSeason, formatTime, seasonPhase, sunLight } from '../src/render/lighting/sun';

describe('sun model (M9 time of day)', () => {
  it('reproduces the pre-M9 cartographic light at the default time and season', () => {
    for (const bearing of [0, 1.3, -2.4]) {
      const s = sunLight(DEFAULT_TIME, DEFAULT_SEASON, bearing);
      const az = bearing - Math.PI / 4;
      const el = (40 * Math.PI) / 180;
      const want = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
      for (let i = 0; i < 3; i++) {
        expect(s.dir[i]).toBeCloseTo(want[i], 9);
        expect(s.light[i]).toBe(1);
        expect(s.ambient[i]).toBe(1);
      }
      expect(s.skyHorizon).toEqual([0.62, 0.70, 0.78]);
      expect(s.skyZenith).toEqual([0.22, 0.38, 0.62]);
      expect(s.fog).toBe(0);
      expect(s.glow.map((c) => +c.toFixed(6))).toEqual([0.35, 0.322, 0.2625]);
    }
    expect(seasonPhase(DEFAULT_SEASON)).toEqual({ cos: 1, sin: 0 });
  });

  it('dims at night, warms at sunset and keeps the shadow light above the horizon', () => {
    const night = sunLight(0, DEFAULT_SEASON, 0);
    const dusk = sunLight(18.5, DEFAULT_SEASON, 0);
    const noon = sunLight(12, DEFAULT_SEASON, 0);
    expect(night.sinEl).toBeLessThan(0);
    expect(Math.max(...night.light)).toBeLessThan(0.3);
    expect(night.dir[2]).toBeGreaterThan(0.3);
    expect(dusk.light[0]).toBeGreaterThan(dusk.light[2]);
    expect(dusk.dir[2]).toBeGreaterThan(0);
    expect(noon.sinEl).toBeGreaterThan(Math.sin((60 * Math.PI) / 180));
    // Winter noon is lower than summer noon.
    expect(sunLight(12, 0.97, 0).sinEl).toBeLessThan(noon.sinEl - 0.4);
  });

  it('formats times and seasons', () => {
    expect(formatTime(DEFAULT_TIME)).toMatch(/^15:\d\d$/);
    expect(formatTime(0)).toBe('00:00');
    expect(formatSeason(DEFAULT_SEASON)).toBe('mid Jul');
    expect(formatSeason(0)).toBe('early Jan');
  });
});

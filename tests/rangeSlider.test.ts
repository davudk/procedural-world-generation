import { describe, expect, it } from 'vitest';
import { positionToValue, snapValue, stepValue, valueToPosition, type SliderScale } from '../src/ui/rangeSlider';

const linear: SliderScale = { min: 0.05, max: 0.8, step: 0.01 };
const worldSize: SliderScale = { min: 256, max: 4096, step: 1, log: true, integer: true };
const crater: SliderScale = { min: 0.5, max: 300, step: 0.5, log: true };

describe('snapValue', () => {
  it('clamps to bounds', () => {
    expect(snapValue(-1, linear)).toBe(0.05);
    expect(snapValue(5, linear)).toBe(0.8);
  });

  it('snaps to the step grid without float noise', () => {
    expect(snapValue(0.4049, linear)).toBe(0.4);
    expect(snapValue(0.1 + 0.2, linear)).toBe(0.3);
    expect(snapValue(1.26, { min: 1.1, max: 1.45, step: 0.01 })).toBe(1.26);
  });

  it('rounds integer scales', () => {
    expect(snapValue(1023.6, worldSize)).toBe(1024);
  });
});

describe('log mapping', () => {
  it('maps the ends and the geometric midpoint', () => {
    expect(valueToPosition(256, worldSize)).toBe(0);
    expect(valueToPosition(4096, worldSize)).toBe(1);
    expect(valueToPosition(1024, worldSize)).toBeCloseTo(0.5, 10);
    expect(positionToValue(0.5, worldSize)).toBe(1024);
  });

  it('round-trips every power of two in range', () => {
    for (const v of [256, 512, 1024, 2048, 4096]) expect(positionToValue(valueToPosition(v, worldSize), worldSize)).toBe(v);
  });

  it('is monotonic', () => {
    let prev = -Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = positionToValue(t, crater);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('falls back to linear when min <= 0', () => {
    const s: SliderScale = { min: 0, max: 10, step: 1, log: true };
    expect(valueToPosition(5, s)).toBe(0.5);
  });
});

describe('stepValue', () => {
  it('steps linear scales by step, ×10 when big', () => {
    expect(stepValue(0.4, 1, false, linear)).toBe(0.41);
    expect(stepValue(0.4, -1, true, linear)).toBe(0.3);
  });

  it('always moves on log scales and stops at bounds', () => {
    expect(stepValue(256, 1, false, worldSize)).toBeGreaterThan(256);
    expect(stepValue(0.5, 1, false, crater)).toBeGreaterThan(0.5);
    expect(stepValue(4096, 1, false, worldSize)).toBe(4096);
    expect(stepValue(256, -1, false, worldSize)).toBe(256);
  });
});

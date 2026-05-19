import { describe as ddescribe, expect, it } from 'vitest';
import { describe } from './stats.js';

ddescribe('describe', () => {
  it('returns count=0 for empty input', () => {
    const s = describe([]);
    expect(s.count).toBe(0);
    expect(s.min).toBeNaN();
  });

  it('handles a single value', () => {
    const s = describe([42]);
    expect(s.count).toBe(1);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.mean).toBe(42);
    expect(s.median).toBe(42);
    expect(s.stdev).toBeNaN();
  });

  it('computes mean/median/std on a simple series', () => {
    const s = describe([1, 2, 3, 4, 5]);
    expect(s.count).toBe(5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
    expect(s.median).toBe(3);
    // sample stdev with n-1: sqrt(10/4) = sqrt(2.5)
    expect(s.stdev).toBeCloseTo(Math.sqrt(2.5), 6);
  });

  it('drops non-finite values', () => {
    const s = describe([1, 2, NaN, 3, Infinity, -Infinity]);
    expect(s.count).toBe(3);
    expect(s.mean).toBe(2);
  });

  it('interpolates p5 / p95 linearly', () => {
    const s = describe([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // p5: 0.05 * 9 = 0.45 → 1*(1-0.45) + 2*0.45 = 1.45
    expect(s.p5).toBeCloseTo(1.45, 6);
    // p95: 0.95 * 9 = 8.55 → 9*(1-0.55) + 10*0.55 = 9.55
    expect(s.p95).toBeCloseTo(9.55, 6);
  });
});

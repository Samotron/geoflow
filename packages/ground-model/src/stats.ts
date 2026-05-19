/**
 * stats.ts — descriptive statistics for a set of samples.
 *
 * Intentionally non-opinionated: we don't compute "characteristic values"
 * or apply fractile logic. The user is the one choosing parameter values;
 * we just surface what's there.
 */

export interface SampleStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  /** Sample standard deviation (n-1 denominator). NaN when count < 2. */
  stdev: number;
  /** 5th percentile (linear interpolation). NaN when count < 1. */
  p5: number;
  /** 95th percentile (linear interpolation). NaN when count < 1. */
  p95: number;
}

const EMPTY: SampleStats = {
  count: 0,
  min: NaN,
  max: NaN,
  mean: NaN,
  median: NaN,
  stdev: NaN,
  p5: NaN,
  p95: NaN,
};

export function describe(values: ReadonlyArray<number>): SampleStats {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return EMPTY;
  const mean = xs.reduce((a, x) => a + x, 0) / n;
  const variance = n > 1
    ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)
    : NaN;
  const stdev = Number.isFinite(variance) ? Math.sqrt(variance) : NaN;
  return {
    count: n,
    min: xs[0]!,
    max: xs[n - 1]!,
    mean,
    median: percentile(xs, 0.5),
    stdev,
    p5: percentile(xs, 0.05),
    p95: percentile(xs, 0.95),
  };
}

function percentile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

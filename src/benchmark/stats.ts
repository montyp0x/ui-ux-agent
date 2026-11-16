// Small, dependency-free statistics for benchmark reports. A rate is always
// reported with its sample size and a 95% Wilson score interval, so one
// success is never presented as a pass rate.

export type Interval = { low: number; high: number; confidence: 0.95 };
export type Rate = {
  successes: number;
  n: number;
  // Null when n is 0: there is nothing to estimate.
  rate: number | null;
  interval: Interval | null;
};

const Z_95 = 1.959963984540054;

// Wilson score interval for a binomial proportion; null when n is 0.
export function wilson(successes: number, n: number): Interval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(n))
    throw new Error('wilson() needs integer counts');
  if (n < 0 || successes < 0 || successes > n)
    throw new Error(
      `wilson() needs 0 <= successes <= n (got ${successes}/${n})`,
    );
  if (n === 0) return null;
  const p = successes / n;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half =
    (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
    confidence: 0.95,
  };
}

export function rate(successes: number, n: number): Rate {
  return {
    successes,
    n,
    rate: n ? successes / n : null,
    interval: wilson(successes, n),
  };
}

export type Distribution = {
  n: number;
  median: number | null;
  p90: number | null;
  max: number | null;
};

// Nearest-rank percentile of already sorted values.
function percentile(sorted: number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

export function distribution(values: number[]): Distribution {
  if (!values.length) return { n: 0, median: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median:
      sorted.length % 2
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1]!,
  };
}

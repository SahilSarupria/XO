import { makeRng } from '../scenario/freight/render.js';

/** Wilson score interval — behaves sensibly at 0% / 100% and small n, unlike the normal approximation. */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
}

/**
 * Paired bootstrap of (mean(a) − mean(b)) over the same tasks. Pairing matters:
 * the tasks are shared, so the right uncertainty is over *task resampling*, not
 * over two independent samples.
 */
export function pairedBootstrapDiff(
  a: readonly number[],
  b: readonly number[],
  iterations = 10_000,
  seed = 1,
): { diff: number; lo: number; hi: number } {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { diff: 0, lo: 0, hi: 0 };
  const r = makeRng(seed);
  const d = Array.from({ length: n }, (_, i) => (a[i] as number) - (b[i] as number));
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(r() * n)] as number;
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  return { diff: mean(d), lo: means[Math.floor(0.025 * iterations)] as number, hi: means[Math.floor(0.975 * iterations)] as number };
}

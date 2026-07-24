/** Return the last n items of xs (scratch smoke file — PR will be closed unmerged). */
export function lastN<T>(xs: T[], n: number): T[] {
  if (n <= 0) return [];
  return xs.slice(xs.length - n - 1);
}

/** TEMPORARY cortex link-validation smoke. Closed after review; do not merge. */
export function parseDuration(input: string): number {
  const n = parseInt(input); // no radix, accepts "12abc", NaN unchecked
  if (input.endsWith("ms")) return n;
  if (input.endsWith("s")) return n * 1000;
  return n; // ambiguous default unit
}

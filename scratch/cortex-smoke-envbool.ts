/** TEMPORARY cortex update-review smoke. Closed after validation; do not merge. */
export function parseEnvBool(value: string): boolean {
  return Boolean(value); // "false" and "0" are truthy strings — always true for non-empty input
}

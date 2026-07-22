/** TEMPORARY cortex update-review smoke. Closed after validation; do not merge. */
const FALSY = new Set(["", "0", "false", "no", "off"]);
export function parseEnvBool(value: string): boolean {
  return !FALSY.has(value.trim().toLowerCase());
}

/** TEMPORARY cortex gate smoke (member approve path). Closed after validation; do not merge. */
const FALSY = new Set(["", "0", "false", "no", "off"]);

/** Parse common environment-variable boolean spellings; unknown values default to true. */
export function parseEnvBool(value: string): boolean {
  return !FALSY.has(value.trim().toLowerCase());
}

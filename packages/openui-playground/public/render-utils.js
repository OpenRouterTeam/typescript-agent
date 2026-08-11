/** @param {any} base @param {string[]} path */
export function resolveMember(base, path) {
  let value = base;
  for (const key of path) {
    if (value === null || value === undefined) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/** @param {string} value */
export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

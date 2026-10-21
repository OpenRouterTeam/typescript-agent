/**
 * Populate the top-level `model` from the `models` fallback list (#121).
 *
 * OpenRouter server tools (e.g. `openrouter:datetime`) require a primary
 * `model` on the request; a caller that only supplies `models` would
 * otherwise send none. The primary is `models[0]`, matching the router's
 * own fallback order.
 *
 * Mutates `request` in place. By default an existing `model` is kept; pass
 * `overwrite: true` to replace it (used when `models` changed and `model`
 * did not, so the two can't drift apart).
 */
export function fillPrimaryModelFromModels(
  request: {
    model?: unknown;
    models?: unknown;
  },
  options: {
    overwrite?: boolean;
  } = {},
): void {
  if (request.model !== undefined && !options.overwrite) {
    return;
  }
  const primary = Array.isArray(request.models) ? request.models[0] : undefined;
  if (typeof primary === 'string') {
    request.model = primary;
  }
}

/**
 * The `openui()` request helper: turn a component library into the `openui`
 * plugin preference carried on a Responses request. Zod prop schemas are
 * converted to JSON Schema at this boundary — the API owns prompt generation
 * and validation, so the wire shape is renderer- and SDK-agnostic.
 *
 * Note: until `@openrouter/sdk` regenerates with the `openui` plugin member
 * (DEV-772), the SDK's closed `plugins` union will not accept this shape —
 * gate usage on that release.
 */
import { convertZodToJsonSchema } from '../tool-executor.js';
import type { UiLibrary } from './library.js';

/** Wire shape of one component definition inside the plugin preference. */
export interface OpenUiWireComponent {
  name: string;
  description?: string;
  /**
   * JSON Schema for the component's props. Property declaration order is
   * normative: positional arguments in OpenUI Lang map to props in order.
   */
  props?: Record<string, unknown>;
}

/** Wire shape of the `openui` plugin preference. */
export interface OpenUiPlugin {
  id: 'openui';
  library: OpenUiWireComponent[];
  dialect?: string;
}

/*
 * Libraries are immutable after `createLibrary`, so the wire shape (including
 * the Zod→JSON-Schema conversion per component) is computed once per library
 * rather than once per request — `plugins: [openui(library)]` inline per call
 * is the documented usage.
 */
const wireCache = new WeakMap<UiLibrary, OpenUiPlugin>();

/**
 * Build the `openui` plugin preference from a component library.
 *
 * @example
 * ```typescript
 * const result = callModel(client, {
 *   model: 'anthropic/claude-sonnet-5',
 *   input: 'Show me a dashboard',
 *   plugins: [openui(library)],
 * });
 * ```
 */
export function openui(library: UiLibrary): OpenUiPlugin {
  const cached = wireCache.get(library);
  if (cached) {
    return cached;
  }
  const plugin = buildPlugin(library);
  wireCache.set(library, plugin);
  return plugin;
}

function buildPlugin(library: UiLibrary): OpenUiPlugin {
  return {
    id: 'openui',
    library: [
      ...library.components.values(),
    ].map((def) => {
      const component: OpenUiWireComponent = {
        name: def.name,
      };
      if (def.description !== undefined) {
        component.description = def.description;
      }
      if (def.props !== undefined) {
        component.props = convertZodToJsonSchema(def.props, 'input');
      }
      return component;
    }),
    dialect: library.dialect,
  };
}

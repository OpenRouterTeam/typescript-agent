/**
 * Component-library system prompt — playground emulation of what the API's
 * `openui` plugin will inject server-side (DEV-771). Generated from the same
 * `UiLibrary` shape the SDK ships, so prompts here and API-side stay
 * comparable when we bench the two paths against each other.
 */
import type { ComponentDefinition, UiLibrary } from '@openrouter/agent';
import { componentProps } from '@openrouter/agent';
import * as z4 from 'zod/v4';
import type { $ZodType } from 'zod/v4/core';

function describeSchema(schema: $ZodType): string {
  try {
    const json = z4.toJSONSchema(schema, {
      io: 'input',
    });
    /*
     * Before `type`: an enum serializes as `{type: 'string', enum: [...]}`, so
     * checking `type` first labels every enum prop a plain `string` and the
     * model never learns which values are legal for `Badge.tone`,
     * `Stack.direction`, `Button.variant`, and the rest.
     */
    if (Array.isArray(json.enum)) {
      return json.enum.map((v) => JSON.stringify(v)).join(' | ');
    }
    if (typeof json.type === 'string') {
      return json.type;
    }
    if (Array.isArray(json.anyOf)) {
      const types = json.anyOf
        .map((s) => (typeof s === 'object' && s !== null && 'type' in s ? String(s.type) : 'any'))
        .filter((t) => t !== 'null');
      if (types.length > 0) {
        return types.join(' | ');
      }
    }
  } catch {
    // Exotic schema — fall through to the permissive label.
  }
  return 'any';
}

function renderComponentLine(def: ComponentDefinition): string {
  const props = componentProps(def)
    .map((p) => `${p.name}${p.optional ? '?' : ''}: ${describeSchema(p.schema)}`)
    .join(', ');
  const doc = def.description ? ` — ${def.description}` : '';
  return `- ${def.name}(${props})${doc}`;
}

/** Render the system prompt for a library. */
export function libraryPrompt(library: UiLibrary): string {
  return [
    `Respond in OpenUI Lang (${library.dialect}): one assignment statement per line, \`name = Expression\`.`,
    'Rules:',
    '- Components: `ref = Component(arg1, arg2, ...)` — positional args map to props in signature order.',
    '- The statement assigned to `root` is the rendered root.',
    '- Reactive state: `$name = defaultValue`. Passing `$name` to an input two-way binds it.',
    '- Data: `ref = Query("tool_name", { args })` fetches on load and when referenced `$vars` change; `ref = Mutation("tool_name", { args })` runs only via `@Run(ref)`.',
    '- Actions: `Action([@Run(ref), @Set($var, value), @ToAssistant("message")])` — steps run sequentially.',
    '- Reference other statements by their `ref`. Member access plucks fields (`data.rows.title`).',
    '- Arguments are POSITIONAL only — never `name: value` pairs. Skip an optional prop by ending the argument list early.',
    '- Emit only OpenUI Lang statements — no prose, no code fences.',
    '',
    'Example:',
    '$query = ""',
    'results = Table(["Name", "Score"], [["alpha", "9.1"], ["beta", "8.4"]])',
    'root = Card("Leaderboard", [Input("search", $query, "Filter…"), results])',
    '',
    'Available components:',
    ...[
      ...library.components.values(),
    ].map(renderComponentLine),
  ].join('\n');
}

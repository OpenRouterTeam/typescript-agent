/**
 * Component library model: `defineComponent` / `createLibrary`.
 *
 * A library is the vocabulary an agent may render — component names plus
 * Zod prop schemas whose *declaration order is normative* (positional args in
 * OpenUI Lang map to props by declared order). The SDK ships the library to
 * the API via the `openui` plugin (see `plugin.ts`); prompt generation and
 * document validation happen API-side.
 */

import type { ZodObject, ZodRawShape } from 'zod/v4';
import * as z4 from 'zod/v4';
import type { $ZodType } from 'zod/v4/core';
import { OPENUI_LANG_DIALECT } from './document.js';

/** One registered component: its name, docs, and ordered prop schemas. */
export interface ComponentDefinition<N extends string = string> {
  name: N;
  description?: string;
  /**
   * Prop schemas. Positional arguments in OpenUI Lang map to props by key
   * declaration order (Zod preserves shape insertion order).
   */
  props?: ZodObject<ZodRawShape>;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdent(kind: string, name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`${kind} name ${JSON.stringify(name)} must match ${IDENT_RE.source}`);
  }
  return name;
}

/** Declare a component the model (or a tool) may render. */
export function defineComponent<const N extends string>(
  def: ComponentDefinition<N>,
): ComponentDefinition<N> {
  assertIdent('component', def.name);
  return def;
}

/**
 * Components every library accepts implicitly: data bindings, action blocks,
 * and the slot that mounts a tool-owned region into a model-authored layout.
 */
export const OPENUI_BUILTIN_COMPONENTS = [
  'Action',
  'Query',
  'Mutation',
  'ToolView',
] as const;

/** A registered component library — the vocabulary a surface renders. */
export interface UiLibrary<N extends string = string> {
  dialect: string;
  components: ReadonlyMap<string, ComponentDefinition>;
  componentNames: readonly N[];
}

/** Options for {@link createLibrary}. */
export interface CreateLibraryOptions {
  dialect?: string;
}

/** Build a library from component definitions. */
export function createLibrary<const D extends readonly ComponentDefinition[]>(
  definitions: D,
  options?: CreateLibraryOptions,
): UiLibrary<D[number]['name']> {
  const components = new Map<string, ComponentDefinition>();
  for (const def of definitions) {
    assertIdent('component', def.name);
    if (components.has(def.name)) {
      throw new Error(`duplicate component name '${def.name}' in library`);
    }
    components.set(def.name, def);
  }
  return {
    dialect: options?.dialect ?? OPENUI_LANG_DIALECT,
    components,
    componentNames: definitions.map((d) => d.name),
  };
}

/** An ordered prop signature for a component (declaration order). */
export interface PropSignature {
  name: string;
  optional: boolean;
  schema: $ZodType;
}

/** Ordered prop signatures for a component (declaration order). */
export function componentProps(def: ComponentDefinition): PropSignature[] {
  if (!def.props) {
    return [];
  }
  return Object.entries(def.props.shape).map(([name, schema]) => ({
    name,
    optional: z4.safeParse(schema as $ZodType, undefined).success,
    schema: schema as $ZodType,
  }));
}

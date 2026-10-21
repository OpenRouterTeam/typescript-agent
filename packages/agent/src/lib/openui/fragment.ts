/**
 * Typed fragment builder for tool-authored UI.
 *
 * `fragment(library)` compiles a constructor per registered component from the
 * library's own Zod prop schemas, so tool render functions build fragments in
 * plain TypeScript and get validation at construction time — a typo'd
 * component name fails typecheck, a bad literal prop fails before the client
 * renderer ever sees it. Constructors return a `FragmentNode` (dialect +
 * serialized source) that also composes as a child of other constructors.
 */
import * as z4 from 'zod/v4';
import type { UiExpr, UiFragment, UiLiteralValue } from './document.js';
import { OPENUI_LANG_DIALECT, OPENUI_ROOT_REF, serializeExpr } from './document.js';
import type { UiLibrary } from './library.js';
import { assertIdent, componentProps, OPENUI_BUILTIN_COMPONENTS } from './library.js';

const FRAGMENT_EXPR: unique symbol = Symbol.for('openrouter.openui.fragment-expr');

/** A composable fragment node: a {@link UiFragment} that also nests as a child argument. */
export interface FragmentNode extends UiFragment {
  [FRAGMENT_EXPR]: UiExpr;
}

/** Any value accepted as a fragment constructor argument. */
export type FragmentArg =
  | undefined
  | UiLiteralValue
  | FragmentNode
  | FragmentArg[]
  | {
      [key: string]: FragmentArg;
    };

function isFragmentNode(value: unknown): value is FragmentNode {
  return typeof value === 'object' && value !== null && FRAGMENT_EXPR in value;
}

function toExpr(arg: FragmentArg): UiExpr {
  if (isFragmentNode(arg)) {
    return arg[FRAGMENT_EXPR];
  }
  if (Array.isArray(arg)) {
    return {
      kind: 'array',
      items: arg.map(toExpr),
    };
  }
  if (typeof arg === 'object' && arg !== null) {
    return {
      kind: 'object',
      entries: Object.entries(arg).flatMap(([key, value]) =>
        value === undefined
          ? []
          : [
              {
                key,
                value: toExpr(value),
              },
            ],
      ),
    };
  }
  if (arg === undefined) {
    return {
      kind: 'literal',
      value: null,
    };
  }
  return {
    kind: 'literal',
    value: arg,
  };
}

function makeNode(dialect: string, expr: UiExpr): FragmentNode {
  return {
    dialect,
    source: `${OPENUI_ROOT_REF} = ${serializeExpr(expr)}`,
    [FRAGMENT_EXPR]: expr,
  };
}

/** Reference another statement by ref (`uiRef('chart')` → `chart`). */
export function uiRef(name: string, dialect?: string): FragmentNode {
  return makeNode(dialect ?? OPENUI_LANG_DIALECT, {
    kind: 'ref',
    name: assertIdent('uiRef', name),
  });
}

/** Reference a reactive state variable (`uiState('tab')` → `$tab`). */
export function uiState(name: string, dialect?: string): FragmentNode {
  return makeNode(dialect ?? OPENUI_LANG_DIALECT, {
    kind: 'state-ref',
    name: assertIdent('uiState', name),
  });
}

/** Options for stamping a standalone built-in with a custom dialect. */
export interface UiBuiltinOptions {
  dialect?: string;
}

/** A built-in function step (`uiBuiltin('Run', uiRef('save'))` → `@Run(save)`). */
export function uiBuiltin(fn: string, ...args: FragmentArg[]): FragmentNode;
export function uiBuiltin(
  options: UiBuiltinOptions,
  fn: string,
  ...args: FragmentArg[]
): FragmentNode;
export function uiBuiltin(
  fnOrOptions: string | UiBuiltinOptions,
  ...fnAndArgs:
    | [
        string,
        ...FragmentArg[],
      ]
    | FragmentArg[]
): FragmentNode {
  const hasOptions = typeof fnOrOptions !== 'string';
  const fn = hasOptions ? (fnAndArgs[0] as string) : fnOrOptions;
  const args = hasOptions ? fnAndArgs.slice(1) : fnAndArgs;
  return makeNode(hasOptions ? (fnOrOptions.dialect ?? OPENUI_LANG_DIALECT) : OPENUI_LANG_DIALECT, {
    kind: 'call',
    fn: assertIdent('uiBuiltin', fn),
    builtin: true,
    args: args.map(toExpr),
  });
}

/** One constructor per component: builds a validated fragment node. */
export type FragmentBuilder<N extends string> = Record<
  N | (typeof OPENUI_BUILTIN_COMPONENTS)[number],
  (...args: FragmentArg[]) => FragmentNode
>;

/**
 * Compile a typed fragment builder from a library.
 *
 * @example
 * ```typescript
 * const ui = fragment(library);
 * const card = ui.Card('Usage', [ui.Text('$12.30 across 42 requests')]);
 * // card.source === 'root = Card("Usage", [Text("$12.30 across 42 requests")])'
 * ```
 */
export function fragment<N extends string>(library: UiLibrary<N>): FragmentBuilder<N> {
  const builder: Record<string, (...args: FragmentArg[]) => FragmentNode> = {};
  for (const def of library.components.values()) {
    const props = componentProps(def);
    builder[def.name] = (...args: FragmentArg[]) => {
      if (args.length > props.length) {
        throw new Error(
          `${def.name}() takes at most ${props.length} argument(s) (${props.map((p) => p.name).join(', ')}), got ${args.length}`,
        );
      }
      const exprs = args.map((arg, i) => {
        const expr = toExpr(arg);
        const prop = props[i];
        if (arg !== undefined && prop && expr.kind === 'literal') {
          const parsed = z4.safeParse(prop.schema, expr.value);
          if (!parsed.success) {
            throw new Error(
              `${def.name}() prop '${prop.name}' rejects ${JSON.stringify(expr.value)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
            );
          }
        }
        return expr;
      });
      return makeNode(library.dialect, {
        kind: 'call',
        fn: def.name,
        builtin: false,
        args: exprs,
      });
    };
  }
  for (const name of OPENUI_BUILTIN_COMPONENTS) {
    builder[name] ??= (...args: FragmentArg[]) =>
      makeNode(library.dialect, {
        kind: 'call',
        fn: name,
        builtin: false,
        args: args.map(toExpr),
      });
  }
  return builder as FragmentBuilder<N>;
}

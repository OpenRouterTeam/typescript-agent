/**
 * OpenUI Lang expression model + serialization.
 *
 * OpenUI Lang is a line-oriented assignment language: one statement per line,
 * `name = expression`. The SDK only *authors* OpenUI Lang (tool-authored
 * fragments, wire-format libraries) — parsing, validation, and prompt
 * injection are API-side responsibilities. This module is therefore the
 * minimal expression tree and serializer shared by the fragment builder.
 */

/** The OpenUI Lang dialect this package emits. */
export const OPENUI_LANG_DIALECT = 'openui-lang/0.5';

/** The reserved assignment ref that designates the document root. */
export const OPENUI_ROOT_REF = 'root';

export type UiLiteralValue = string | number | boolean | null;

/** Expression tree for one assignment's right-hand side. */
export type UiExpr =
  | {
      kind: 'literal';
      value: UiLiteralValue;
    }
  | {
      kind: 'ref';
      name: string;
    }
  | {
      kind: 'state-ref';
      name: string;
    }
  | {
      kind: 'member';
      base: UiExpr;
      path: string[];
    }
  | {
      kind: 'array';
      items: UiExpr[];
    }
  | {
      kind: 'object';
      entries: Array<{
        key: string;
        value: UiExpr;
      }>;
    }
  | {
      kind: 'call';
      fn: string;
      builtin: boolean;
      args: UiExpr[];
    };

/**
 * A renderable piece of UI: the dialect it's expressed in plus its serialized
 * OpenUI Lang source. This is the shape carried on `tool.ui_fragment` stream
 * events and (for server tools) `response.openui.fragment` wire events.
 */
export interface UiFragment {
  dialect: string;
  source: string;
}

/**
 * Bare-identifier object keys, which the grammar accepts unquoted. Anything
 * else — spaces, quotes, punctuation, a leading digit, the empty string — must
 * be quoted or the emitted source does not parse.
 */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Object keys reach here from arbitrary tool-authored objects via `toExpr`, so
 * they cannot be assumed to be identifiers. The parser accepts a quoted key
 * (`parseObject` branches on `"`), so quoting the rest round-trips.
 */
function serializeKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

/**
 * Numbers that have no OpenUI Lang literal: `String(NaN)` is `NaN` and
 * `String(Infinity)` is `Infinity`, both of which serialize as bare identifiers
 * and would parse back as refs to undefined names (or fail outright). JSON has
 * the same hole and resolves it as `null`; do the same rather than emit source
 * that cannot round-trip.
 */
function serializeNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'null';
}

/** Serialize an expression to OpenUI Lang source. */
export function serializeExpr(expr: UiExpr): string {
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'string') {
        return JSON.stringify(expr.value);
      }
      return typeof expr.value === 'number' ? serializeNumber(expr.value) : String(expr.value);
    case 'ref':
      return expr.name;
    case 'state-ref':
      return `$${expr.name}`;
    case 'member':
      return `${serializeExpr(expr.base)}.${expr.path.join('.')}`;
    case 'array':
      return `[${expr.items.map(serializeExpr).join(', ')}]`;
    case 'object':
      return `{${expr.entries.map((e) => `${serializeKey(e.key)}: ${serializeExpr(e.value)}`).join(', ')}}`;
    case 'call':
      return `${expr.builtin ? '@' : ''}${expr.fn}(${expr.args.map(serializeExpr).join(', ')})`;
  }
}

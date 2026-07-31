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

/** Serialize an expression to OpenUI Lang source. */
export function serializeExpr(expr: UiExpr): string {
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'string' ? JSON.stringify(expr.value) : String(expr.value);
    case 'ref':
      return expr.name;
    case 'state-ref':
      return `$${expr.name}`;
    case 'member':
      return `${serializeExpr(expr.base)}.${expr.path.join('.')}`;
    case 'array':
      return `[${expr.items.map(serializeExpr).join(', ')}]`;
    case 'object':
      return `{${expr.entries.map((e) => `${e.key}: ${serializeExpr(e.value)}`).join(', ')}}`;
    case 'call':
      return `${expr.builtin ? '@' : ''}${expr.fn}(${expr.args.map(serializeExpr).join(', ')})`;
  }
}

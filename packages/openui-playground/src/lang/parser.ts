/**
 * Incremental OpenUI Lang parser — playground emulation layer.
 *
 * This is the reference streaming parser the API will own once DEV-770/771
 * land in openrouter-web. The playground carries its own copy so it can
 * emulate the `openui` plugin end-to-end today: inject the library prompt,
 * parse the model's text stream, and emit `response.openui.*`-shaped events
 * — which is exactly what lets us bench/eval renderer behavior and model
 * output quality before the API path exists.
 *
 * The language is line-oriented — one assignment statement per line — so the
 * parser is a line assembler (bracket- and string-aware, so a statement whose
 * brackets span lines still parses) feeding a per-statement recursive-descent
 * expression parser. It is tolerant by design: prose, fences, and unparseable
 * lines become diagnostics, never throws.
 */
import type { UiExpr } from '@openrouter/agent';
import { OPENUI_LANG_DIALECT, OPENUI_ROOT_REF } from '@openrouter/agent';

/** Classification of one assignment statement. */
export type UiStatementKind = 'component' | 'query' | 'mutation' | 'state' | 'value';

/** One parsed assignment statement. */
export interface UiAssignment {
  /** Assignment target. State declarations keep their `$` prefix (`'$tab'`). */
  ref: string;
  kind: UiStatementKind;
  expr: UiExpr;
  /** 1-indexed statement line within the turn's output. */
  line: number;
}

/** A non-fatal parse problem (unparseable or prose line). */
export interface UiDiagnostic {
  line: number;
  message: string;
  source: string;
}

/** The materialized document — the mounted tree plus state and data bindings. */
export interface UiDocument {
  dialect: string;
  /** `'root'` when the document assigned the reserved root ref, else null. */
  root: string | null;
  /** Assignments keyed by ref (state refs keyed with their `$` prefix). */
  assignments: Record<string, UiAssignment>;
  /** Refs in statement order. Re-assignment moves a ref to the end. */
  order: string[];
  diagnostics: UiDiagnostic[];
}

export function emptyDocument(dialect: string = OPENUI_LANG_DIALECT): UiDocument {
  return {
    dialect,
    root: null,
    assignments: {},
    order: [],
    diagnostics: [],
  };
}

//#region Statement scanner (line assembler)

const FENCE_PREFIX = '```';
const COMMENT_PREFIXES = [
  '#',
  '//',
];

interface ScannerState {
  buffer: string;
  depth: number;
  inString: boolean;
  escaped: boolean;
  line: number;
}

function freshScannerState(): ScannerState {
  return {
    buffer: '',
    depth: 0,
    inString: false,
    escaped: false,
    line: 0,
  };
}

interface ScannedStatement {
  source: string;
  line: number;
}

/**
 * Consume raw text, returning each completed top-level statement line.
 * Newlines inside brackets or strings do not terminate a statement.
 */
function scanStatements(state: ScannerState, text: string): ScannedStatement[] {
  const completed: ScannedStatement[] = [];
  for (const ch of text) {
    if (ch === '\n' && state.depth <= 0 && !state.inString) {
      flushStatement(state, completed);
      continue;
    }
    state.buffer += ch;
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (ch === '\\') {
        state.escaped = true;
      } else if (ch === '"') {
        state.inString = false;
      }
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      state.depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      state.depth -= 1;
    }
  }
  return completed;
}

function flushStatement(state: ScannerState, out: ScannedStatement[]): void {
  state.line += 1;
  const source = state.buffer.trim();
  state.buffer = '';
  state.depth = 0;
  state.inString = false;
  state.escaped = false;
  if (source.length === 0) {
    return;
  }
  out.push({
    source,
    line: state.line,
  });
}

//#endregion

//#region Expression parser

class ParseFailure extends Error {}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

class ExprParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parseExpr(): UiExpr {
    this.skipWs();
    const ch = this.peek();
    if (ch === undefined) {
      throw new ParseFailure('unexpected end of expression');
    }
    if (ch === '"') {
      return {
        kind: 'literal',
        value: this.parseString(),
      };
    }
    if (ch === '[') {
      return this.parseArray();
    }
    if (ch === '{') {
      return this.parseObject();
    }
    if (ch === '-' || isDigit(ch)) {
      return {
        kind: 'literal',
        value: this.parseNumber(),
      };
    }
    if (ch === '$') {
      this.pos += 1;
      const name = this.parseIdent();
      return this.maybeMember({
        kind: 'state-ref',
        name,
      });
    }
    if (ch === '@') {
      this.pos += 1;
      const fn = this.parseIdent();
      return this.maybeMember({
        kind: 'call',
        fn,
        builtin: true,
        args: this.parseArgs(),
      });
    }
    if (isIdentStart(ch)) {
      const name = this.parseIdent();
      if (name === 'true') {
        return {
          kind: 'literal',
          value: true,
        };
      }
      if (name === 'false') {
        return {
          kind: 'literal',
          value: false,
        };
      }
      if (name === 'null') {
        return {
          kind: 'literal',
          value: null,
        };
      }
      this.skipWs();
      if (this.peek() === '(') {
        return this.maybeMember({
          kind: 'call',
          fn: name,
          builtin: false,
          args: this.parseArgs(),
        });
      }
      return this.maybeMember({
        kind: 'ref',
        name,
      });
    }
    throw new ParseFailure(`unexpected character '${ch}'`);
  }

  /** Fails unless the whole source was consumed. */
  parseComplete(): UiExpr {
    const expr = this.parseExpr();
    this.skipWs();
    if (this.pos < this.src.length) {
      throw new ParseFailure(`trailing content after expression: '${this.src.slice(this.pos)}'`);
    }
    return expr;
  }

  private maybeMember(base: UiExpr): UiExpr {
    this.skipWs();
    if (this.peek() !== '.') {
      return base;
    }
    const path: string[] = [];
    while (this.peek() === '.') {
      this.pos += 1;
      path.push(this.parseIdent());
    }
    return {
      kind: 'member',
      base,
      path,
    };
  }

  private parseArgs(): UiExpr[] {
    this.expect('(');
    const args: UiExpr[] = [];
    this.skipWs();
    if (this.peek() === ')') {
      this.pos += 1;
      return args;
    }
    for (;;) {
      args.push(this.parseExpr());
      this.skipWs();
      const ch = this.peek();
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === ')') {
        this.pos += 1;
        return args;
      }
      throw new ParseFailure(`expected ',' or ')' in arguments, got '${ch ?? 'end'}'`);
    }
  }

  private parseArray(): UiExpr {
    this.expect('[');
    const items: UiExpr[] = [];
    this.skipWs();
    if (this.peek() === ']') {
      this.pos += 1;
      return {
        kind: 'array',
        items,
      };
    }
    for (;;) {
      items.push(this.parseExpr());
      this.skipWs();
      const ch = this.peek();
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === ']') {
        this.pos += 1;
        return {
          kind: 'array',
          items,
        };
      }
      throw new ParseFailure(`expected ',' or ']' in array, got '${ch ?? 'end'}'`);
    }
  }

  private parseObject(): UiExpr {
    this.expect('{');
    const entries: Array<{
      key: string;
      value: UiExpr;
    }> = [];
    this.skipWs();
    if (this.peek() === '}') {
      this.pos += 1;
      return {
        kind: 'object',
        entries,
      };
    }
    for (;;) {
      this.skipWs();
      const key = this.peek() === '"' ? this.parseString() : this.parseIdent();
      this.skipWs();
      this.expect(':');
      entries.push({
        key,
        value: this.parseExpr(),
      });
      this.skipWs();
      const ch = this.peek();
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '}') {
        this.pos += 1;
        return {
          kind: 'object',
          entries,
        };
      }
      throw new ParseFailure(`expected ',' or '}' in object, got '${ch ?? 'end'}'`);
    }
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) {
        throw new ParseFailure('unterminated string');
      }
      this.pos += 1;
      if (ch === '"') {
        return out;
      }
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const esc = this.src[this.pos];
      if (esc === undefined) {
        throw new ParseFailure('unterminated escape');
      }
      this.pos += 1;
      if (esc === 'n') {
        out += '\n';
      } else if (esc === 't') {
        out += '\t';
      } else {
        out += esc;
      }
    }
  }

  private parseNumber(): number {
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (!match) {
      throw new ParseFailure('invalid number');
    }
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private parseIdent(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!match) {
      throw new ParseFailure(`expected identifier at '${this.src.slice(this.pos, this.pos + 8)}'`);
    }
    this.pos += match[0].length;
    return match[0];
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) {
      throw new ParseFailure(`expected '${ch}', got '${this.src[this.pos] ?? 'end'}'`);
    }
    this.pos += 1;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos] ?? '')) {
      this.pos += 1;
    }
  }
}

//#endregion

//#region Statement parsing

const STATEMENT_RE = /^(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s;

function classify(ref: string, expr: UiExpr): UiStatementKind {
  if (ref.startsWith('$')) {
    return 'state';
  }
  if (expr.kind === 'call' && !expr.builtin) {
    if (expr.fn === 'Query') {
      return 'query';
    }
    if (expr.fn === 'Mutation') {
      return 'mutation';
    }
    return 'component';
  }
  return 'value';
}

/** Parse one statement line. Returns null for fences/comments; throws never. */
function parseStatement(source: string, line: number): UiAssignment | UiDiagnostic | null {
  if (source.startsWith(FENCE_PREFIX) || COMMENT_PREFIXES.some((p) => source.startsWith(p))) {
    return null;
  }
  const match = STATEMENT_RE.exec(source);
  if (!match) {
    return {
      line,
      message: 'not an assignment statement',
      source,
    };
  }
  const ref = match[1] ?? '';
  const rhs = match[2] ?? '';
  try {
    const expr = new ExprParser(rhs).parseComplete();
    return {
      ref,
      kind: classify(ref, expr),
      expr,
      line,
    };
  } catch (e) {
    const message = e instanceof ParseFailure ? e.message : String(e);
    return {
      line,
      message,
      source,
    };
  }
}

function isAssignment(value: UiAssignment | UiDiagnostic): value is UiAssignment {
  return 'ref' in value;
}

/**
 * Streaming parser: feed deltas with `push`, read completed assignments as
 * they land, and `end()` to flush the trailing unterminated line and get the
 * document. Also usable one-shot via `parseDocument`.
 */
export class OpenUiLangParser {
  private readonly scanner = freshScannerState();
  private readonly doc: UiDocument;

  constructor(dialect?: string) {
    this.doc = emptyDocument(dialect);
  }

  /** Feed a text delta; returns assignments completed by this chunk. */
  push(delta: string): UiAssignment[] {
    return scanStatements(this.scanner, delta)
      .map(({ source, line }) => this.accept(source, line))
      .filter((a): a is UiAssignment => a !== null);
  }

  /** Flush the trailing line and return the finished document. */
  end(): UiDocument {
    const completed: ScannedStatement[] = [];
    flushStatement(this.scanner, completed);
    for (const { source, line } of completed) {
      this.accept(source, line);
    }
    return this.doc;
  }

  private accept(source: string, line: number): UiAssignment | null {
    const parsed = parseStatement(source, line);
    if (parsed === null) {
      return null;
    }
    if (!isAssignment(parsed)) {
      this.doc.diagnostics.push(parsed);
      return null;
    }
    const existing = this.doc.assignments[parsed.ref];
    this.doc.assignments[parsed.ref] = parsed;
    if (existing !== undefined) {
      this.doc.order.splice(this.doc.order.indexOf(parsed.ref), 1);
    }
    this.doc.order.push(parsed.ref);
    if (parsed.ref === OPENUI_ROOT_REF) {
      this.doc.root = OPENUI_ROOT_REF;
    }
    return parsed;
  }
}

/** One-shot parse of a full turn's output. */
export function parseDocument(text: string, dialect?: string): UiDocument {
  const parser = new OpenUiLangParser(dialect);
  parser.push(text);
  return parser.end();
}

//#endregion

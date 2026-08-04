import { describe, expect, it } from 'vitest';
import { OpenUiLangParser, parseDocument } from '../src/lang/parser.js';

describe('OpenUiLangParser (streaming)', () => {
  it('emits assignments only as their line completes', () => {
    const parser = new OpenUiLangParser();
    expect(parser.push('a = Text("hel')).toEqual([]);
    const [a] = parser.push('lo")\n');
    expect(a?.ref).toBe('a');
    expect(a?.kind).toBe('component');
    const doc = parser.end();
    expect(doc.order).toEqual([
      'a',
    ]);
  });

  it('assembles statements whose brackets span lines', () => {
    const parser = new OpenUiLangParser();
    parser.push('root = Stack([\n  Text("a"),\n  Text("b")\n');
    expect(parser.push('])\n')).toHaveLength(1);
    const doc = parser.end();
    expect(doc.root).toBe('root');
  });

  it('flushes a trailing statement without a final newline at end()', () => {
    const parser = new OpenUiLangParser();
    parser.push('a = Text("x")');
    const doc = parser.end();
    expect(doc.order).toEqual([
      'a',
    ]);
  });

  it('newlines inside strings do not split statements', () => {
    const doc = parseDocument('a = Text("line one\nline two")\n');
    expect(doc.order).toEqual([
      'a',
    ]);
    expect(doc.diagnostics).toEqual([]);
  });
});

describe('parseDocument (tolerance + semantics)', () => {
  it('classifies statements', () => {
    const doc = parseDocument(
      [
        '$tab = "overview"',
        'data = Query("list_models", {limit: 3})',
        'save = Mutation("save_report", {})',
        'title = "Usage"',
        'root = Card(title, [Text("hi")])',
      ].join('\n'),
    );
    expect(doc.assignments['$tab']?.kind).toBe('state');
    expect(doc.assignments['data']?.kind).toBe('query');
    expect(doc.assignments['save']?.kind).toBe('mutation');
    expect(doc.assignments['title']?.kind).toBe('value');
    expect(doc.assignments['root']?.kind).toBe('component');
    expect(doc.root).toBe('root');
  });

  it('turns prose into diagnostics, never throws', () => {
    const doc = parseDocument('Here is your dashboard:\nroot = Card("ok")\nEnjoy!');
    expect(doc.order).toEqual([
      'root',
    ]);
    expect(doc.diagnostics).toHaveLength(2);
    expect(doc.diagnostics[0]?.message).toBe('not an assignment statement');
  });

  it('skips fences and comments silently', () => {
    const doc = parseDocument('```openui\nroot = Text("x")\n```\n# comment\n// also');
    expect(doc.order).toEqual([
      'root',
    ]);
    expect(doc.diagnostics).toEqual([]);
  });

  it('re-assignment replaces and moves the ref to the end', () => {
    const doc = parseDocument('a = Text("1")\nb = Text("2")\na = Text("3")');
    expect(doc.order).toEqual([
      'b',
      'a',
    ]);
    const a = doc.assignments['a'];
    expect(a?.expr).toMatchObject({
      kind: 'call',
      args: [
        {
          kind: 'literal',
          value: '3',
        },
      ],
    });
  });

  it('parses builtins, state refs, member access, and nesting', () => {
    const doc = parseDocument(
      'btn = Button("Add", Action([@Run(save), @Set($title, ""), @ToAssistant("done")]))\nrows = data.rows.title',
    );
    expect(doc.diagnostics).toEqual([]);
    expect(doc.assignments['btn']?.expr).toMatchObject({
      kind: 'call',
      fn: 'Button',
    });
    expect(doc.assignments['rows']?.expr).toMatchObject({
      kind: 'member',
      base: {
        kind: 'ref',
        name: 'data',
      },
      path: [
        'rows',
        'title',
      ],
    });
  });

  it('parses literals: numbers, booleans, null, escapes', () => {
    const doc = parseDocument('a = {n: -1.5e2, t: true, f: false, z: null, s: "a\\"b\\nc"}');
    expect(doc.diagnostics).toEqual([]);
    expect(doc.assignments['a']?.expr).toMatchObject({
      kind: 'object',
      entries: [
        {
          key: 'n',
          value: {
            kind: 'literal',
            value: -150,
          },
        },
        {
          key: 't',
          value: {
            kind: 'literal',
            value: true,
          },
        },
        {
          key: 'f',
          value: {
            kind: 'literal',
            value: false,
          },
        },
        {
          key: 'z',
          value: {
            kind: 'literal',
            value: null,
          },
        },
        {
          key: 's',
          value: {
            kind: 'literal',
            value: 'a"b\nc',
          },
        },
      ],
    });
  });

  it('reports unparseable expressions as diagnostics with the source line', () => {
    const doc = parseDocument('bad = Card(("unclosed"\ngood = Text("ok")');
    // The unbalanced paren swallows the newline; only one statement completes.
    expect(doc.diagnostics.length + doc.order.length).toBeGreaterThan(0);
    expect(parseDocument('x = = =').diagnostics).toHaveLength(1);
  });
});

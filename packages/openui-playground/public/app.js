/**
 * OpenUI playground client: posts a prompt to /api/generate, consumes the SSE
 * stream, and progressively renders the generated document.
 *
 * The renderer implements the demo library (see src/demo-library.ts — keep in
 * sync). Statements arrive with their parsed expression tree attached, so the
 * client resolves refs/state and materializes DOM without its own parser.
 */

import { escapeHtml, renderDiagnostic, resolveMember } from './render-utils.js';

const $ = (id) => document.getElementById(id);

const PRESETS = [
  [
    'Dashboard',
    'Show a dashboard for this month: $128.40 spend (+12%), 41,203 requests, 9 models. Table of top 3 models by spend, budget progress at 64%.',
  ],
  [
    'Form',
    'Build a support-ticket form: severity select (low/medium/high), a title input, and a submit button.',
  ],
  [
    'Status page',
    'A status page: API operational (success badge), Dashboard degraded (warning badge), a table of the last 3 incidents with dates.',
  ],
  [
    'Re-render',
    'Show a counter card with value 1. Then update the same card to value 2, then 3, by re-assigning the same refs.',
  ],
  [
    'Adversarial',
    'Explain what OpenUI is in prose, and ALSO show a card titled "OpenUI" with a one-line description. (The prose should become diagnostics, not break rendering.)',
  ],
];

// ---------------------------------------------------------------------------
// Document state: ordered refs → assignment (mirrors UiDocument semantics)
// ---------------------------------------------------------------------------

const doc = {
  order: [],
  assignments: new Map(),
  stateVars: new Map(),
};

function resetDoc() {
  doc.order.length = 0;
  doc.assignments.clear();
  doc.stateVars.clear();
}

function applyStatement(stmt) {
  if (stmt.ref.startsWith('$')) {
    doc.stateVars.set(stmt.ref.slice(1), stmt.expr ? literalOf(stmt.expr) : null);
  }
  if (doc.assignments.has(stmt.ref)) {
    doc.order.splice(doc.order.indexOf(stmt.ref), 1);
  }
  doc.assignments.set(stmt.ref, stmt);
  doc.order.push(stmt.ref);
}

function literalOf(expr) {
  return expr && expr.kind === 'literal' ? expr.value : null;
}

// ---------------------------------------------------------------------------
// Expression → value / DOM
// ---------------------------------------------------------------------------

function evalExpr(expr, depth = 0) {
  if (!expr || depth > 32) {
    return null;
  }
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'array':
      return expr.items.map((e) => evalExpr(e, depth + 1));
    case 'object': {
      const out = {};
      for (const { key, value } of expr.entries) {
        out[key] = evalExpr(value, depth + 1);
      }
      return out;
    }
    case 'state-ref':
      return doc.stateVars.get(expr.name) ?? null;
    case 'ref': {
      const target = doc.assignments.get(expr.name);
      return target ? evalExpr(target.expr, depth + 1) : null;
    }
    case 'member':
      return resolveMember(evalExpr(expr.base, depth + 1), expr.path);
    case 'call':
      return expr; // calls materialize as DOM, not values
    default:
      return null;
  }
}

function renderExpr(expr, depth = 0) {
  if (!expr || depth > 32) {
    return null;
  }
  if (expr.kind === 'ref') {
    const target = doc.assignments.get(expr.name);
    return target ? renderExpr(target.expr, depth + 1) : textNode(`⟨${expr.name}?⟩`, 'ui-unknown');
  }
  if (expr.kind === 'state-ref') {
    return textNode(String(doc.stateVars.get(expr.name) ?? ''), 'ui-text');
  }
  if (expr.kind === 'array') {
    const frag = document.createDocumentFragment();
    for (const item of expr.items) {
      const node = renderExpr(item, depth + 1);
      if (node) {
        frag.appendChild(node);
      }
    }
    return frag;
  }
  if (expr.kind === 'literal') {
    return textNode(String(expr.value ?? ''), 'ui-text');
  }
  if (expr.kind === 'call') {
    return renderCall(expr, depth);
  }
  return null;
}

function textNode(text, cls) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return el;
}

function el(tag, cls, children) {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  for (const child of children ?? []) {
    if (child) {
      node.appendChild(child);
    }
  }
  return node;
}

/** Positional args → named props using the component's signature. */
const SIGNATURES = {
  Stack: [
    'children',
    'direction',
    'gap',
  ],
  Card: [
    'title',
    'children',
  ],
  Heading: [
    'text',
    'level',
  ],
  Text: [
    'value',
    'muted',
  ],
  Stat: [
    'label',
    'value',
    'delta',
  ],
  Badge: [
    'text',
    'tone',
  ],
  Table: [
    'columns',
    'rows',
  ],
  Input: [
    'name',
    'value',
    'placeholder',
  ],
  Select: [
    'name',
    'options',
    'value',
  ],
  Button: [
    'label',
    'action',
    'variant',
  ],
  Progress: [
    'value',
    'label',
  ],
};

function propsOf(call) {
  const names = SIGNATURES[call.fn] ?? [];
  const props = {};
  call.args.forEach((arg, i) => {
    const name = names[i] ?? `arg${i}`;
    props[name] = arg;
  });
  return props;
}

/*
 * Form controls and meters, split out of `renderCall` so neither function
 * exceeds the structural gate's per-function complexity ceiling. `val` and
 * `children` are passed in rather than recomputed — they close over `depth`.
 */
function renderControl(call, val) {
  switch (call.fn) {
    case 'Input': {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ui-input';
      input.placeholder = String(val('placeholder', ''));
      const v = val('value', '');
      if (v) {
        input.value = String(v);
      }
      // The signature's `name` is the only human label these controls carry;
      // without it a screen reader announces an unlabelled text field. Fall
      // back to the placeholder when a name wasn't supplied.
      const inputLabel = String(val('name', '') || val('placeholder', ''));
      if (inputLabel) {
        input.setAttribute('aria-label', inputLabel);
        input.name = String(val('name', ''));
      }
      return input;
    }
    case 'Select': {
      const select = document.createElement('select');
      select.className = 'ui-select';
      const selectLabel = String(val('name', ''));
      if (selectLabel) {
        select.setAttribute('aria-label', selectLabel);
        select.name = selectLabel;
      }
      for (const opt of val('options', [])) {
        const o = document.createElement('option');
        o.textContent = String(opt);
        select.appendChild(o);
      }
      return select;
    }
    case 'Button': {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ui-button ${val('variant', 'secondary')}`;
      btn.textContent = String(val('label', 'Button'));
      btn.addEventListener('click', () =>
        setStatus('action fired (client event ingestion is Phase 3 — DEV-774)'),
      );
      return btn;
    }
    case 'Progress': {
      const value = Math.min(100, Math.max(0, Number(val('value', 0))));
      const bar = el('div', 'ui-progress', [
        el('div'),
      ]);
      bar.firstChild.style.width = `${value}%`;
      // The fill width is invisible to AT — mirror the value into ARIA.
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', String(value));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const label = val('label', null);
      if (label) {
        bar.setAttribute('aria-label', String(label));
      }
      return label
        ? el('div', null, [
            textNode(`${String(label)} (${value}%)`, 'ui-text muted'),
            bar,
          ])
        : bar;
    }
    default:
      return undefined; // not a control — caller falls through
  }
}

/** Tabular data, split out for the same reason as `renderControl`. */
function renderTable(val) {
  const columns = val('columns', []);
  const rows = val('rows', []);
  const table = document.createElement('table');
  table.className = 'ui-table';
  if (Array.isArray(columns)) {
    const tr = document.createElement('tr');
    for (const c of columns) {
      tr.appendChild(
        el('th', null, [
          document.createTextNode(String(c)),
        ]),
      );
    }
    table.appendChild(tr);
  }
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of Array.isArray(row)
        ? row
        : [
            row,
          ]) {
        tr.appendChild(
          el('td', null, [
            document.createTextNode(String(cell)),
          ]),
        );
      }
      table.appendChild(tr);
    }
  }
  return table;
}

function renderCall(call, depth) {
  if (call.builtin) {
    return null; // @Run/@Set/... are action steps, not DOM
  }
  const p = propsOf(call);
  const val = (name, fallback) => {
    const v = p[name] !== undefined ? evalExpr(p[name], depth + 1) : undefined;
    return v === undefined || v === null || (v && v.kind === 'call') ? fallback : v;
  };
  const children = (name) => (p[name] ? renderExpr(p[name], depth + 1) : null);

  const control = renderControl(call, val);
  if (control !== undefined) {
    return control;
  }

  switch (call.fn) {
    case 'Stack': {
      const node = el('div', `ui-stack${val('direction', 'column') === 'row' ? ' row' : ''}`, [
        children('children'),
      ]);
      const gap = val('gap', null);
      if (typeof gap === 'number') {
        node.style.gap = `${gap}px`;
      }
      return node;
    }
    case 'Card': {
      const kids = [];
      const title = val('title', null);
      const titleIsText = typeof title === 'string';
      if (titleIsText) {
        kids.push(textNode(title, 'title'));
      }
      // Card("x", [...]) puts children second; Card([...]) puts them first.
      const body = titleIsText ? children('children') : (children('title') ?? children('children'));
      if (body) {
        kids.push(body);
      }
      return el('div', 'ui-card', kids);
    }
    case 'Heading': {
      const level = Math.min(3, Math.max(1, val('level', 2)));
      return textNode(String(val('text', '')), `ui-heading${level}`);
    }
    case 'Text':
      return textNode(String(val('value', '')), `ui-text${val('muted', false) ? ' muted' : ''}`);
    case 'Stat': {
      const kids = [
        textNode(String(val('value', '')), 'v'),
        textNode(String(val('label', '')), 'l'),
      ];
      const delta = val('delta', null);
      if (delta) {
        kids.push(textNode(String(delta), 'd'));
      }
      return el('div', 'ui-stat', kids);
    }
    case 'Badge':
      return textNode(String(val('text', '')), `ui-badge ${val('tone', 'neutral')}`);
    case 'Table':
      return renderTable(val);
    case 'Query':
    case 'Mutation':
    case 'Action':
    case 'ToolView':
      return null; // data/action bindings — no direct DOM in the playground yet
    default:
      return textNode(`⟨unknown component ${call.fn}⟩`, 'ui-unknown');
  }
}

function renderSurface() {
  const surface = $('surface');
  surface.replaceChildren();
  const rootStmt = doc.assignments.get('root');
  if (!rootStmt) {
    // No root yet: render every component statement in order (progressive view).
    const stack = el('div', 'ui-stack');
    for (const ref of doc.order) {
      const stmt = doc.assignments.get(ref);
      if (stmt && stmt.kind === 'component') {
        const node = renderExpr(stmt.expr);
        if (node) {
          stack.appendChild(node);
        }
      }
    }
    surface.appendChild(
      stack.childNodes.length
        ? stack
        : el('div', 'placeholder', [
            document.createTextNode('Waiting for statements…'),
          ]),
    );
    return;
  }
  const node = renderExpr(rootStmt.expr);
  surface.appendChild(
    node ??
      el('div', 'placeholder', [
        document.createTextNode('Root did not render.'),
      ]),
  );
}

// ---------------------------------------------------------------------------
// Stats + history
// ---------------------------------------------------------------------------

const history = [];

function statTile(label, value) {
  return `<div class="stat-tile"><div class="v">${value}</div><div class="l">${label}</div></div>`;
}

function renderStats(s) {
  const fmt = (v, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`);
  $('stats').innerHTML = [
    statTile('TTFB', fmt(s.ttfbMs, 'ms')),
    statTile('1st stmt', fmt(s.firstStatementMs, 'ms')),
    statTile('total', fmt(s.totalMs, 'ms')),
    statTile('statements', fmt(s.statements)),
    statTile('diagnostics', fmt(s.diagnostics)),
    statTile('out tokens', fmt(s.outputTokens)),
  ].join('');
}

function renderHistory() {
  if (!history.length) {
    return;
  }
  const rows = history
    .map(
      (h) =>
        `<tr><td>${escapeHtml(`${h.model} · ${h.mode}`)}</td><td>${h.ttfbMs ?? '—'}</td><td>${h.firstStatementMs ?? '—'}</td><td>${h.totalMs}</td><td>${h.statements}</td><td>${h.diagnostics}</td><td>${h.outputTokens ?? '—'}</td><td>${h.cost !== null ? `$${h.cost.toFixed(5)}` : '—'}</td></tr>`,
    )
    .join('');
  $('history').innerHTML =
    `<table><tr><th>run</th><th>ttfb</th><th>1st</th><th>total</th><th>stmts</th><th>diag</th><th>tok</th><th>cost</th></tr>${rows}</table>`;
}

function setStatus(text, isError = false) {
  const status = $('status');
  status.textContent = text;
  status.className = isError ? 'dialect err' : 'dialect';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function boot() {
  const meta = await (await fetch('/api/library')).json();
  $('dialect').textContent = `${meta.dialect} · ${meta.components.length} components`;
  $('libprompt').textContent = meta.prompt;
  $('model').value = meta.defaultModel;
  for (const [name, prompt] of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.addEventListener('click', () => {
      $('prompt').value = prompt;
    });
    $('presets').appendChild(b);
  }
}

/*
 * Whether the current run streamed an `error` frame. The server always ends
 * the SSE stream normally after an error frame, so `run()` must not overwrite
 * the error status with a green "done" when the reader drains.
 */
let streamErrored = false;

async function run() {
  const runBtn = $('run');
  runBtn.disabled = true;
  streamErrored = false;
  resetDoc();
  $('lang').replaceChildren();
  $('events').textContent = '';
  $('diagnostics').innerHTML = '<span style="color:var(--muted)">—</span>';
  $('stats').innerHTML = '';
  renderSurface();
  setStatus('generating…');

  const mode = document.querySelector('input[name=mode]:checked').value;
  const body = {
    prompt: $('prompt').value,
    model: $('model').value,
    mode,
  };

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({
        error: res.statusText,
      }));
      throw new Error(err.error ?? 'request failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {
        stream: true,
      });
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
        if (!frame.startsWith('data: ')) {
          continue;
        }
        const payload = frame.slice(6);
        if (payload === '[DONE]') {
          continue;
        }
        handleEvent(JSON.parse(payload));
      }
    }
    if (!streamErrored) {
      setStatus('done');
    }
  } catch (error) {
    setStatus(String(error.message ?? error), true);
  } finally {
    runBtn.disabled = false;
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'text':
      $('events').textContent += event.delta;
      break;
    case 'statement': {
      applyStatement(event);
      renderSurface();
      const line = document.createElement('div');
      line.className = 'stmt';
      line.textContent = `[${String(event.at).padStart(5)}ms] ${event.source}`;
      $('lang').appendChild(line);
      $('lang').scrollTop = $('lang').scrollHeight;
      break;
    }
    case 'fragment': {
      const line = document.createElement('div');
      line.className = 'stmt';
      line.textContent = `[fragment${event.toolCallId ? ` ${event.toolCallId}` : ''}] ${event.source}`;
      $('lang').appendChild(line);
      break;
    }
    case 'document': {
      if (event.diagnostics.length) {
        $('diagnostics').innerHTML = event.diagnostics
          // Every interpolated field is model-controlled: `source` is the
          // offending line and `message` carries parser text built from it
          // (ParseFailure.message), or arrives verbatim off the wire in native
          // mode. Escaping only `source` left an injection through `message`.
          .map(renderDiagnostic)
          .join('');
      } else {
        $('diagnostics').innerHTML =
          '<span style="color:var(--success)">clean parse — no diagnostics</span>';
      }
      break;
    }
    case 'stats':
      renderStats(event);
      history.unshift(event);
      renderHistory();
      break;
    case 'error':
      streamErrored = true;
      setStatus(event.message, true);
      break;
  }
}

$('run').addEventListener('click', run);
boot().catch((error) => setStatus(String(error), true));

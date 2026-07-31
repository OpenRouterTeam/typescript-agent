/**
 * The playground's generation core: run one OpenUI turn against a model and
 * emit a normalized event stream the client renders progressively.
 *
 * Two modes:
 * - `emulate` (default) — works today. Injects the library prompt locally and
 *   runs the streaming parser over the model's text stream, emitting the same
 *   statement/document events the API's `openui` plugin will emit natively.
 * - `native` — sends the `openui(library)` plugin preference and consumes
 *   `getUiStream()`. Useful the moment DEV-771/DEV-772 land; until then the
 *   API rejects the unknown plugin id.
 *
 * Every run also emits bench stats (TTFB, first-statement latency, statement
 * count, token usage, cost) so the playground doubles as an eval harness.
 */

import type { UiLibrary } from '@openrouter/agent';
import { callModel, openui, serializeExpr } from '@openrouter/agent';
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { UiAssignment, UiDocument } from './lang/parser.js';
import { OpenUiLangParser } from './lang/parser.js';
import { libraryPrompt } from './lang/prompt.js';

export type GenerateMode = 'emulate' | 'native';

export interface GenerateRequest {
  prompt: string;
  model: string;
  mode?: GenerateMode;
  /** Optional extra system prompt prepended before the library prompt. */
  system?: string;
}

/** Normalized playground stream events (superset of the wire protocol shapes). */
export type PlaygroundEvent =
  | {
      type: 'statement';
      ref: string;
      kind: string;
      source: string;
      /**
       * Parsed expression tree (playground extra, not on the wire protocol) —
       * lets the client render without carrying its own parser. Absent in
       * native mode until the wire protocol grows one.
       */
      expr?: unknown;
      at: number;
    }
  | {
      type: 'fragment';
      toolCallId?: string;
      dialect: string;
      source: string;
      at: number;
    }
  | {
      type: 'text';
      delta: string;
    }
  | {
      type: 'document';
      root: string | null;
      dialect: string;
      statements: number;
      diagnostics: Array<{
        line: number;
        message: string;
        source: string;
      }>;
    }
  | {
      type: 'stats';
      mode: GenerateMode;
      model: string;
      ttfbMs: number | null;
      firstStatementMs: number | null;
      totalMs: number;
      statements: number;
      diagnostics: number;
      chars: number;
      inputTokens: number | null;
      outputTokens: number | null;
      cost: number | null;
    }
  | {
      type: 'error';
      message: string;
    };

interface UsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}

function extractUsage(response: unknown): UsageSummary {
  const usage =
    typeof response === 'object' && response !== null
      ? (
          response as {
            usage?: Record<string, unknown>;
          }
        ).usage
      : undefined;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    inputTokens: num(usage?.['inputTokens']),
    outputTokens: num(usage?.['outputTokens']),
    cost: num(usage?.['cost']),
  };
}

/**
 * Run one generation and yield playground events as they materialize.
 */
export async function* generate(
  client: OpenRouterCore,
  library: UiLibrary,
  request: GenerateRequest,
): AsyncGenerator<PlaygroundEvent> {
  const mode: GenerateMode = request.mode ?? 'emulate';
  const start = Date.now();
  let ttfbMs: number | null = null;
  let firstStatementMs: number | null = null;
  let statements = 0;
  let chars = 0;

  if (mode === 'native') {
    // Native path: the API owns prompting + parsing; we consume getUiStream().
    const result = callModel(client, {
      model: request.model,
      input: request.prompt,
      ...(request.system !== undefined && {
        instructions: request.system,
      }),
      plugins: [
        openui(library) as never,
      ],
    });

    for await (const event of result.getUiStream()) {
      if (ttfbMs === null) {
        ttfbMs = Date.now() - start;
      }
      if (event.type === 'statement') {
        if (firstStatementMs === null) {
          firstStatementMs = Date.now() - start;
        }
        statements += 1;
        chars += event.source.length;
        yield {
          ...event,
          at: Date.now() - start,
        };
      } else if (event.type === 'fragment') {
        yield {
          ...event,
          at: Date.now() - start,
        };
      } else {
        yield {
          type: 'document',
          root: event.root,
          dialect: event.dialect,
          statements,
          diagnostics: event.diagnostics.map((d) => ({
            line: d.line ?? 0,
            message: d.message,
            source: d.source ?? '',
          })),
        };
      }
    }

    const usage = extractUsage(await result.getResponse());
    yield {
      type: 'stats',
      mode,
      model: request.model,
      ttfbMs,
      firstStatementMs,
      totalMs: Date.now() - start,
      statements,
      diagnostics: 0,
      chars,
      ...usage,
    };
    return;
  }

  // Emulate path: inject the library prompt locally, parse the text stream.
  const instructions = [
    request.system,
    libraryPrompt(library),
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = callModel(client, {
    model: request.model,
    input: request.prompt,
    instructions,
  });

  const parser = new OpenUiLangParser(library.dialect);
  let lastEmittedLine = 0;
  for await (const delta of result.getTextStream()) {
    if (ttfbMs === null) {
      ttfbMs = Date.now() - start;
    }
    chars += delta.length;
    yield {
      type: 'text',
      delta,
    };
    for (const assignment of parser.push(delta)) {
      if (firstStatementMs === null) {
        firstStatementMs = Date.now() - start;
      }
      statements += 1;
      lastEmittedLine = assignment.line;
      yield {
        type: 'statement',
        ref: assignment.ref,
        kind: assignment.kind,
        source: serializeStatement(assignment.ref, assignment),
        expr: assignment.expr,
        at: Date.now() - start,
      };
    }
  }

  const doc: UiDocument = parser.end();
  // end() may flush one trailing statement that arrived without a final
  // newline — emit any assignment parsed past the last line we streamed.
  for (const ref of doc.order) {
    const assignment = doc.assignments[ref];
    if (assignment && assignment.line > lastEmittedLine) {
      if (firstStatementMs === null) {
        firstStatementMs = Date.now() - start;
      }
      statements += 1;
      yield {
        type: 'statement',
        ref: assignment.ref,
        kind: assignment.kind,
        source: serializeStatement(assignment.ref, assignment),
        expr: assignment.expr,
        at: Date.now() - start,
      };
    }
  }

  yield {
    type: 'document',
    root: doc.root,
    dialect: doc.dialect,
    statements: doc.order.length,
    diagnostics: doc.diagnostics,
  };

  const usage = extractUsage(await result.getResponse());
  yield {
    type: 'stats',
    mode,
    model: request.model,
    ttfbMs,
    firstStatementMs,
    totalMs: Date.now() - start,
    statements,
    diagnostics: doc.diagnostics.length,
    chars,
    ...usage,
  };
}

function serializeStatement(ref: string, assignment: UiAssignment): string {
  return `${ref} = ${serializeExpr(assignment.expr)}`;
}

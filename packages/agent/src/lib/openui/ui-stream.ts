/**
 * UI stream event model: the events `getUiStream()` yields, plus the
 * translation from raw response-stream events.
 *
 * Two sources feed the UI stream:
 * - `tool.ui_fragment` — SDK-synthetic events broadcast when a local tool's
 *   `toUIOutput` produces a fragment.
 * - `response.openui.*` — API wire events emitted by the `openui` plugin.
 *   Until `@openrouter/sdk` regenerates with these union members (DEV-772),
 *   they arrive through the SDK's forward-compat catch-all as
 *   `{ type: 'UNKNOWN', raw: {...}, isUnknown: true }` — so translation reads
 *   the raw payload, never the outer discriminant.
 */

/** One completed OpenUI Lang statement authored by the model. */
export interface UiStatementEvent {
  type: 'statement';
  /** Assignment target ref (state refs keep their `$` prefix). */
  ref: string;
  /** Statement classification: component | state | query | mutation | value. */
  kind: string;
  /** OpenUI Lang source of the single completed statement. */
  source: string;
}

/** A tool-authored fragment (local `toUIOutput` or API `response.openui.fragment`). */
export interface UiFragmentEvent {
  type: 'fragment';
  /** The tool call this fragment belongs to, when tool-authored. */
  toolCallId?: string;
  /** The tool that authored the fragment, when known (local tools only). */
  toolName?: string;
  dialect: string;
  source: string;
}

/** Turn-end document summary from the API (root ref + diagnostics). */
export interface UiDocumentEvent {
  type: 'document';
  root: string | null;
  dialect: string;
  diagnostics: Array<{
    line?: number;
    message: string;
    source?: string;
  }>;
}

/** Every event {@link ModelResult.getUiStream} yields. */
export type UiStreamEvent = UiStatementEvent | UiFragmentEvent | UiDocumentEvent;

/** Wire event types the `openui` plugin emits on the Responses stream. */
export const OPENUI_WIRE_EVENT = {
  Statement: 'response.openui.statement',
  Fragment: 'response.openui.fragment',
  Document: 'response.openui.document',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Unwrap the SDK's forward-compat catch-all: unrecognized SSE event types
 * parse to `{ type: 'UNKNOWN', raw: <original>, isUnknown: true }`. Returns
 * the payload carrying the real `type` either way.
 */
function unwrapEvent(event: unknown): Record<string, unknown> | null {
  if (!isRecord(event)) {
    return null;
  }
  if (event['isUnknown'] === true && isRecord(event['raw'])) {
    return event['raw'];
  }
  return event;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Translate one response-stream event into a UI stream event, or null when
 * the event carries nothing the UI renders. Handles both the SDK-synthetic
 * `tool.ui_fragment` and the API's `response.openui.*` wire events (including
 * their pre-regen `Unknown` encoding).
 */
/** `tool.ui_fragment`: a local tool's fragment, carried on the tool stream. */
function toolFragmentEvent(payload: Record<string, unknown>): UiStreamEvent | null {
  const fragment = payload['fragment'];
  if (!isRecord(fragment)) {
    return null;
  }
  const dialect = str(fragment['dialect']);
  const source = str(fragment['source']);
  if (dialect === undefined || source === undefined) {
    return null;
  }
  const result: UiFragmentEvent = {
    type: 'fragment',
    dialect,
    source,
  };
  const toolCallId = str(payload['toolCallId']);
  if (toolCallId !== undefined) {
    result.toolCallId = toolCallId;
  }
  const toolName = str(payload['toolName']);
  if (toolName !== undefined) {
    result.toolName = toolName;
  }
  return result;
}

/** `response.openui.statement`: one completed assignment from the API. */
function statementEvent(payload: Record<string, unknown>): UiStreamEvent | null {
  const ref = str(payload['ref']);
  const kind = str(payload['kind']);
  const source = str(payload['source']);
  if (ref === undefined || kind === undefined || source === undefined) {
    return null;
  }
  return {
    type: 'statement',
    ref,
    kind,
    source,
  };
}

/** `response.openui.fragment`: a server tool's fragment. */
function wireFragmentEvent(payload: Record<string, unknown>): UiStreamEvent | null {
  const dialect = str(payload['dialect']);
  const source = str(payload['source']);
  if (dialect === undefined || source === undefined) {
    return null;
  }
  const result: UiFragmentEvent = {
    type: 'fragment',
    dialect,
    source,
  };
  // Wire field is snake_case; tolerate camelCase for forward compat.
  const callId = str(payload['call_id']) ?? str(payload['callId']);
  if (callId !== undefined) {
    result.toolCallId = callId;
  }
  return result;
}

/** Diagnostics on a document event, skipping any entry without a message. */
function documentDiagnostics(raw: unknown): UiDocumentEvent['diagnostics'] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isRecord).flatMap((d) => {
    const message = str(d['message']);
    if (message === undefined) {
      return [];
    }
    const diagnostic: UiDocumentEvent['diagnostics'][number] = {
      message,
    };
    if (typeof d['line'] === 'number') {
      diagnostic.line = d['line'];
    }
    const source = str(d['source']);
    if (source !== undefined) {
      diagnostic.source = source;
    }
    return [
      diagnostic,
    ];
  });
}

/** `response.openui.document`: turn-end summary (root ref + diagnostics). */
function documentEvent(payload: Record<string, unknown>): UiStreamEvent | null {
  const dialect = str(payload['dialect']);
  if (dialect === undefined) {
    return null;
  }
  return {
    type: 'document',
    root: str(payload['root']) ?? null,
    dialect,
    diagnostics: documentDiagnostics(payload['diagnostics']),
  };
}

/*
 * Wire event -> stream event. Each case is its own function: the switch was one
 * body holding every field-validation branch, which put it over the structural
 * gate's per-function complexity ceiling.
 */
export function translateUiEvent(event: unknown): UiStreamEvent | null {
  const payload = unwrapEvent(event);
  if (!payload) {
    return null;
  }

  switch (payload['type']) {
    case 'tool.ui_fragment':
      return toolFragmentEvent(payload);
    case OPENUI_WIRE_EVENT.Statement:
      return statementEvent(payload);
    case OPENUI_WIRE_EVENT.Fragment:
      return wireFragmentEvent(payload);
    case OPENUI_WIRE_EVENT.Document:
      return documentEvent(payload);
    default:
      return null;
  }
}

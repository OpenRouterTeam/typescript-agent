/**
 * Best-effort recovery for malformed tool-call argument JSON.
 *
 * Models routinely emit argument payloads that fail `JSON.parse`, and today
 * every such call fails closed: the raw string is handed back to the model as
 * a parse error, which is classic doom-loop fuel (the model re-emits the same
 * malformed call). Production logs show two dominant, mechanically
 * recoverable failure shapes; this module currently repairs the first:
 *
 * **XML scaffold leak** (Claude family): the model starts JSON and then
 * slips into its internal tool-call scaffolding —
 * `{"action": \n<parameter name="commands">["ls"]}`. The parameter names
 * and JSON fragment values are intact, only the framing is wrong.
 *
 * Recovery is strictly safer than failing: every repaired value still flows
 * through the tool's Zod input schema before execution, so a bad repair
 * degrades into exactly today's behavior (a validation error returned to the
 * model), while a good repair avoids the retry loop entirely.
 */

/** How a malformed payload was recovered, for logging/observability. */
export type ToolArgumentsRepairStrategy = 'xml-scaffold';

export type ToolArgumentsParseResult =
  | {
      status: 'parsed';
      value: unknown;
    }
  | {
      status: 'repaired';
      value: unknown;
      strategy: ToolArgumentsRepairStrategy;
    }
  | {
      status: 'unparseable';
    };

/** Payloads beyond this size are not worth scanning for repair. */
const MAX_REPAIRABLE_LENGTH = 1_000_000;

/**
 * Parse a tool-call arguments string, attempting recovery when it is not
 * valid JSON. Empty/whitespace-only input parses to `{}` — some providers
 * send `arguments: ""` for tools that take no parameters.
 */
export function parseToolCallArgumentsLenient(raw: string): ToolArgumentsParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      status: 'parsed',
      value: {},
    };
  }

  try {
    return {
      status: 'parsed',
      value: JSON.parse(trimmed),
    };
  } catch {
    // fall through to repair strategies
  }

  if (trimmed.length > MAX_REPAIRABLE_LENGTH) {
    return {
      status: 'unparseable',
    };
  }

  const fromScaffold = tryParseXmlScaffold(trimmed);
  if (fromScaffold !== undefined) {
    return {
      status: 'repaired',
      value: fromScaffold,
      strategy: 'xml-scaffold',
    };
  }

  return {
    status: 'unparseable',
  };
}

/**
 * Convenience wrapper for call sites that previously did a bare `JSON.parse`
 * with a `console.warn` fallback: parses leniently, warns once on repair or
 * failure, and reports whether a usable value was produced.
 */
export function parseArgumentsWithWarnings(
  raw: string,
  toolName: string,
):
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
    } {
  const result = parseToolCallArgumentsLenient(raw);
  switch (result.status) {
    case 'parsed':
      return {
        ok: true,
        value: result.value,
      };
    case 'repaired':
      console.warn(
        `Repaired malformed tool call arguments for ${toolName} (strategy: ${result.strategy})`,
        `\nArguments: ${raw.substring(0, 100)}${raw.length > 100 ? '...' : ''}`,
      );
      return {
        ok: true,
        value: result.value,
      };
    case 'unparseable':
      console.warn(
        `Failed to parse tool call arguments for ${toolName}: not valid JSON and not repairable`,
        `\nArguments: ${raw.substring(0, 100)}${raw.length > 100 ? '...' : ''}`,
      );
      return {
        ok: false,
      };
    default:
      result satisfies never;
      return {
        ok: false,
      };
  }
}

//#region XML scaffold

/**
 * Matches both scaffold spellings seen in production:
 * `<parameter name="commands">` (Claude) and `<parameter=commands>` (variants).
 */
const PARAMETER_OPEN_TAG = /<parameter(?:\s+name="([^"]+)"|=([A-Za-z0-9_-]+))>/g;

/** Trailing scaffold framing to strip from a parameter value. */
const TRAILING_SCAFFOLD = /(?:\s|<\/parameter>|<\/invoke>|<\/tool_call>|\}|\))*$/;

/**
 * Recover arguments from a Claude-style XML scaffold leak. The observed shape
 * is an optional single-key JSON prefix (`{"action": `) followed by one or
 * more `<parameter ...>` tags whose bodies are JSON fragments:
 *
 *   `{"action": \n<parameter name="commands">["mkdir -p /tmp/app"]}`
 *
 * Returns the reconstructed arguments object (parameters nested under the
 * prefix key when present), or `undefined` when the input does not match the
 * scaffold shape or a parameter body cannot be recovered.
 */
function tryParseXmlScaffold(input: string): Record<string, unknown> | undefined {
  PARAMETER_OPEN_TAG.lastIndex = 0;
  const firstTag = PARAMETER_OPEN_TAG.exec(input);
  if (!firstTag) {
    return undefined;
  }

  // Prefix must be empty or a single dangling JSON key: `{"action": `
  const prefix = input.slice(0, firstTag.index).trim();
  let wrapperKey: string | undefined;
  if (prefix) {
    const prefixMatch = /^\{\s*"([A-Za-z0-9_-]+)"\s*:$/.exec(prefix);
    if (!prefixMatch) {
      return undefined;
    }
    wrapperKey = prefixMatch[1];
  }

  // Collect every parameter tag with the span of its body.
  const params: {
    name: string;
    start: number;
    end: number;
  }[] = [];
  PARAMETER_OPEN_TAG.lastIndex = firstTag.index;
  for (
    let match = PARAMETER_OPEN_TAG.exec(input);
    match !== null;
    match = PARAMETER_OPEN_TAG.exec(input)
  ) {
    const name = match[1] ?? match[2];
    if (!name) {
      return undefined;
    }
    const previous = params.at(-1);
    if (previous) {
      previous.end = match.index;
    }
    params.push({
      name,
      start: match.index + match[0].length,
      end: input.length,
    });
  }

  const assembled: Record<string, unknown> = {};
  for (const param of params) {
    const body = input.slice(param.start, param.end).replace(TRAILING_SCAFFOLD, '').trim();
    const value = parseScaffoldParameterValue(body);
    if (value === undefined) {
      return undefined;
    }
    assembled[param.name] = value;
  }

  if (Object.keys(assembled).length === 0) {
    return undefined;
  }
  return wrapperKey
    ? {
        [wrapperKey]: assembled,
      }
    : assembled;
}

/**
 * Parse one scaffold parameter body: a JSON fragment when possible, otherwise
 * a bare string for unquoted scalar values. Returns `undefined` only for
 * empty bodies.
 */
function parseScaffoldParameterValue(body: string): unknown {
  if (!body) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    // Bare unquoted scalar (e.g. `<parameter name="timeout_ms">30000` already
    // parses as JSON; this is for plain-text values).
    return body;
  }
}

//#endregion

import { OpenRouterCore } from '@openrouter/sdk/core';
import { HTTPClient } from '@openrouter/sdk/lib/http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';

type CapturedPayload = {
  tools?: unknown;
};

function isCapturedPayload(value: unknown): value is CapturedPayload {
  return typeof value === 'object' && value !== null;
}

function isNamedTool(value: unknown): value is {
  name: string;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('name' in value)) {
    return false;
  }
  return (
    typeof (
      value as {
        name: unknown;
      }
    ).name === 'string'
  );
}

function extractToolNames(payload: CapturedPayload): string[] {
  const list = payload.tools;
  if (!Array.isArray(list)) {
    return [];
  }
  const names: string[] = [];
  for (const t of list) {
    if (isNamedTool(t)) {
      names.push(t.name);
    }
  }
  return names;
}

const STOP_ERROR = '__captured__';

function makeCapturingClient(captured: { names: string[] | null; raw: unknown }): HTTPClient {
  const httpClient = new HTTPClient();
  httpClient.request = async (request: Request): Promise<Response> => {
    const body: unknown = await request.clone().json();
    captured.raw = body;
    if (isCapturedPayload(body)) {
      captured.names = extractToolNames(body);
    }
    throw new Error(STOP_ERROR);
  };
  return httpClient;
}

async function captureOutboundTools(options: {
  tools: ReadonlyArray<ReturnType<typeof tool>>;
  activeTools?: readonly string[];
}): Promise<string[]> {
  const { names } = await captureOutboundRequest({
    model: 'openai/gpt-4o-mini',
    input: 'hi',
    tools: options.tools,
    ...(options.activeTools !== undefined && {
      activeTools: options.activeTools,
    }),
  });

  if (names === null) {
    throw new Error('request body was not captured');
  }
  return names;
}

/**
 * Run `callModel` with an arbitrary request object (deliberately typed as
 * `unknown` so tests can pass shapes that don't type-check, such as a whole
 * `@openrouter/agent/tool-set` snapshot spread in) and capture the raw JSON
 * body sent to the HTTP client, short-circuiting the actual network call.
 */
async function captureOutboundRequest(request: unknown): Promise<{
  names: string[] | null;
  raw: unknown;
}> {
  const captured: {
    names: string[] | null;
    raw: unknown;
  } = {
    names: null,
    raw: null,
  };
  const httpClient = makeCapturingClient(captured);
  const client = new OpenRouterCore({
    apiKey: 'test-key',
    httpClient,
  });

  // Deliberately bypasses CallModelInput's type checking to exercise runtime
  // stripping of stray keys (a plain `unknown` cast is enough here; the repo's
  // biome config doesn't flag this `as` chain as `noExplicitAny`).
  const result = callModel(client, request as unknown as Parameters<typeof callModel>[1]);

  try {
    await result.getText();
  } catch (err) {
    if (captured.raw === null) {
      throw err;
    }
    if (!(err instanceof Error) || err.message !== STOP_ERROR) {
      // Some other error wrapped our stop error; capture already succeeded.
    }
  }

  if (captured.raw === null) {
    throw new Error('request body was not captured');
  }
  return captured;
}

describe('callModel activeTools filter', () => {
  const toolA = tool({
    name: 'a',
    inputSchema: z.object({}),
    execute: async () => ({
      ok: true,
    }),
  });
  const toolB = tool({
    name: 'b',
    inputSchema: z.object({}),
    execute: async () => ({
      ok: true,
    }),
  });

  it('sends only active tools when activeTools is provided', async () => {
    const names = await captureOutboundTools({
      tools: [
        toolA,
        toolB,
      ],
      activeTools: [
        'a',
      ],
    });
    expect(names).toEqual([
      'a',
    ]);
  });

  it('silently ignores unknown activeTools names', async () => {
    const names = await captureOutboundTools({
      tools: [
        toolA,
        toolB,
      ],
      activeTools: [
        'a',
        'missing',
      ],
    });
    expect(names).toEqual([
      'a',
    ]);
  });

  it('sends all tools when activeTools is omitted', async () => {
    const names = await captureOutboundTools({
      tools: [
        toolA,
        toolB,
      ],
    });
    expect(names).toEqual([
      'a',
      'b',
    ]);
  });

  it('omits the tools key entirely (not an empty array) when activeTools filters out every tool', async () => {
    const captured: {
      names: string[] | null;
      raw: unknown;
    } = {
      names: null,
      raw: null,
    };
    const httpClient = makeCapturingClient(captured);
    const client = new OpenRouterCore({
      apiKey: 'test-key',
      httpClient,
    });

    const result = callModel(client, {
      model: 'openai/gpt-4o-mini',
      input: 'hi',
      tools: [
        toolA,
        toolB,
      ],
      activeTools: [
        'missing',
      ],
    });

    try {
      await result.getText();
    } catch (err) {
      if (captured.raw === null) {
        throw err;
      }
    }

    if (captured.raw === null) {
      throw new Error('request body was not captured');
    }
    expect(isCapturedPayload(captured.raw)).toBe(true);
    // The bug this guards against: sending `tools: []` instead of omitting the
    // key. Several providers reject an explicit empty tools array outright, so
    // the outbound request must not have a `tools` property at all.
    expect(captured.raw).not.toHaveProperty('tools');
  });
});

describe('callModel strips @openrouter/agent/tool-set snapshot metadata', () => {
  const toolA = tool({
    name: 'a',
    inputSchema: z.object({}),
    execute: async () => ({
      ok: true,
    }),
  });

  it('never sends enabled/disabled/statusByTool/callModel keys when a whole tool-set snapshot is spread in', async () => {
    // Mirrors the documented-but-dangerous pattern of spreading the full
    // return value of `ToolSet.inferTools()` / `.resolve()` /
    // `.resolveSituation()` straight into callModel, instead of picking out
    // just `{ tools, activeTools }` (or `.callModel`).
    const snapshotLikeRequest = {
      model: 'openai/gpt-4o-mini',
      input: 'hi',
      tools: [
        toolA,
      ],
      activeTools: [
        'a',
      ],
      enabled: [
        'a',
      ],
      disabled: [] as string[],
      statusByTool: {
        a: 'enabled',
      },
      // A whole `ResolvedToolSnapshot` also carries a nested, spread-safe
      // `callModel` field; a bare top-level `callModel` key must never reach
      // the outbound request body either.
      callModel: {
        tools: [
          toolA,
        ],
        activeTools: [
          'a',
        ],
      },
    };

    const { raw } = await captureOutboundRequest(snapshotLikeRequest);

    expect(raw).not.toHaveProperty('enabled');
    expect(raw).not.toHaveProperty('disabled');
    expect(raw).not.toHaveProperty('statusByTool');
    expect(raw).not.toHaveProperty('callModel');
    // The legitimate fields must still make it through unaffected.
    expect(extractToolNames(raw as CapturedPayload)).toEqual([
      'a',
    ]);
  });

  it('still sends the documented { tools, activeTools } spread-safe pattern unaffected', async () => {
    // Guards against over-eager stripping: `tools`/`activeTools` themselves
    // (the two fields the docs say to spread) must keep working.
    const names = await captureOutboundTools({
      tools: [
        toolA,
      ],
      activeTools: [
        'a',
      ],
    });
    expect(names).toEqual([
      'a',
    ]);
  });
});

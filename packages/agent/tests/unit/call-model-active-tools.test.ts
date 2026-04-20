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
    tools: options.tools,
    ...(options.activeTools !== undefined && {
      activeTools: options.activeTools,
    }),
  });

  try {
    await result.getText();
  } catch (err) {
    if (captured.names === null) {
      throw err;
    }
    if (!(err instanceof Error) || err.message !== STOP_ERROR) {
      // Some other error wrapped our stop error; capture already succeeded.
    }
  }

  if (captured.names === null) {
    throw new Error(`request body was not captured; raw=${JSON.stringify(captured.raw)}`);
  }
  return captured.names;
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
});

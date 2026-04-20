import type * as models from '@openrouter/sdk/models';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';
import { serverTool, tool } from '../../src/lib/tool.js';
import { convertToolsToAPIFormat } from '../../src/lib/tool-executor.js';
import type { ClientTool, ServerTool, Tool, ToolResultItem } from '../../src/lib/tool-types.js';
import { isClientTool, isServerTool } from '../../src/lib/tool-types.js';

describe('serverTool()', () => {
  it('creates a branded ServerTool carrying the SDK config through', () => {
    const t = serverTool({
      type: 'web_search_2025_08_26',
      engine: 'exa',
      maxResults: 10,
    });
    expect(t._brand).toBe('server-tool');
    expect(t.config.type).toBe('web_search_2025_08_26');
    expect(isServerTool(t)).toBe(true);
    expect(isClientTool(t)).toBe(false);
  });

  it('narrows config shape based on the chosen type literal', () => {
    const dt = serverTool({
      type: 'openrouter:datetime',
      parameters: {
        timezone: 'America/New_York',
      },
    });
    // TS-level: dt.config is DatetimeServerTool — parameters.timezone typed as string
    expect(dt.config.parameters?.timezone).toBe('America/New_York');

    const img = serverTool({
      type: 'image_generation',
      size: '1024x1024',
      quality: 'high',
    });
    expect(img.config.size).toBe('1024x1024');
  });

  it('rejects unknown server tool types at the type level', () => {
    // Compile-time: passing an unknown `type` literal must error.
    // @ts-expect-error unknown server tool type
    serverTool({
      type: 'totally-not-a-real-tool',
    });
  });

  it('rejects wrong fields for a known type', () => {
    // @ts-expect-error wrongField does not exist on web_search_2025_08_26 config
    serverTool({
      type: 'web_search_2025_08_26',
      wrongField: 'x',
    });
  });
});

describe('convertToolsToAPIFormat', () => {
  it('passes server tool configs through verbatim', () => {
    const tools = [
      serverTool({
        type: 'openrouter:datetime',
      }),
      serverTool({
        type: 'web_search_2025_08_26',
        engine: 'native',
      }),
    ];
    const api = convertToolsToAPIFormat(tools);
    expect(api).toHaveLength(2);
    expect(api[0]).toEqual({
      type: 'openrouter:datetime',
    });
    expect(api[1]).toEqual({
      type: 'web_search_2025_08_26',
      engine: 'native',
    });
  });

  it('shapes client tools into the function-call API format', () => {
    const clientTool = tool({
      name: 'echo',
      inputSchema: z.object({
        msg: z.string(),
      }),
      execute: ({ msg }) => msg,
    });
    const api = convertToolsToAPIFormat([
      clientTool,
    ]);
    expect(api).toHaveLength(1);
    const [fn] = api;
    expect(fn).toMatchObject({
      type: 'function',
      name: 'echo',
      description: null,
    });
  });

  it('mixes client + server tools in one array', () => {
    const clientTool = tool({
      name: 'echo',
      inputSchema: z.object({
        msg: z.string(),
      }),
      execute: ({ msg }) => msg,
    });
    const tools = [
      clientTool,
      serverTool({
        type: 'image_generation',
        size: '1024x1024',
      }),
    ];
    const api = convertToolsToAPIFormat(tools);
    expect(api).toHaveLength(2);
    expect(api[0]).toMatchObject({
      type: 'function',
      name: 'echo',
    });
    expect(api[1]).toMatchObject({
      type: 'image_generation',
      size: '1024x1024',
    });
  });
});

describe('type-level narrowing of guards', () => {
  it('isServerTool narrows to ServerTool', () => {
    const mix: Tool[] = [
      tool({
        name: 'x',
        inputSchema: z.object({}),
        execute: () => 1,
      }),
      serverTool({
        type: 'openrouter:datetime',
      }),
    ];
    for (const t of mix) {
      if (isServerTool(t)) {
        expectTypeOf(t).toExtend<ServerTool>();
      } else {
        expectTypeOf(t).toExtend<ClientTool>();
      }
    }
  });
});

describe('ToolResultItem union', () => {
  it('accepts client function outputs and server tool output shapes', () => {
    const clientOutput: models.FunctionCallOutputItem = {
      type: 'function_call_output',
      callId: 'call_1',
      output: 'result',
    };
    const webSearch: models.OutputWebSearchCallItem = {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'hello',
      },
    };
    const generic: models.OutputServerToolItem = {
      type: 'openrouter:datetime',
      status: 'completed',
      additionalProperties: {
        datetime: '2026-04-20T00:00:00Z',
        timezone: 'UTC',
      },
    };

    // Compile-time: all three must be assignable to ToolResultItem
    const items: ToolResultItem[] = [
      clientOutput,
      webSearch,
      generic,
    ];
    expect(items).toHaveLength(3);
  });
});

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { buildResourceTools } from '../../src/resource-tools.js';

// Minimal page shapes returned by the fake client's list endpoints.
interface ResourcePage {
  resources: {
    uri: string;
    name: string;
  }[];
  nextCursor?: string;
}
interface TemplatePage {
  resourceTemplates: {
    uriTemplate: string;
    name: string;
  }[];
  nextCursor?: string;
}

// Build a fake MCP Client that serves the given pages of resources and
// templates one cursor at a time, recording the cursors it was asked for.
function fakeClient(args: {
  resourcePages: ResourcePage[];
  templatePages?: TemplatePage[];
  templateError?: boolean;
}): {
  client: Client;
  resourceCursors: (string | undefined)[];
  templateCursors: (string | undefined)[];
} {
  const resourceCursors: (string | undefined)[] = [];
  const templateCursors: (string | undefined)[] = [];
  let resourceIdx = 0;
  let templateIdx = 0;
  const client = {
    listResources: (params?: { cursor?: string }) => {
      resourceCursors.push(params?.cursor);
      const page = args.resourcePages[resourceIdx] ?? {
        resources: [],
      };
      resourceIdx += 1;
      return Promise.resolve(page);
    },
    listResourceTemplates: (params?: { cursor?: string }) => {
      templateCursors.push(params?.cursor);
      if (args.templateError === true) {
        return Promise.reject(new Error('templates not supported'));
      }
      const page = args.templatePages?.[templateIdx] ?? {
        resourceTemplates: [],
      };
      templateIdx += 1;
      return Promise.resolve(page);
    },
    // Minimal stand-in: list_resources only invokes the two list methods above.
  } as never;
  return {
    client,
    resourceCursors,
    templateCursors,
  };
}

// A tool carrying a callable `function.execute`, narrowed from the Tool union.
function hasExecutableFunction(tool: unknown): tool is {
  function: {
    name: string;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  };
} {
  if (typeof tool !== 'object' || tool === null || !('function' in tool)) {
    return false;
  }
  const fn = tool.function;
  return (
    typeof fn === 'object' &&
    fn !== null &&
    'name' in fn &&
    typeof fn.name === 'string' &&
    'execute' in fn &&
    typeof fn.execute === 'function'
  );
}

// Find the synthetic `list_resources` tool and invoke its execute closure.
function runListResources(client: Client): Promise<unknown> {
  const tools = buildResourceTools({
    client,
  });
  const listTool = tools.find(
    (t) => hasExecutableFunction(t) && t.function.name === 'list_resources',
  );
  if (listTool === undefined || !hasExecutableFunction(listTool)) {
    throw new Error('list_resources tool with execute not found');
  }
  // Context is optional; list_resources reads no input and no context.
  return listTool.function.execute({});
}

function isResourceListOutput(value: unknown): value is {
  resources: {
    uri: string;
    name: string;
  }[];
  resourceTemplates: {
    uriTemplate: string;
    name: string;
  }[];
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'resources' in value &&
    Array.isArray(value.resources) &&
    'resourceTemplates' in value &&
    Array.isArray(value.resourceTemplates)
  );
}

describe('buildResourceTools list_resources pagination', () => {
  it('follows nextCursor across multiple pages of resources', async () => {
    const { client, resourceCursors } = fakeClient({
      resourcePages: [
        {
          resources: [
            {
              uri: 'res://a',
              name: 'a',
            },
          ],
          nextCursor: 'page-2',
        },
        {
          resources: [
            {
              uri: 'res://b',
              name: 'b',
            },
          ],
          nextCursor: 'page-3',
        },
        {
          resources: [
            {
              uri: 'res://c',
              name: 'c',
            },
          ],
          // no nextCursor -> terminate
        },
      ],
    });

    const result = await runListResources(client);
    expect(isResourceListOutput(result)).toBe(true);
    if (!isResourceListOutput(result)) {
      return;
    }
    expect(result.resources.map((r) => r.uri)).toEqual([
      'res://a',
      'res://b',
      'res://c',
    ]);
    // First call has no cursor, subsequent calls follow nextCursor.
    expect(resourceCursors).toEqual([
      undefined,
      'page-2',
      'page-3',
    ]);
  });

  it('paginates resource templates and degrades to empty on error', async () => {
    const { client } = fakeClient({
      resourcePages: [
        {
          resources: [],
        },
      ],
      templateError: true,
    });

    const result = await runListResources(client);
    expect(isResourceListOutput(result)).toBe(true);
    if (!isResourceListOutput(result)) {
      return;
    }
    expect(result.resourceTemplates).toEqual([]);
  });

  it('accumulates all template pages when supported', async () => {
    const { client, templateCursors } = fakeClient({
      resourcePages: [
        {
          resources: [],
        },
      ],
      templatePages: [
        {
          resourceTemplates: [
            {
              uriTemplate: 'res://{id}',
              name: 't1',
            },
          ],
          nextCursor: 'tpl-2',
        },
        {
          resourceTemplates: [
            {
              uriTemplate: 'res://{slug}',
              name: 't2',
            },
          ],
        },
      ],
    });

    const result = await runListResources(client);
    expect(isResourceListOutput(result)).toBe(true);
    if (!isResourceListOutput(result)) {
      return;
    }
    expect(result.resourceTemplates.map((t) => t.name)).toEqual([
      't1',
      't2',
    ]);
    expect(templateCursors).toEqual([
      undefined,
      'tpl-2',
    ]);
  });

  it('terminates when the server repeats the same cursor', async () => {
    const { client, resourceCursors } = fakeClient({
      resourcePages: [
        {
          resources: [
            {
              uri: 'res://loop',
              name: 'loop',
            },
          ],
          nextCursor: 'stuck',
        },
        {
          resources: [
            {
              uri: 'res://loop2',
              name: 'loop2',
            },
          ],
          // Same cursor echoed back -> must stop, not spin forever.
          nextCursor: 'stuck',
        },
      ],
    });

    const result = await runListResources(client);
    expect(isResourceListOutput(result)).toBe(true);
    if (!isResourceListOutput(result)) {
      return;
    }
    // Two distinct cursor values requested: undefined then 'stuck'; the
    // repeated 'stuck' stops the loop.
    expect(resourceCursors).toEqual([
      undefined,
      'stuck',
    ]);
  });
});

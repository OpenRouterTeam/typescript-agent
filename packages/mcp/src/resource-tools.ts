import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { markMcp, tool } from '@openrouter/agent/tool';
import type { McpBranded } from '@openrouter/agent/tool-types';
import * as z from 'zod';

export interface ResourceToolsOptions {
  client: Client;
  namePrefix?: string;
  signal?: AbortSignal;
}

// Hard cap on pagination pages. A well-behaved server terminates the cursor
// chain by omitting `nextCursor`; this bounds a misbehaving one that never does.
const MAX_LIST_PAGES = 1000;

type RequestOptions =
  | {
      signal: AbortSignal;
    }
  | undefined;

// Minimal page shapes: each list endpoint returns its items plus an optional
// `nextCursor`. We accept extra fields the SDK includes and read only these.
interface ResourcePage {
  resources: ListedResource[];
  nextCursor?: string | undefined;
}
interface ResourceTemplatePage {
  resourceTemplates: ListedResourceTemplate[];
  nextCursor?: string | undefined;
}
type ListedResource = Awaited<ReturnType<Client['listResources']>>['resources'][number];
type ListedResourceTemplate = Awaited<
  ReturnType<Client['listResourceTemplates']>
>['resourceTemplates'][number];

/**
 * Normalize a paginated `nextCursor` field: treat anything that is not a
 * non-empty string as "no more pages" so a malformed cursor terminates the loop.
 */
function nextCursorOrUndefined(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Walk a paginated MCP list endpoint, following `nextCursor` (passed back as
 * `{ cursor }`) until exhausted, and return the flattened items. Stops when the
 * server omits `nextCursor`, repeats the same cursor, or the page cap is hit.
 */
async function collectPages<Item>(
  fetchPage: (
    params:
      | {
          cursor: string;
        }
      | undefined,
    options: RequestOptions,
  ) => Promise<{
    items: Item[];
    nextCursor: string | undefined;
  }>,
  requestOptions: RequestOptions,
): Promise<Item[]> {
  const collected: Item[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params =
      cursor !== undefined
        ? {
            cursor,
          }
        : undefined;
    const { items, nextCursor } = await fetchPage(params, requestOptions);
    collected.push(...items);
    const next = nextCursorOrUndefined(nextCursor);
    if (next === undefined || next === cursor) {
      break;
    }
    cursor = next;
  }
  return collected;
}

/**
 * Build synthetic tools that let the model browse and read MCP resources
 * through the normal tool loop:
 * - `list_resources`: concrete resources plus resource templates.
 * - `read_resource`: fetch a resource's contents by URI.
 *
 * Only call this when the server advertises the `resources` capability.
 */
export function buildResourceTools(options: ResourceToolsOptions): McpBranded[] {
  const prefix = options.namePrefix ?? '';
  const requestOptions =
    options.signal !== undefined
      ? {
          signal: options.signal,
        }
      : undefined;

  const listResources = tool({
    name: `${prefix}list_resources`,
    description: 'List the resources and resource templates exposed by the MCP server.',
    inputSchema: z.object({}),
    execute: async () => {
      const [resources, resourceTemplates] = await Promise.all([
        collectPages<ListedResource>(async (params, opts) => {
          const page: ResourcePage = await options.client.listResources(params, opts);
          return {
            items: page.resources,
            nextCursor: page.nextCursor,
          };
        }, requestOptions),
        // Templates are optional: a server may not support them. The whole
        // paginated fetch degrades gracefully to an empty list on any error.
        collectPages<ListedResourceTemplate>(async (params, opts) => {
          const page: ResourceTemplatePage = await options.client.listResourceTemplates(
            params,
            opts,
          );
          return {
            items: page.resourceTemplates,
            nextCursor: page.nextCursor,
          };
        }, requestOptions).catch(() => []),
      ]);
      return {
        resources: resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description !== undefined && {
            description: r.description,
          }),
          ...(r.mimeType !== undefined && {
            mimeType: r.mimeType,
          }),
        })),
        resourceTemplates: resourceTemplates.map((t) => ({
          uriTemplate: t.uriTemplate,
          name: t.name,
          ...(t.description !== undefined && {
            description: t.description,
          }),
        })),
      };
    },
  });

  const readResource = tool({
    name: `${prefix}read_resource`,
    description: 'Read the contents of an MCP resource by its URI.',
    inputSchema: z.object({
      uri: z.string().describe('Resource URI to read'),
    }),
    execute: async (args: { uri: string }) => {
      const result = await options.client.readResource(
        {
          uri: args.uri,
        },
        requestOptions,
      );
      return {
        contents: result.contents.map((c) => {
          if ('text' in c) {
            return {
              uri: c.uri,
              text: c.text,
              ...(c.mimeType !== undefined && {
                mimeType: c.mimeType,
              }),
            };
          }
          return {
            uri: c.uri,
            blob: c.blob,
            ...(c.mimeType !== undefined && {
              mimeType: c.mimeType,
            }),
          };
        }),
      };
    },
  });

  return [
    markMcp(listResources),
    markMcp(readResource),
  ];
}

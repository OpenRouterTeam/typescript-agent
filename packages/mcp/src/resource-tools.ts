import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@openrouter/agent';
import { tool } from '@openrouter/agent';
import * as z from 'zod';

export interface ResourceToolsOptions {
  client: Client;
  namePrefix?: string;
  signal?: AbortSignal;
}

/**
 * Build synthetic tools that let the model browse and read MCP resources
 * through the normal tool loop:
 * - `list_resources`: concrete resources plus resource templates.
 * - `read_resource`: fetch a resource's contents by URI.
 *
 * Only call this when the server advertises the `resources` capability.
 */
export function buildResourceTools(options: ResourceToolsOptions): Tool[] {
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
      const [resources, templates] = await Promise.all([
        options.client.listResources(undefined, requestOptions),
        options.client.listResourceTemplates(undefined, requestOptions).catch(() => ({
          resourceTemplates: [],
        })),
      ]);
      return {
        resources: resources.resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          ...(r.description !== undefined && {
            description: r.description,
          }),
          ...(r.mimeType !== undefined && {
            mimeType: r.mimeType,
          }),
        })),
        resourceTemplates: templates.resourceTemplates.map((t) => ({
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
    listResources,
    readResource,
  ];
}

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import { markMcp, tool } from '@openrouter/agent/tool';
import type { McpBranded } from '@openrouter/agent/tool-types';
import * as z from 'zod';
import type { RawCallToolResult } from './result-mapper.js';
import { mapCallToolResult } from './result-mapper.js';
import { isJsonSchemaObject } from './schema/json-schema-guards.js';
import type { UnconvertibleSchemaMode } from './schema/json-schema-to-zod.js';
import { convertMcpInputSchema } from './schema/json-schema-to-zod.js';

/** A discovered MCP tool definition (the fields we consume). */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface WrapToolOptions {
  client: Client;
  namePrefix?: string;
  schemaMode?: UnconvertibleSchemaMode;
  emitProgress?: boolean;
  signal?: AbortSignal;
}

/** Event yielded by a progress-emitting generator tool. */
const progressEventSchema = z.object({
  type: z.literal('progress'),
  progress: z.number(),
  total: z.optional(z.number()),
  message: z.optional(z.string()),
});

function callToolResultIsRaw(value: unknown): value is RawCallToolResult {
  return isJsonSchemaObject(value);
}

interface InvokeToolArgs {
  options: WrapToolOptions;
  mcpName: string;
  args: Record<string, unknown>;
  onprogress?: (progress: Progress) => void;
}

async function invokeTool(invokeArgs: InvokeToolArgs): Promise<unknown> {
  const { options, mcpName, args, onprogress } = invokeArgs;
  const result = await options.client.callTool(
    {
      name: mcpName,
      arguments: args,
    },
    undefined,
    {
      ...(options.signal !== undefined && {
        signal: options.signal,
      }),
      ...(onprogress !== undefined && {
        onprogress,
      }),
    },
  );
  if (!callToolResultIsRaw(result)) {
    return '';
  }
  return mapCallToolResult(mcpName, result);
}

/**
 * Wrap one discovered MCP tool as an `@openrouter/agent` tool. Emits a
 * generator tool (streaming progress events) when `emitProgress` is on,
 * otherwise a regular tool. The input schema (and output schema, when declared)
 * are converted to Zod so the model sees faithful parameters. The abort signal,
 * if supplied, is threaded into the underlying `callTool`.
 */
export function wrapMcpTool(def: McpToolDef, options: WrapToolOptions): McpBranded {
  const name = `${options.namePrefix ?? ''}${def.name}`;
  const inputSchema = convertMcpInputSchema(def.inputSchema, options.schemaMode);
  const outputSchema =
    def.outputSchema !== undefined
      ? convertMcpInputSchema(def.outputSchema, options.schemaMode)
      : undefined;

  if (options.emitProgress === true) {
    return markMcp(
      tool({
        name,
        ...(def.description !== undefined && {
          description: def.description,
        }),
        inputSchema,
        eventSchema: progressEventSchema,
        outputSchema: outputSchema ?? z.unknown(),
        execute: async function* (args: Record<string, unknown>) {
          const queue: Array<z.infer<typeof progressEventSchema>> = [];
          let notify: (() => void) | undefined;
          const onprogress = (p: Progress): void => {
            queue.push({
              type: 'progress',
              progress: p.progress,
              ...(p.total !== undefined && {
                total: p.total,
              }),
              ...(typeof p.message === 'string' && {
                message: p.message,
              }),
            });
            notify?.();
          };

          const resultPromise = invokeTool({
            options,
            mcpName: def.name,
            args,
            onprogress,
          });
          let done = false;
          const finalize = resultPromise.finally(() => {
            done = true;
            notify?.();
          });

          while (!done || queue.length > 0) {
            while (queue.length > 0) {
              const event = queue.shift();
              if (event !== undefined) {
                yield event;
              }
            }
            if (done) {
              break;
            }
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = undefined;
          }

          return await finalize;
        },
      }),
    );
  }

  return markMcp(
    tool({
      name,
      ...(def.description !== undefined && {
        description: def.description,
      }),
      inputSchema,
      ...(outputSchema !== undefined && {
        outputSchema,
      }),
      execute: (args: Record<string, unknown>) =>
        invokeTool({
          options,
          mcpName: def.name,
          args,
        }),
    }),
  );
}

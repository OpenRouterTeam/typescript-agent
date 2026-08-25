import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import { convertToolsToAPIFormat } from '../../src/lib/tool-executor.js';

describe('manual tool wireInputSchema', () => {
  it('serializes anyOf and oneOf while sanitizing tilde-prefixed keys', () => {
    const wireInputSchema = {
      type: 'object',
      '~rootMetadata': 'remove me',
      properties: {
        choice: {
          '~propertyMetadata': 'remove me',
          anyOf: [
            {
              type: 'string',
            },
            {
              type: 'number',
            },
          ],
          oneOf: [
            {
              const: 'first',
            },
            {
              const: 'second',
            },
          ],
        },
      },
      required: [
        'choice',
      ],
    };

    const manualTool = tool({
      name: 'choose_value',
      description: 'Choose a value',
      inputSchema: z.object({
        choice: z.string(),
      }),
      wireInputSchema,
      execute: false,
      strict: true,
    });
    const api = convertToolsToAPIFormat([
      manualTool,
    ]);
    const emitted = api[0];
    const parameters = 'parameters' in emitted ? emitted.parameters : undefined;

    expect(emitted).toMatchObject({
      type: 'function',
      name: 'choose_value',
      description: 'Choose a value',
      strict: true,
    });
    expect(parameters).toEqual({
      type: 'object',
      properties: {
        choice: {
          anyOf: [
            {
              type: 'string',
            },
            {
              type: 'number',
            },
          ],
          oneOf: [
            {
              const: 'first',
            },
            {
              const: 'second',
            },
          ],
        },
      },
      required: [
        'choice',
      ],
    });
  });

  it('does not mutate the caller-owned schema and emits a copy', () => {
    const wireInputSchema = {
      type: 'object',
      '~rootMetadata': true,
      properties: {
        value: {
          type: 'string',
          '~nestedMetadata': true,
        },
      },
    };
    const originalSchema = structuredClone(wireInputSchema);
    const manualTool = tool({
      name: 'copy_schema',
      inputSchema: z.object({
        value: z.string(),
      }),
      wireInputSchema,
      execute: false,
    });

    const api = convertToolsToAPIFormat([
      manualTool,
    ]);
    const emitted = api[0];
    const parameters = 'parameters' in emitted ? emitted.parameters : undefined;

    expect(wireInputSchema).toEqual(originalSchema);
    expect(parameters).not.toBe(wireInputSchema);
  });

  it('falls back to the Zod-derived schema without wireInputSchema', () => {
    const manualTool = tool({
      name: 'fallback_schema',
      inputSchema: z.object({
        value: z.string(),
      }),
      execute: false,
    });

    const api = convertToolsToAPIFormat([
      manualTool,
    ]);
    const emitted = api[0];
    const parameters = 'parameters' in emitted ? emitted.parameters : undefined;

    expect(parameters).toMatchObject({
      type: 'object',
      properties: {
        value: {
          type: 'string',
        },
      },
    });
  });

  it('uses the Zod-derived schema for executable shared-context tools', () => {
    const executableTool = tool<{
      sessionId: string;
    }>()({
      name: 'shared_context_tool',
      inputSchema: z.object({
        count: z.number(),
      }),
      execute: (params, context) => {
        context?.shared.sessionId;
        return params.count;
      },
    });

    const api = convertToolsToAPIFormat([
      executableTool,
    ]);
    const emitted = api[0];
    const parameters = 'parameters' in emitted ? emitted.parameters : undefined;

    expect(parameters).toMatchObject({
      type: 'object',
      properties: {
        count: {
          type: 'number',
        },
      },
    });
  });
});

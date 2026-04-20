import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import { ToolType } from '../../src/lib/tool-types.js';

describe('tool', () => {
  describe('tool - regular tools', () => {
    it('should create a tool with the correct structure', () => {
      const testTool = tool({
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: z.object({
          input: z.string(),
        }),
        execute: async (params) => {
          return {
            result: params.input,
          };
        },
      });

      expect(testTool.type).toBe(ToolType.Function);
      expect(testTool.function.name).toBe('test_tool');
      expect(testTool.function.description).toBe('A test tool');
      expect(testTool.function.inputSchema).toBeDefined();
    });

    it('should infer execute params from inputSchema', async () => {
      const weatherTool = tool({
        name: 'weather',
        inputSchema: z.object({
          location: z.string(),
          units: z
            .enum([
              'celsius',
              'fahrenheit',
            ])
            .optional(),
        }),
        execute: async (params) => {
          // params should be typed as { location: string; units?: 'celsius' | 'fahrenheit' }
          const location: string = params.location;
          const units: 'celsius' | 'fahrenheit' | undefined = params.units;
          return {
            location,
            units,
          };
        },
      });

      const result = await weatherTool.function.execute({
        location: 'NYC',
        units: 'fahrenheit',
      });
      expect(result.location).toBe('NYC');
      expect(result.units).toBe('fahrenheit');
    });

    it('should enforce output schema return type', async () => {
      const tempTool = tool({
        name: 'get_temperature',
        inputSchema: z.object({
          location: z.string(),
        }),
        outputSchema: z.object({
          temperature: z.number(),
          description: z.string(),
        }),
        execute: async (_params) => {
          // Return type should be enforced as { temperature: number; description: string }
          return {
            temperature: 72,
            description: 'Sunny',
          };
        },
      });

      const result = await tempTool.function.execute({
        location: 'NYC',
      });
      expect(result.temperature).toBe(72);
      expect(result.description).toBe('Sunny');
    });

    it('should support synchronous execute functions', () => {
      const syncTool = tool({
        name: 'sync_tool',
        inputSchema: z.object({
          a: z.number(),
          b: z.number(),
        }),
        execute: (params) => {
          return {
            sum: params.a + params.b,
          };
        },
      });

      const result = syncTool.function.execute({
        a: 5,
        b: 3,
      });
      expect(result).toEqual({
        sum: 8,
      });
    });

    it('should pass context to execute function', async () => {
      let receivedContext: unknown;

      const contextTool = tool({
        name: 'context_tool',
        inputSchema: z.object({}),
        execute: async (_params, context) => {
          receivedContext = context;
          return {};
        },
      });

      const mockContext = {
        numberOfTurns: 3,
        messageHistory: [],
        model: 'test-model',
      };

      await contextTool.function.execute({}, mockContext);
      expect(receivedContext).toEqual(mockContext);
    });
  });

  describe('tool - generator tools (with eventSchema)', () => {
    it('should create a generator tool with the correct structure', () => {
      const streamingTool = tool({
        name: 'streaming_tool',
        description: 'A streaming tool',
        inputSchema: z.object({
          query: z.string(),
        }),
        eventSchema: z.object({
          progress: z.number(),
        }),
        outputSchema: z.object({
          result: z.string(),
        }),
        execute: async function* (_params) {
          yield {
            progress: 50,
          };
          yield {
            result: 'done',
          };
        },
      });

      expect(streamingTool.type).toBe(ToolType.Function);
      expect(streamingTool.function.name).toBe('streaming_tool');
      expect(streamingTool.function.eventSchema).toBeDefined();
      expect(streamingTool.function.outputSchema).toBeDefined();
    });

    it('should yield properly typed events and output', async () => {
      const progressTool = tool({
        name: 'progress_tool',
        inputSchema: z.object({
          data: z.string(),
        }),
        eventSchema: z.object({
          status: z.string(),
          progress: z.number(),
        }),
        outputSchema: z.object({
          completed: z.boolean(),
          result: z.string(),
        }),
        execute: async function* (params) {
          yield {
            status: 'started',
            progress: 0,
          };
          yield {
            status: 'processing',
            progress: 50,
          };
          yield {
            completed: true,
            result: `Processed: ${params.data}`,
          };
        },
      });

      const results: unknown[] = [];
      const mockContext = {
        numberOfTurns: 1,
        messageHistory: [],
      };
      for await (const event of progressTool.function.execute(
        {
          data: 'test',
        },
        mockContext,
      )) {
        results.push(event);
      }

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({
        status: 'started',
        progress: 0,
      });
      expect(results[1]).toEqual({
        status: 'processing',
        progress: 50,
      });
      expect(results[2]).toEqual({
        completed: true,
        result: 'Processed: test',
      });
    });
  });

  describe('tool - manual tools (execute: false)', () => {
    it('should create a manual tool without execute function', () => {
      const manualTool = tool({
        name: 'manual_tool',
        description: 'A manual tool',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: false,
      });

      expect(manualTool.type).toBe(ToolType.Function);
      expect(manualTool.function.name).toBe('manual_tool');
      expect(manualTool.function).not.toHaveProperty('execute');
    });
  });

  describe('tool - toModelOutput', () => {
    it('should create a tool with toModelOutput function', () => {
      const imageGenTool = tool({
        name: 'image_gen',
        inputSchema: z.object({
          prompt: z.string(),
        }),
        outputSchema: z.object({
          status: z.string(),
          imageUrl: z.string(),
        }),
        execute: async (params) => {
          return {
            status: 'ok',
            imageUrl: `https://example.com/${params.prompt}.png`,
          };
        },
        toModelOutput: ({ output }) => ({
          type: 'content',
          value: [
            {
              type: 'input_text',
              text: 'Image generated successfully.',
            },
            {
              type: 'input_image',
              detail: 'auto',
              imageUrl: output.imageUrl,
            },
          ],
        }),
      });

      expect(imageGenTool.type).toBe(ToolType.Function);
      expect(imageGenTool.function.name).toBe('image_gen');
      expect(imageGenTool.function.toModelOutput).toBeDefined();
      expect(typeof imageGenTool.function.toModelOutput).toBe('function');
    });

    it('toModelOutput receives both output and input', async () => {
      let receivedOutput: unknown;
      let receivedInput: unknown;

      const testTool = tool({
        name: 'test_tool',
        inputSchema: z.object({
          prompt: z.string(),
          style: z.string().optional(),
        }),
        execute: async (params) => {
          return {
            result: `Processed: ${params.prompt}`,
          };
        },
        toModelOutput: ({ output, input }) => {
          receivedOutput = output;
          receivedInput = input;
          return {
            type: 'content',
            value: [
              {
                type: 'input_text',
                text: 'Done',
              },
            ],
          };
        },
      });

      // Execute the tool first
      const output = await testTool.function.execute({
        prompt: 'hello',
        style: 'modern',
      });

      // Then call toModelOutput manually to test it receives correct params
      const modelOutput = testTool.function.toModelOutput!({
        output,
        input: {
          prompt: 'hello',
          style: 'modern',
        },
      });

      expect(receivedOutput).toEqual({
        result: 'Processed: hello',
      });
      expect(receivedInput).toEqual({
        prompt: 'hello',
        style: 'modern',
      });
      expect(modelOutput).toEqual({
        type: 'content',
        value: [
          {
            type: 'input_text',
            text: 'Done',
          },
        ],
      });
    });

    it('should support async toModelOutput function', async () => {
      const asyncTool = tool({
        name: 'async_tool',
        inputSchema: z.object({
          data: z.string(),
        }),
        execute: async () => {
          return {
            processed: true,
          };
        },
        toModelOutput: async ({ output }) => {
          // Simulate async work (e.g., fetching additional data)
          await Promise.resolve();
          return {
            type: 'content',
            value: [
              {
                type: 'input_text',
                text: `Processed: ${output.processed}`,
              },
            ],
          };
        },
      });

      const output = await asyncTool.function.execute({
        data: 'test',
      });
      const modelOutput = await asyncTool.function.toModelOutput!({
        output,
        input: {
          data: 'test',
        },
      });

      expect(modelOutput).toEqual({
        type: 'content',
        value: [
          {
            type: 'input_text',
            text: 'Processed: true',
          },
        ],
      });
    });

    it('should support toModelOutput on tools without outputSchema', () => {
      const noSchemaTool = tool({
        name: 'no_schema_tool',
        inputSchema: z.object({
          input: z.string(),
        }),
        execute: (params) => {
          return {
            raw: params.input,
          };
        },
        toModelOutput: ({ output }) => ({
          type: 'content',
          value: [
            {
              type: 'input_text',
              text: `Output: ${output.raw}`,
            },
          ],
        }),
      });

      expect(noSchemaTool.function.toModelOutput).toBeDefined();

      const output = noSchemaTool.function.execute({
        input: 'test',
      });
      const modelOutput = noSchemaTool.function.toModelOutput!({
        output,
        input: {
          input: 'test',
        },
      });

      expect(modelOutput).toEqual({
        type: 'content',
        value: [
          {
            type: 'input_text',
            text: 'Output: test',
          },
        ],
      });
    });

    it('should support toModelOutput on generator tools', () => {
      const generatorTool = tool({
        name: 'generator_tool',
        inputSchema: z.object({
          query: z.string(),
        }),
        eventSchema: z.object({
          progress: z.number(),
        }),
        outputSchema: z.object({
          result: z.string(),
        }),
        execute: async function* (_params) {
          yield {
            progress: 50,
          };
          yield {
            result: 'done',
          };
        },
        toModelOutput: ({ output }) => ({
          type: 'content',
          value: [
            {
              type: 'input_text',
              text: `Final result: ${output.result}`,
            },
          ],
        }),
      });

      expect(generatorTool.function.toModelOutput).toBeDefined();

      const modelOutput = generatorTool.function.toModelOutput!({
        output: {
          result: 'completed',
        },
        input: {
          query: 'test',
        },
      });

      expect(modelOutput).toEqual({
        type: 'content',
        value: [
          {
            type: 'input_text',
            text: 'Final result: completed',
          },
        ],
      });
    });
  });
});

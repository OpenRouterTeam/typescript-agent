import { OpenRouterCore } from '@openrouter/sdk/core';
import { HTTPClient } from '@openrouter/sdk/lib/http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { callModel } from '../../src/inner-loop/call-model.js';
import { tool } from '../../src/lib/tool.js';

function wireResponse(output: unknown[]) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    completed_at: 0,
    model: 'test-model',
    status: 'completed',
    output,
    error: null,
    incomplete_details: null,
    temperature: null,
    top_p: null,
    presence_penalty: null,
    frequency_penalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
}

function sse(response: unknown): Response {
  const event = {
    type: 'response.completed',
    response,
    sequence_number: 1,
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
    },
  });
}

describe('tool whose execute returns nothing', () => {
  it('sends a valid function_call_output and finishes the run', async () => {
    const bodies: Array<{
      input?: Array<{
        type?: string;
        output?: unknown;
      }>;
    }> = [];
    const httpClient = new HTTPClient();
    httpClient.request = async (request: Request) => {
      bodies.push(await request.clone().json());
      if (bodies.length === 1) {
        return sse(
          wireResponse([
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'log_event',
              arguments: '{"event":"signup"}',
              status: 'completed',
            },
          ]),
        );
      }
      return sse(
        wireResponse([
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Logged.',
                annotations: [],
              },
            ],
          },
        ]),
      );
    };
    const client = new OpenRouterCore({
      apiKey: 'test-key',
      httpClient,
    });

    const logged: string[] = [];
    const logEvent = tool({
      name: 'log_event',
      inputSchema: z.object({
        event: z.string(),
      }),
      execute: async ({ event }) => {
        logged.push(event);
      },
    });

    const result = callModel(client, {
      model: 'test-model',
      input: 'Log a signup event.',
      tools: [
        logEvent,
      ] as const,
    });

    await expect(result.getText()).resolves.toBe('Logged.');
    expect(logged).toEqual([
      'signup',
    ]);
    expect(bodies).toHaveLength(2);
    const output = bodies[1]?.input?.find((item) => item.type === 'function_call_output');
    expect(typeof output?.output).toBe('string');
  });
});

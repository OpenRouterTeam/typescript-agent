/**
 * Tests for `withToolRetry` — automatic re-run of a tool's execute function
 * when it throws, absorbing transient failures before they reach the model.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { withToolRetry } from '../../src/lib/tool-retry.js';
import type { Tool } from '../../src/lib/tool-types.js';
import { isGeneratorTool, isRegularExecuteTool, ToolType } from '../../src/lib/tool-types.js';

function makeRegularTool(
  execute: (params: { url: string }) => Promise<{
    body: string;
  }>,
) {
  return {
    type: ToolType.Function,
    function: {
      name: 'web_fetch',
      description: 'Fetch a page.',
      inputSchema: z.object({
        url: z.string(),
      }),
      outputSchema: z.object({
        body: z.string(),
      }),
      execute,
    },
  } as const;
}

describe('withToolRetry: regular execute tools', () => {
  it('retries a throwing execute and returns the eventual success', async () => {
    const execute = vi
      .fn<
        (params: { url: string }) => Promise<{
          body: string;
        }>
      >()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({
        body: 'hello',
      });

    const wrapped = withToolRetry(makeRegularTool(execute), {
      limit: 2,
    });

    const result = await (
      wrapped.function.execute as (params: { url: string }) => Promise<{
        body: string;
      }>
    )({
      url: 'https://example.com',
    });

    expect(result).toEqual({
      body: 'hello',
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once the limit is exhausted', async () => {
    const execute = vi
      .fn<
        (params: { url: string }) => Promise<{
          body: string;
        }>
      >()
      .mockRejectedValue(new Error('permanently down'));

    const wrapped = withToolRetry(makeRegularTool(execute), {
      limit: 1,
    });

    await expect(
      (
        wrapped.function.execute as (params: { url: string }) => Promise<{
          body: string;
        }>
      )({
        url: 'https://example.com',
      }),
    ).rejects.toThrow('permanently down');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('respects isRetryable declining a retry', async () => {
    const execute = vi
      .fn<
        (params: { url: string }) => Promise<{
          body: string;
        }>
      >()
      .mockRejectedValue(new Error('404 not found'));
    const isRetryable = vi.fn(() => false);

    const wrapped = withToolRetry(makeRegularTool(execute), {
      limit: 3,
      isRetryable,
    });

    await expect(
      (
        wrapped.function.execute as (params: { url: string }) => Promise<{
          body: string;
        }>
      )({
        url: 'https://example.com',
      }),
    ).rejects.toThrow('404 not found');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(isRetryable).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'web_fetch',
        attempt: 1,
      }),
    );
  });

  it('invokes onRetry with attempt context before each retry', async () => {
    const execute = vi
      .fn<
        (params: { url: string }) => Promise<{
          body: string;
        }>
      >()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce({
        body: 'ok',
      });
    const onRetry = vi.fn();

    const wrapped = withToolRetry(makeRegularTool(execute), {
      onRetry,
    });

    await (
      wrapped.function.execute as (params: { url: string }) => Promise<{
        body: string;
      }>
    )({
      url: 'https://example.com',
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'web_fetch',
        attempt: 1,
        error: expect.any(Error),
      }),
    );
  });

  it('preserves the tool shape and type-guard classification', () => {
    const original = makeRegularTool(async () => ({
      body: 'x',
    }));
    const wrapped = withToolRetry(original);

    expect(isRegularExecuteTool(wrapped as unknown as Tool)).toBe(true);
    expect(isGeneratorTool(wrapped as unknown as Tool)).toBe(false);
    expect(wrapped.function.name).toBe('web_fetch');
    expect(wrapped.function.inputSchema).toBe(original.function.inputSchema);
    expect(wrapped.function.outputSchema).toBe(original.function.outputSchema);
  });

  it('returns tools without an execute function unchanged', () => {
    const manualTool = {
      type: ToolType.Function,
      function: {
        name: 'manual_thing',
        description: 'No execute.',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      },
    } as const;

    const wrapped = withToolRetry(manualTool as unknown as Tool);
    expect(wrapped).toBe(manualTool);
  });
});

describe('withToolRetry: generator tools', () => {
  function makeGeneratorTool(
    execute: (params: { query: string }) => AsyncGenerator<unknown, unknown, unknown>,
  ) {
    return {
      type: ToolType.Function,
      function: {
        name: 'web_search',
        description: 'Search.',
        inputSchema: z.object({
          query: z.string(),
        }),
        outputSchema: z.object({
          results: z.array(z.string()),
        }),
        eventSchema: z.object({
          progress: z.string(),
        }),
        execute,
      },
    } as const;
  }

  it('re-runs a generator that throws mid-iteration and yields the retried run', async () => {
    let calls = 0;
    const wrapped = withToolRetry(
      makeGeneratorTool(async function* (_params) {
        calls++;
        yield {
          progress: `attempt ${calls} started`,
        };
        if (calls === 1) {
          throw new Error('stream cut');
        }
        return {
          results: [
            'found it',
          ],
        };
      }),
      {
        limit: 1,
      },
    );

    const iterator = (
      wrapped.function.execute as (params: {
        query: string;
      }) => AsyncGenerator<unknown, unknown, unknown>
    )({
      query: 'cats',
    });

    const yielded: unknown[] = [];
    let step = await iterator.next();
    while (!step.done) {
      yielded.push(step.value);
      step = await iterator.next();
    }

    expect(calls).toBe(2);
    // Yields from BOTH attempts are forwarded (documented behavior).
    expect(yielded).toEqual([
      {
        progress: 'attempt 1 started',
      },
      {
        progress: 'attempt 2 started',
      },
    ]);
    expect(step.value).toEqual({
      results: [
        'found it',
      ],
    });
  });

  it('keeps the generator classification so the executor drives it correctly', () => {
    const wrapped = withToolRetry(
      makeGeneratorTool(async function* () {
        yield {
          progress: 'hi',
        };
        return {
          results: [],
        };
      }),
    );
    expect(isGeneratorTool(wrapped as unknown as Tool)).toBe(true);
  });

  it('throws once generator retries are exhausted', async () => {
    const wrapped = withToolRetry(
      makeGeneratorTool(async function* () {
        yield {
          progress: 'starting',
        };
        throw new Error('always fails');
      }),
      {
        limit: 1,
      },
    );

    const iterator = (
      wrapped.function.execute as (params: {
        query: string;
      }) => AsyncGenerator<unknown, unknown, unknown>
    )({
      query: 'cats',
    });

    await expect(async () => {
      let step = await iterator.next();
      while (!step.done) {
        step = await iterator.next();
      }
    }).rejects.toThrow('always fails');
  });
});

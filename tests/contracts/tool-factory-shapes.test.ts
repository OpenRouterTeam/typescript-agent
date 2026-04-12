import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { tool } from '../../src/index.js';

const inputSchema = z.object({
  query: z.string(),
});

describe('tool() factory - three tool types produce distinct structures', () => {
  it('regular tool has execute function, no eventSchema', () => {
    const t = tool({
      name: 'regular',
      inputSchema,
      execute: async () => 'done',
    });
    expect(t.function).toHaveProperty('execute');
    expect(t.function).not.toHaveProperty('eventSchema');
  });

  it('generator tool has execute function AND eventSchema AND outputSchema', () => {
    const t = tool({
      name: 'generator',
      inputSchema,
      eventSchema: z.object({
        status: z.string(),
      }),
      outputSchema: z.object({
        result: z.string(),
      }),
      execute: async function* () {
        yield {
          status: 'working',
        };
        return {
          result: 'done',
        };
      },
    });
    expect(t.function).toHaveProperty('execute');
    expect(t.function).toHaveProperty('eventSchema');
    expect(t.function).toHaveProperty('outputSchema');
  });

  it('manual tool has NO execute, no eventSchema, no outputSchema', () => {
    const t = tool({
      name: 'manual',
      inputSchema,
      execute: false,
    });
    expect(t.function).not.toHaveProperty('execute');
    expect(t.function).not.toHaveProperty('eventSchema');
    expect(t.function).not.toHaveProperty('outputSchema');
  });

  it('same input schema -> three different tool types depending on config', () => {
    const regular = tool({
      name: 'r',
      inputSchema,
      execute: async () => 'ok',
    });
    const generator = tool({
      name: 'g',
      inputSchema,
      eventSchema: z.object({
        s: z.string(),
      }),
      outputSchema: z.object({
        r: z.string(),
      }),
      execute: async function* () {
        return {
          r: 'ok',
        };
      },
    });
    const manual = tool({
      name: 'm',
      inputSchema,
      execute: false,
    });

    expect('execute' in regular.function).toBe(true);
    expect('eventSchema' in regular.function).toBe(false);

    expect('execute' in generator.function).toBe(true);
    expect('eventSchema' in generator.function).toBe(true);

    expect('execute' in manual.function).toBe(false);
    expect('eventSchema' in manual.function).toBe(false);
  });
});

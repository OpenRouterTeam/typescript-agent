import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';

const shared = tool<{
  userId: string;
}>()({
  name: 'shared_tool',
  inputSchema: z.object({}),
  execute: async (_params, ctx) => ctx?.shared.userId ?? '',
});

expectTypeOf(shared.function.name).toEqualTypeOf<'shared_tool'>();

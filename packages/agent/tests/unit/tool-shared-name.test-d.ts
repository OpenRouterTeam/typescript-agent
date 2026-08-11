import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import type { Tool } from '../../src/lib/tool-types.js';

const direct = tool<{
  userId: string;
}>({
  name: 'direct_shared_tool',
  inputSchema: z.object({}),
  execute: async (_params, ctx) => ctx?.shared.userId ?? '',
});
expectTypeOf(direct).toExtend<Tool>();
expectTypeOf(direct.function.name).toEqualTypeOf<string>();

const shared = tool<{
  userId: string;
}>()({
  name: 'shared_tool',
  inputSchema: z.object({}),
  execute: async (_params, ctx) => ctx?.shared.userId ?? '',
});

expectTypeOf(shared.function.name).toEqualTypeOf<'shared_tool'>();

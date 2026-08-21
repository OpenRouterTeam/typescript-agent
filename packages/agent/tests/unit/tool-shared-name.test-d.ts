import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';
import type { CorrelatedToolResultEvent, InferToolName, Tool } from '../../src/lib/tool-types.js';

const inferred = tool({
  name: 'inferred_tool',
  inputSchema: z.object({}),
  execute: async () => '',
});
expectTypeOf(inferred.function.name).toEqualTypeOf<'inferred_tool'>();
expectTypeOf<InferToolName<typeof inferred>>().toEqualTypeOf<'inferred_tool'>();

const direct = tool<{
  userId: string;
}>({
  name: 'direct_shared_tool',
  inputSchema: z.object({}),
  execute: async (_params, ctx) => ctx?.shared.userId ?? '',
});
expectTypeOf(direct).toExtend<Tool>();
expectTypeOf(direct.function.name).toEqualTypeOf<string>();
expectTypeOf<InferToolName<typeof direct>>().toEqualTypeOf<string>();

const directEvent: CorrelatedToolResultEvent<typeof direct> = {
  type: 'tool.result',
  toolCallId: 'call_1',
  toolName: 'any_runtime_name',
  source: 'client',
  result: 'result',
  timestamp: Date.now(),
};
expectTypeOf(directEvent.toolName).toEqualTypeOf<string>();

const shared = tool<{
  userId: string;
}>()({
  name: 'shared_tool',
  inputSchema: z.object({}),
  execute: async (_params, ctx) => ctx?.shared.userId ?? '',
});

expectTypeOf(shared.function.name).toEqualTypeOf<'shared_tool'>();
expectTypeOf<InferToolName<typeof shared>>().toEqualTypeOf<'shared_tool'>();

const sharedEvent: CorrelatedToolResultEvent<typeof shared> = {
  type: 'tool.result',
  toolCallId: 'call_2',
  toolName: 'shared_tool',
  source: 'client',
  result: 'result',
  timestamp: Date.now(),
};
expectTypeOf(sharedEvent.toolName).toEqualTypeOf<'shared_tool'>();

const wrongSharedEvent: CorrelatedToolResultEvent<typeof shared> = {
  type: 'tool.result',
  toolCallId: 'call_3',
  // @ts-expect-error curried shared-context tools correlate on their literal name
  toolName: 'other_tool',
  source: 'client',
  result: 'result',
  timestamp: Date.now(),
};
void wrongSharedEvent;

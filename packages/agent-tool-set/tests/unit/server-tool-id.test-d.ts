import type { ServerToolBase } from '@openrouter/agent';
import { serverTool } from '@openrouter/agent';
import { expectTypeOf } from 'vitest';
import { createToolSet } from '../../src/tool-set.js';
import type { InferAllIds, ServerToolIdOf } from '../../src/types.js';

const precise = serverTool(
  {
    type: 'web_search_2025_08_26',
  },
  {
    id: 'server:public_search',
  },
);
expectTypeOf<ServerToolIdOf<typeof precise>>().toEqualTypeOf<'server:public_search'>();

const generalized: ServerToolBase = precise;
const set = createToolSet({
  tools: [
    generalized,
  ] as const,
});
set.deactivate('any-runtime-server-tool-id');
expectTypeOf<InferAllIds<typeof set>>().toEqualTypeOf<string>();

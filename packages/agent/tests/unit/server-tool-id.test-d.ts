import type { ServerToolBase } from '@openrouter/agent';
import { serverTool } from '@openrouter/agent';
import { expectTypeOf } from 'vitest';
import { createToolSet } from '../../src/tool-set.js';
import type { FilterToolsByIds, InferAllIds, ServerToolIdOf } from '../../src/types.js';

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

const handWritten = {
  _brand: 'server-tool',
  config: {
    type: 'web_search_2025_08_26',
  },
} as const;
const handWrittenId = 'server:web_search_2025_08_26';

expectTypeOf<ServerToolIdOf<typeof handWritten>>().toEqualTypeOf<typeof handWrittenId>();
expectTypeOf<
  FilterToolsByIds<
    readonly [
      typeof handWritten,
    ],
    typeof handWrittenId
  >
>().toEqualTypeOf<
  readonly [
    typeof handWritten,
  ]
>();

const handWrittenSet = createToolSet({
  tools: [
    handWritten,
  ] as const,
});
handWrittenSet.activate(handWrittenId);
handWrittenSet.deactivate(handWrittenId);
expectTypeOf<keyof ReturnType<typeof handWrittenSet.resolve>['statusByTool']>().toEqualTypeOf<
  typeof handWrittenId
>();

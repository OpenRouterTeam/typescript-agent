import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { serverTool, tool } from '../../src/lib/tool.js';
import { createToolSet } from '../../src/lib/tool-set.js';
import type {
  FilterToolsByIds,
  InferAllIds,
  ServerToolIdOf,
} from '../../src/lib/tool-set-types.js';
import type { ServerToolBase } from '../../src/lib/tool-types.js';

const local = tool({
  name: 'local',
  inputSchema: z.object({}),
  execute: async () => undefined,
});
const precise = serverTool(
  {
    type: 'web_search_2025_08_26',
  },
  {
    id: 'server:public_search',
  },
);
expectTypeOf<ServerToolIdOf<typeof precise>>().toEqualTypeOf<'server:public_search'>();

const erased: ServerToolBase = precise;
const set = createToolSet({
  tools: [
    local,
    erased,
  ] as const,
});
set.deactivate('server:public_search');
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

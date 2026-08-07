import { tool } from '../../src/lib/tool.js';
import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import type {
  ConditionalPartition,
  InitialPartition,
  ResolvedToolSnapshot,
} from '../../src/lib/tool-set-types.js';
import { createToolSet } from '../../src/lib/tool-set.js';

const a = tool({
  name: 'a',
  inputSchema: z.object({}),
  execute: async () => 'a',
});

const b = tool({
  name: 'b',
  inputSchema: z.object({}),
  execute: async () => 'b',
});

const staticSnapshot = createToolSet({
  tools: [
    a,
    b,
  ] as const,
})
  .deactivate('b')
  .activate('a')
  .resolve();

expectTypeOf(staticSnapshot.tools).toEqualTypeOf<
  readonly [
    typeof a,
  ]
>();
expectTypeOf(staticSnapshot.callModel.tools).toEqualTypeOf<
  readonly [
    typeof a,
  ]
>();
expectTypeOf(staticSnapshot.tools.length).toEqualTypeOf<1>();

const conditionalSnapshot = createToolSet({
  tools: [
    a,
    b,
  ] as const,
})
  .activateWhen('a', () => false)
  .resolve();

type PossibleTool = typeof a | typeof b;
expectTypeOf(conditionalSnapshot.tools).toEqualTypeOf<readonly PossibleTool[]>();
expectTypeOf(conditionalSnapshot.callModel.tools).toEqualTypeOf<readonly PossibleTool[]>();
expectTypeOf(conditionalSnapshot.tools[0]).toEqualTypeOf<PossibleTool | undefined>();
expectTypeOf(conditionalSnapshot.tools[0]).not.toEqualTypeOf<typeof a>();
expectTypeOf(conditionalSnapshot.tools.length).toEqualTypeOf<number>();

type ConditionalA = ConditionalPartition<
  InitialPartition<
    readonly [
      typeof a,
      typeof b,
    ]
  >,
  'a'
>;
type GenericActiveA = ResolvedToolSnapshot<
  readonly [
    typeof a,
    typeof b,
  ],
  ConditionalA,
  'a'
>;
declare const genericActiveA: GenericActiveA;
expectTypeOf(genericActiveA.tools).toEqualTypeOf<readonly PossibleTool[]>();
expectTypeOf(genericActiveA.callModel.tools).toEqualTypeOf<readonly PossibleTool[]>();
expectTypeOf<GenericActiveA['tools'][number]>().toEqualTypeOf<PossibleTool>();
expectTypeOf(genericActiveA.tools[0]).toEqualTypeOf<PossibleTool | undefined>();
expectTypeOf<GenericActiveA['enabled'][number]>().toEqualTypeOf<'a' | 'b'>();

const mutableSnapshot = createToolSet({
  tools: [
    a,
    b,
  ] as const,
  mutable: true,
}).resolve();

expectTypeOf(mutableSnapshot.tools).toEqualTypeOf<readonly PossibleTool[]>();
expectTypeOf(mutableSnapshot.callModel.tools).toEqualTypeOf<readonly PossibleTool[]>();
expectTypeOf(mutableSnapshot.tools[0]).toEqualTypeOf<PossibleTool | undefined>();
expectTypeOf(mutableSnapshot.tools.length).toEqualTypeOf<number>();

import { describe, expect, it } from 'vitest';

import {
  hasToolCall,
  isStopConditionMet,
  maxTokensUsed,
  stepCountIs,
} from '../../src/lib/stop-conditions.js';
import type { StepResult } from '../../src/lib/tool-types.js';

function makeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    response: {} as any,
    toolCalls: [],
    finishReason: undefined,
    usage: undefined,
    ...overrides,
  } as StepResult;
}

describe('Stop conditions + real StepResult shape', () => {
  it('stepCountIs works with StepResult[] containing real usage and toolCalls data', () => {
    const steps = [
      makeStep({
        toolCalls: [
          {
            name: 'search',
            id: 'tc1',
            arguments: {},
          },
        ] as any,
        usage: {
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 50,
        } as any,
      }),
      makeStep({
        toolCalls: [
          {
            name: 'write',
            id: 'tc2',
            arguments: {},
          },
        ] as any,
        usage: {
          totalTokens: 200,
          inputTokens: 100,
          outputTokens: 100,
        } as any,
      }),
    ];
    const condition = stepCountIs(2);
    expect(
      condition({
        steps,
      }),
    ).toBe(true);
  });

  it('hasToolCall finds tool name inside StepResult.toolCalls array', () => {
    const steps = [
      makeStep({
        toolCalls: [
          {
            name: 'search',
            id: 'tc1',
            arguments: {},
          },
          {
            name: 'analyze',
            id: 'tc2',
            arguments: {},
          },
        ] as any,
      }),
    ];
    expect(
      hasToolCall('search')({
        steps,
      }),
    ).toBe(true);
    expect(
      hasToolCall('analyze')({
        steps,
      }),
    ).toBe(true);
    expect(
      hasToolCall('missing')({
        steps,
      }),
    ).toBe(false);
  });

  it('maxTokensUsed reads from StepResult.usage.totalTokens', () => {
    const steps = [
      makeStep({
        usage: {
          totalTokens: 500,
          inputTokens: 250,
          outputTokens: 250,
        } as any,
      }),
      makeStep({
        usage: {
          totalTokens: 600,
          inputTokens: 300,
          outputTokens: 300,
        } as any,
      }),
    ];
    expect(
      maxTokensUsed(1000)({
        steps,
      }),
    ).toBe(true);
    expect(
      maxTokensUsed(1200)({
        steps,
      }),
    ).toBe(false);
  });

  it('isStopConditionMet evaluates multiple conditions against same StepResult[]', async () => {
    const steps = [
      makeStep({
        toolCalls: [
          {
            name: 'search',
            id: 'tc1',
            arguments: {},
          },
        ] as any,
        usage: {
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 50,
        } as any,
      }),
    ];

    // Neither condition met
    const result1 = await isStopConditionMet({
      stopConditions: [
        stepCountIs(5),
        hasToolCall('done'),
      ],
      steps,
    });
    expect(result1).toBe(false);

    // One condition met (hasToolCall)
    const result2 = await isStopConditionMet({
      stopConditions: [
        stepCountIs(5),
        hasToolCall('search'),
      ],
      steps,
    });
    expect(result2).toBe(true);
  });
});

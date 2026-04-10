import { describe, expect, it } from 'vitest';

import {
  hasToolCall,
  isStopConditionMet,
  maxCost,
  stepCountIs,
} from '../../src/lib/stop-conditions.js';
import { makeStep, makeTypedToolCalls, makeUsage } from '../test-constants.js';

describe('Stop condition pipeline: results -> steps -> conditions -> decision', () => {
  it('step count: 3 tool rounds -> StepResult[] length 3 -> stepCountIs(3) true -> isStopConditionMet true', async () => {
    const steps = [
      makeStep(),
      makeStep(),
      makeStep(),
    ];
    expect(
      stepCountIs(3)({
        steps,
      }),
    ).toBe(true);
    const result = await isStopConditionMet({
      stopConditions: [
        stepCountIs(3),
      ],
      steps,
    });
    expect(result).toBe(true);
  });

  it('tool call: round with "search" tool -> hasToolCall("search") true -> isStopConditionMet true', async () => {
    const steps = [
      makeStep({
        toolCalls: makeTypedToolCalls([
          {
            name: 'search',
            id: 'tc1',
            arguments: {},
          },
        ]),
      }),
    ];
    expect(
      hasToolCall('search')({
        steps,
      }),
    ).toBe(true);
    const result = await isStopConditionMet({
      stopConditions: [
        hasToolCall('search'),
      ],
      steps,
    });
    expect(result).toBe(true);
  });

  it('cost: round with usage.cost = 0.30 -> maxCost(0.25) true -> stop', async () => {
    const steps = [
      makeStep({
        usage: makeUsage({
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 50,
          cost: 0.3,
        }),
      }),
    ];
    expect(
      maxCost(0.25)({
        steps,
      }),
    ).toBe(true);
    const result = await isStopConditionMet({
      stopConditions: [
        maxCost(0.25),
      ],
      steps,
    });
    expect(result).toBe(true);
  });

  it('combined OR: stepCountIs(10) false + hasToolCall("done") true -> isStopConditionMet true', async () => {
    const steps = [
      makeStep({
        toolCalls: makeTypedToolCalls([
          {
            name: 'done',
            id: 'tc1',
            arguments: {},
          },
        ]),
      }),
    ];
    // stepCountIs(10) is false (only 1 step)
    expect(
      stepCountIs(10)({
        steps,
      }),
    ).toBe(false);
    // hasToolCall('done') is true
    expect(
      hasToolCall('done')({
        steps,
      }),
    ).toBe(true);
    // OR logic -> true
    const result = await isStopConditionMet({
      stopConditions: [
        stepCountIs(10),
        hasToolCall('done'),
      ],
      steps,
    });
    expect(result).toBe(true);
  });
});

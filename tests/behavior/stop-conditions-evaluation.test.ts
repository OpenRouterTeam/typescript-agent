import { describe, expect, it } from 'vitest';
import { hasToolCall, isStopConditionMet, stepCountIs } from '../../src/lib/stop-conditions.js';
import type { StepResult } from '../../src/lib/tool-types.js';

function makeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    stepType: 'initial',
    text: '',
    toolCalls: [],
    toolResults: [],
    response: {
      id: 'r1',
      output: [],
      parallel_tool_calls: false,
      status: 'completed',
      usage: null,
      error: null,
      incomplete_details: null,
      created_at: 0,
    },
    ...overrides,
  };
}

describe('stop conditions - isStopConditionMet evaluation', () => {
  it('returns true when any condition is true (OR logic)', async () => {
    const steps = [
      makeStep(),
      makeStep(),
      makeStep(),
    ];
    const result = await isStopConditionMet({
      stopConditions: [
        stepCountIs(5),
        stepCountIs(2),
      ],
      steps,
    });
    expect(result).toBe(true);
  });

  it('returns false when all conditions are false', async () => {
    const steps = [
      makeStep(),
    ];
    const result = await isStopConditionMet({
      stopConditions: [
        stepCountIs(5),
        hasToolCall('missing'),
      ],
      steps,
    });
    expect(result).toBe(false);
  });

  it('handles empty conditions array (returns false)', async () => {
    const result = await isStopConditionMet({
      stopConditions: [],
      steps: [
        makeStep(),
      ],
    });
    expect(result).toBe(false);
  });

  it('handles async stop conditions', async () => {
    const asyncCondition = async ({ steps }: { readonly steps: ReadonlyArray<StepResult> }) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return steps.length >= 2;
    };
    const result = await isStopConditionMet({
      stopConditions: [
        asyncCondition,
      ],
      steps: [
        makeStep(),
        makeStep(),
      ],
    });
    expect(result).toBe(true);
  });

  it('evaluates conditions in parallel', async () => {
    const order: number[] = [];
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return false;
    };
    const fast = async () => {
      await new Promise((r) => setTimeout(r, 1));
      order.push(2);
      return true;
    };
    const result = await isStopConditionMet({
      stopConditions: [
        slow,
        fast,
      ],
      steps: [],
    });
    expect(result).toBe(true);
  });
});

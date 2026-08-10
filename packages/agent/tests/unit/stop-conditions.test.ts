import type * as models from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import {
  finishReasonIs,
  hasToolCall,
  isStopConditionMet,
  maxCost,
  maxTokensUsed,
  stepCountIs,
} from '../../src/lib/stop-conditions.js';
import type { StepResult } from '../../src/lib/tool-types.js';

/**
 * Creates a minimal StepResult for stop-condition testing.
 * Stop conditions only read `toolCalls`, `usage`, and `finishReason`,
 * so the remaining fields are inert placeholders.
 */
function makeStep(overrides?: {
  toolCallNames?: string[];
  usage?: {
    totalTokens?: number;
    cost?: number;
  } | null;
  finishReason?: string;
}): StepResult {
  return {
    stepType: 'initial',
    text: '',
    toolCalls: (overrides?.toolCallNames ?? []).map((name) => ({
      name,
    })) as StepResult['toolCalls'],
    toolResults: [],
    response: {} as models.OpenResponsesResult,
    usage: overrides?.usage === null ? null : (overrides?.usage as models.Usage | undefined),
    finishReason: overrides?.finishReason,
  };
}

describe('stepCountIs', () => {
  it('returns false when below the threshold', () => {
    expect(
      stepCountIs(2)({
        steps: [
          makeStep(),
        ],
      }),
    ).toBe(false);
  });

  it('returns true when the threshold is reached exactly', () => {
    expect(
      stepCountIs(2)({
        steps: [
          makeStep(),
          makeStep(),
        ],
      }),
    ).toBe(true);
  });

  it('returns true when the threshold is exceeded', () => {
    expect(
      stepCountIs(1)({
        steps: [
          makeStep(),
          makeStep(),
          makeStep(),
        ],
      }),
    ).toBe(true);
  });

  it('returns true for zero steps when threshold is zero', () => {
    expect(
      stepCountIs(0)({
        steps: [],
      }),
    ).toBe(true);
  });
});

describe('hasToolCall', () => {
  it('returns false when no step contains the tool', () => {
    const steps = [
      makeStep({
        toolCallNames: [
          'search',
          'browse',
        ],
      }),
    ];
    expect(
      hasToolCall('email')({
        steps,
      }),
    ).toBe(false);
  });

  it('returns true when any step contains the tool', () => {
    const steps = [
      makeStep({
        toolCallNames: [
          'search',
        ],
      }),
      makeStep({
        toolCallNames: [
          'email',
        ],
      }),
    ];
    expect(
      hasToolCall('email')({
        steps,
      }),
    ).toBe(true);
  });

  it('returns false for empty steps', () => {
    expect(
      hasToolCall('search')({
        steps: [],
      }),
    ).toBe(false);
  });
});

describe('maxTokensUsed', () => {
  it('sums totalTokens across steps', () => {
    const steps = [
      makeStep({
        usage: {
          totalTokens: 400,
        },
      }),
      makeStep({
        usage: {
          totalTokens: 700,
        },
      }),
    ];
    expect(
      maxTokensUsed(1000)({
        steps,
      }),
    ).toBe(true);
    expect(
      maxTokensUsed(1101)({
        steps,
      }),
    ).toBe(false);
  });

  it('treats missing usage as zero tokens', () => {
    const steps = [
      makeStep(),
      makeStep({
        usage: null,
      }),
    ];
    expect(
      maxTokensUsed(1)({
        steps,
      }),
    ).toBe(false);
  });

  it('treats missing totalTokens as zero', () => {
    const steps = [
      makeStep({
        usage: {},
      }),
    ];
    expect(
      maxTokensUsed(0)({
        steps,
      }),
    ).toBe(true);
  });
});

describe('maxCost', () => {
  it('sums cost across steps', () => {
    const steps = [
      makeStep({
        usage: {
          cost: 0.3,
        },
      }),
      makeStep({
        usage: {
          cost: 0.25,
        },
      }),
    ];
    expect(
      maxCost(0.5)({
        steps,
      }),
    ).toBe(true);
    expect(
      maxCost(0.6)({
        steps,
      }),
    ).toBe(false);
  });

  it('treats missing cost as zero', () => {
    expect(
      maxCost(0.01)({
        steps: [
          makeStep({
            usage: {},
          }),
        ],
      }),
    ).toBe(false);
  });
});

describe('finishReasonIs', () => {
  it('returns true when any step has the finish reason', () => {
    const steps = [
      makeStep({
        finishReason: 'stop',
      }),
      makeStep({
        finishReason: 'length',
      }),
    ];
    expect(
      finishReasonIs('length')({
        steps,
      }),
    ).toBe(true);
  });

  it('returns false when no step has the finish reason', () => {
    const steps = [
      makeStep({
        finishReason: 'stop',
      }),
      makeStep(),
    ];
    expect(
      finishReasonIs('length')({
        steps,
      }),
    ).toBe(false);
  });
});

describe('isStopConditionMet', () => {
  it('returns false when no conditions are provided', async () => {
    await expect(
      isStopConditionMet({
        stopConditions: [],
        steps: [],
      }),
    ).resolves.toBe(false);
  });

  it('returns false when all conditions are false', async () => {
    await expect(
      isStopConditionMet({
        stopConditions: [
          stepCountIs(5),
          hasToolCall('search'),
        ],
        steps: [
          makeStep(),
        ],
      }),
    ).resolves.toBe(false);
  });

  it('returns true when ANY condition is true (OR logic)', async () => {
    await expect(
      isStopConditionMet({
        stopConditions: [
          stepCountIs(5),
          stepCountIs(1),
        ],
        steps: [
          makeStep(),
        ],
      }),
    ).resolves.toBe(true);
  });

  it('supports async stop conditions', async () => {
    const asyncCondition = async () => true;
    await expect(
      isStopConditionMet({
        stopConditions: [
          asyncCondition,
        ],
        steps: [],
      }),
    ).resolves.toBe(true);
  });

  it('treats undefined condition results as not-stopping', async () => {
    const undefinedCondition = () => undefined as unknown as boolean;
    await expect(
      isStopConditionMet({
        stopConditions: [
          undefinedCondition,
        ],
        steps: [],
      }),
    ).resolves.toBe(false);
  });

  it('propagates rejections from failing conditions', async () => {
    const failingCondition = () => Promise.reject(new Error('condition exploded'));
    await expect(
      isStopConditionMet({
        stopConditions: [
          failingCondition,
        ],
        steps: [],
      }),
    ).rejects.toThrow('condition exploded');
  });
});

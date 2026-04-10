import { describe, expect, it } from 'vitest';

import {
  finishReasonIs,
  hasToolCall,
  maxCost,
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

describe('stepCountIs(n) - behavior and dimension isolation', () => {
  it('returns false when steps.length < n', () => {
    const condition = stepCountIs(3);
    expect(
      condition({
        steps: [
          makeStep(),
          makeStep(),
        ],
      }),
    ).toBe(false);
  });

  it('returns true when steps.length === n', () => {
    const condition = stepCountIs(3);
    expect(
      condition({
        steps: [
          makeStep(),
          makeStep(),
          makeStep(),
        ],
      }),
    ).toBe(true);
  });

  it('returns true when steps.length > n', () => {
    const condition = stepCountIs(2);
    expect(
      condition({
        steps: [
          makeStep(),
          makeStep(),
          makeStep(),
        ],
      }),
    ).toBe(true);
  });

  it('stepCountIs(0) always returns true', () => {
    const condition = stepCountIs(0);
    expect(
      condition({
        steps: [],
      }),
    ).toBe(true);
    expect(
      condition({
        steps: [
          makeStep(),
        ],
      }),
    ).toBe(true);
  });

  it('ignores tool names, tokens, cost, finishReason in steps', () => {
    const condition = stepCountIs(1);
    const step = makeStep({
      toolCalls: [
        {
          name: 'search',
          id: 'tc1',
          arguments: {},
        },
      ] as any,
      usage: {
        totalTokens: 9999,
        inputTokens: 5000,
        outputTokens: 4999,
        cost: 100,
      } as any,
      finishReason: 'length',
    });
    // Only step count matters
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });
});

describe('hasToolCall(toolName) - behavior and dimension isolation', () => {
  it('returns false when no steps have the named tool', () => {
    const condition = hasToolCall('search');
    const step = makeStep({
      toolCalls: [
        {
          name: 'other',
          id: 'tc1',
          arguments: {},
        },
      ] as any,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('returns true when any step has a matching tool call', () => {
    const condition = hasToolCall('search');
    const step1 = makeStep({
      toolCalls: [
        {
          name: 'other',
          id: 'tc1',
          arguments: {},
        },
      ] as any,
    });
    const step2 = makeStep({
      toolCalls: [
        {
          name: 'search',
          id: 'tc2',
          arguments: {},
        },
      ] as any,
    });
    expect(
      condition({
        steps: [
          step1,
          step2,
        ],
      }),
    ).toBe(true);
  });

  it('returns false for different tool names', () => {
    const condition = hasToolCall('search');
    const step = makeStep({
      toolCalls: [
        {
          name: 'Search',
          id: 'tc1',
          arguments: {},
        },
      ] as any,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('handles step with multiple tool calls, one matching', () => {
    const condition = hasToolCall('search');
    const step = makeStep({
      toolCalls: [
        {
          name: 'other',
          id: 'tc1',
          arguments: {},
        },
        {
          name: 'search',
          id: 'tc2',
          arguments: {},
        },
      ] as any,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });

  it('ignores step count, tokens, cost, finishReason', () => {
    const condition = hasToolCall('search');
    const step = makeStep({
      toolCalls: [
        {
          name: 'search',
          id: 'tc1',
          arguments: {},
        },
      ] as any,
      usage: {
        totalTokens: 9999,
        inputTokens: 5000,
        outputTokens: 4999,
        cost: 100,
      } as any,
      finishReason: 'length',
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });
});

describe('maxTokensUsed(maxTokens) - behavior and dimension isolation', () => {
  it('returns false when total tokens < threshold', () => {
    const condition = maxTokensUsed(100);
    const step = makeStep({
      usage: {
        totalTokens: 50,
        inputTokens: 25,
        outputTokens: 25,
      } as any,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('returns true when total tokens >= threshold', () => {
    const condition = maxTokensUsed(100);
    const step = makeStep({
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      } as any,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });

  it('accumulates tokens across multiple steps', () => {
    const condition = maxTokensUsed(100);
    const step1 = makeStep({
      usage: {
        totalTokens: 60,
        inputTokens: 30,
        outputTokens: 30,
      } as any,
    });
    const step2 = makeStep({
      usage: {
        totalTokens: 50,
        inputTokens: 25,
        outputTokens: 25,
      } as any,
    });
    expect(
      condition({
        steps: [
          step1,
          step2,
        ],
      }),
    ).toBe(true);
  });

  it('steps with undefined usage -> treated as 0', () => {
    const condition = maxTokensUsed(100);
    const step = makeStep({
      usage: undefined,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('ignores step count, tool names, cost, finishReason', () => {
    const condition = maxTokensUsed(100);
    const step = makeStep({
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
        cost: 999,
      } as any,
      finishReason: 'stop',
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });
});

describe('maxCost(maxCostInDollars) - behavior and dimension isolation', () => {
  it('returns false when total cost < threshold', () => {
    const condition = maxCost(1.0);
    const step = makeStep({
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
        cost: 0.5,
      } as any,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('returns true when total cost >= threshold', () => {
    const condition = maxCost(1.0);
    const step = makeStep({
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
        cost: 1.0,
      } as any,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });

  it('accumulates cost across multiple steps', () => {
    const condition = maxCost(1.0);
    const step1 = makeStep({
      usage: {
        totalTokens: 50,
        inputTokens: 25,
        outputTokens: 25,
        cost: 0.6,
      } as any,
    });
    const step2 = makeStep({
      usage: {
        totalTokens: 50,
        inputTokens: 25,
        outputTokens: 25,
        cost: 0.5,
      } as any,
    });
    expect(
      condition({
        steps: [
          step1,
          step2,
        ],
      }),
    ).toBe(true);
  });

  it('steps with undefined usage.cost -> treated as 0', () => {
    const condition = maxCost(1.0);
    const step = makeStep({
      usage: undefined,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('ignores step count, tool names, tokens, finishReason', () => {
    const condition = maxCost(1.0);
    const step = makeStep({
      toolCalls: [
        {
          name: 'search',
          id: 'tc1',
          arguments: {},
        },
      ] as any,
      usage: {
        totalTokens: 99999,
        inputTokens: 50000,
        outputTokens: 49999,
        cost: 1.0,
      } as any,
      finishReason: 'length',
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });
});

describe('finishReasonIs(reason) - behavior and dimension isolation', () => {
  it('returns false when no step has the specified reason', () => {
    const condition = finishReasonIs('length');
    const step = makeStep({
      finishReason: 'stop',
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('returns true when any step has matching reason', () => {
    const condition = finishReasonIs('length');
    const step1 = makeStep({
      finishReason: 'stop',
    });
    const step2 = makeStep({
      finishReason: 'length',
    });
    expect(
      condition({
        steps: [
          step1,
          step2,
        ],
      }),
    ).toBe(true);
  });

  it('matches "length" specifically', () => {
    const condition = finishReasonIs('length');
    const step = makeStep({
      finishReason: 'length',
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });

  it('steps with undefined finishReason -> not matched', () => {
    const condition = finishReasonIs('length');
    const step = makeStep({
      finishReason: undefined,
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(false);
  });

  it('ignores step count, tool names, tokens, cost', () => {
    const condition = finishReasonIs('length');
    const step = makeStep({
      toolCalls: [
        {
          name: 'search',
          id: 'tc1',
          arguments: {},
        },
      ] as any,
      usage: {
        totalTokens: 99999,
        inputTokens: 50000,
        outputTokens: 49999,
        cost: 999,
      } as any,
      finishReason: 'length',
    });
    expect(
      condition({
        steps: [
          step,
        ],
      }),
    ).toBe(true);
  });
});

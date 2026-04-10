import { describe, expect, it } from 'vitest';
import {
  getToolExecutionErrors,
  hasToolExecutionErrors,
  summarizeToolExecutions,
  toolResultsToMap,
} from '../../src/lib/tool-orchestrator.js';
import type { Tool, ToolExecutionResult } from '../../src/lib/tool-types.js';

function makeResult(overrides: Partial<ToolExecutionResult<Tool>>): ToolExecutionResult<Tool> {
  return {
    toolCallId: 'c1',
    toolName: 'test',
    result: {
      ok: true,
    },
    ...overrides,
  };
}

describe('tool orchestrator - toolResultsToMap', () => {
  it('converts results array to map keyed by toolCallId', () => {
    const results = [
      makeResult({
        toolCallId: 'c1',
        result: 'a',
      }),
      makeResult({
        toolCallId: 'c2',
        result: 'b',
      }),
    ];
    const map = toolResultsToMap(results);
    expect(map.size).toBe(2);
    expect(map.get('c1')!.result).toBe('a');
    expect(map.get('c2')!.result).toBe('b');
  });

  it('includes preliminaryResults in map entries', () => {
    const results = [
      makeResult({
        toolCallId: 'c1',
        result: 'final',
        preliminaryResults: [
          'p1',
          'p2',
        ] as any,
      }),
    ];
    const map = toolResultsToMap(results);
    expect(map.get('c1')!.preliminaryResults).toEqual([
      'p1',
      'p2',
    ]);
  });
});

describe('tool orchestrator - summarizeToolExecutions', () => {
  it('produces success line for successful result', () => {
    const summary = summarizeToolExecutions([
      makeResult({
        toolCallId: 'c1',
        toolName: 'add',
      }),
    ]);
    expect(summary).toContain('add');
    expect(summary).toContain('c1');
  });

  it('produces error line for failed result', () => {
    const summary = summarizeToolExecutions([
      makeResult({
        toolCallId: 'c2',
        toolName: 'fail',
        result: null,
        error: new Error('oops'),
      }),
    ]);
    expect(summary).toContain('fail');
    expect(summary).toContain('oops');
  });
});

describe('tool orchestrator - hasToolExecutionErrors', () => {
  it('returns true when any result has error', () => {
    expect(
      hasToolExecutionErrors([
        makeResult({}),
        makeResult({
          error: new Error('err'),
        }),
      ]),
    ).toBe(true);
  });

  it('returns false when no results have errors', () => {
    expect(
      hasToolExecutionErrors([
        makeResult({}),
      ]),
    ).toBe(false);
  });
});

describe('tool orchestrator - getToolExecutionErrors', () => {
  it('extracts all error objects from results', () => {
    const err = new Error('err1');
    const results = [
      makeResult({}),
      makeResult({
        error: err,
      }),
    ];
    const errors = getToolExecutionErrors(results);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(err);
  });
});

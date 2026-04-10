import { describe, expect, it } from 'vitest';
import {
  hasToolExecutionErrors,
  summarizeToolExecutions,
  toolResultsToMap,
} from '../../src/lib/tool-orchestrator.js';
import type { Tool, ToolExecutionResult } from '../../src/lib/tool-types.js';

describe('Orchestrator <- Executor: utility functions consume real ToolExecutionResult', () => {
  const successResult: ToolExecutionResult<Tool> = {
    toolCallId: 'tc_1',
    toolName: 'search',
    result: {
      data: 'found',
    },
  };

  const errorResult: ToolExecutionResult<Tool> = {
    toolCallId: 'tc_2',
    toolName: 'delete',
    result: null,
    error: new Error('Permission denied'),
  };

  it('toolResultsToMap correctly maps real ToolExecutionResult objects', () => {
    const map = toolResultsToMap([
      successResult,
      errorResult,
    ]);
    expect(map.get('tc_1')).toEqual({
      result: {
        data: 'found',
      },
      preliminaryResults: undefined,
    });
    expect(map.get('tc_2')).toEqual({
      result: null,
      preliminaryResults: undefined,
    });
  });

  it('hasToolExecutionErrors detects error field on real ToolExecutionResult', () => {
    expect(
      hasToolExecutionErrors([
        successResult,
      ]),
    ).toBe(false);
    expect(
      hasToolExecutionErrors([
        successResult,
        errorResult,
      ]),
    ).toBe(true);
  });

  it('summarizeToolExecutions formats real success + error results', () => {
    const summary = summarizeToolExecutions([
      successResult,
      errorResult,
    ]);
    expect(summary).toContain('search');
    expect(summary).toContain('SUCCESS');
    expect(summary).toContain('delete');
    expect(summary).toContain('Permission denied');
  });
});

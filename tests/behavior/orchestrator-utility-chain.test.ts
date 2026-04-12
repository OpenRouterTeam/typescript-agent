import { describe, expect, it } from 'vitest';
import {
  getToolExecutionErrors,
  hasToolExecutionErrors,
  summarizeToolExecutions,
  toolResultsToMap,
} from '../../src/lib/tool-orchestrator.js';
import type { Tool, ToolExecutionResult } from '../../src/lib/tool-types.js';

describe('Orchestrator utility chain', () => {
  it('mixed results: one success + one failure -> toolResultsToMap -> hasToolExecutionErrors -> getToolExecutionErrors -> summarizeToolExecutions', () => {
    const successResult: ToolExecutionResult<Tool> = {
      toolCallId: 'tc_1',
      toolName: 'search',
      result: {
        data: 'found',
      },
    };

    const failureResult: ToolExecutionResult<Tool> = {
      toolCallId: 'tc_2',
      toolName: 'delete',
      result: null,
      error: new Error('Permission denied'),
    };

    const results = [
      successResult,
      failureResult,
    ];

    // Step 1: Map results
    const map = toolResultsToMap(results);
    expect(map.size).toBe(2);
    expect(map.get('tc_1')).toBeDefined();
    expect(map.get('tc_2')).toBeDefined();

    // Step 2: Check for errors
    expect(hasToolExecutionErrors(results)).toBe(true);

    // Step 3: Get errors
    const errors = getToolExecutionErrors(results);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('Permission denied');

    // Step 4: Summarize
    const summary = summarizeToolExecutions(results);
    expect(summary).toContain('search');
    expect(summary).toContain('SUCCESS');
    expect(summary).toContain('delete');
    expect(summary).toContain('Permission denied');
  });
});

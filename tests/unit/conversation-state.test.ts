import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  appendToMessages,
  createInitialState,
  createRejectedResult,
  createUnsentResult,
  generateConversationId,
  partitionToolCalls,
  toolRequiresApproval,
  unsentResultsToAPIFormat,
  updateState,
} from '../../src/lib/conversation-state.js';
import { tool } from '../../src/lib/tool.js';
import { hasApprovalRequiredTools, toolHasApprovalConfigured } from '../../src/lib/tool-types.js';

describe('Conversation State Utilities', () => {
  describe('generateConversationId', () => {
    it('should generate unique IDs with conv_ prefix', () => {
      const id1 = generateConversationId();
      const id2 = generateConversationId();

      expect(id1).toMatch(/^conv_/);
      expect(id2).toMatch(/^conv_/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('createInitialState', () => {
    it('should create state with default values', () => {
      const state = createInitialState();

      expect(state.id).toMatch(/^conv_/);
      expect(state.messages).toEqual([]);
      expect(state.status).toBe('in_progress');
      expect(state.createdAt).toBeDefined();
      expect(state.updatedAt).toBeDefined();
    });

    it('should use custom ID when provided', () => {
      const state = createInitialState('custom-id');
      expect(state.id).toBe('custom-id');
    });
  });

  describe('updateState', () => {
    it('should update status and timestamp', () => {
      const initial = createInitialState();
      const originalUpdatedAt = initial.updatedAt;

      const updated = updateState(initial, {
        status: 'complete',
      });

      expect(updated.status).toBe('complete');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
      expect(updated.id).toBe(initial.id); // ID unchanged
    });

    it('should preserve fields not being updated', () => {
      const initial = createInitialState('test-id');
      const updated = updateState(initial, {
        status: 'awaiting_approval',
      });

      expect(updated.id).toBe('test-id');
      expect(updated.messages).toEqual([]);
      expect(updated.createdAt).toBe(initial.createdAt);
    });
  });

  describe('createUnsentResult', () => {
    it('should create valid unsent result', () => {
      const result = createUnsentResult('call-1', 'test_tool', {
        data: 'test',
      });

      expect(result.callId).toBe('call-1');
      expect(result.name).toBe('test_tool');
      expect(result.output).toEqual({
        data: 'test',
      });
      expect(result.error).toBeUndefined();
    });

    it('should handle null output', () => {
      const result = createUnsentResult('call-1', 'test_tool', null);

      expect(result.callId).toBe('call-1');
      expect(result.output).toBeNull();
    });
  });

  describe('createRejectedResult', () => {
    it('should create rejected result with default message', () => {
      const result = createRejectedResult('call-1', 'test_tool');

      expect(result.callId).toBe('call-1');
      expect(result.output).toBeNull();
      expect(result.error).toBe('Tool call rejected by user');
    });

    it('should use custom rejection reason', () => {
      const result = createRejectedResult('call-1', 'test_tool', 'Not allowed');
      expect(result.error).toBe('Not allowed');
    });
  });

  describe('toolRequiresApproval', () => {
    const toolWithApproval = tool({
      name: 'dangerous_action',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });

    const toolWithoutApproval = tool({
      name: 'safe_action',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });

    const context = {
      numberOfTurns: 1,
    };

    it('should return true for tools with requireApproval', async () => {
      const toolCall = {
        id: '1',
        name: 'dangerous_action',
        arguments: {},
      };
      expect(
        await toolRequiresApproval(
          toolCall,
          [
            toolWithApproval,
            toolWithoutApproval,
          ],
          context,
        ),
      ).toBe(true);
    });

    it('should return false for tools without requireApproval', async () => {
      const toolCall = {
        id: '1',
        name: 'safe_action',
        arguments: {},
      };
      expect(
        await toolRequiresApproval(
          toolCall,
          [
            toolWithApproval,
            toolWithoutApproval,
          ],
          context,
        ),
      ).toBe(false);
    });

    it('should return false for unknown tools', async () => {
      const toolCall = {
        id: '1',
        name: 'unknown_tool',
        arguments: {},
      };
      expect(
        await toolRequiresApproval(
          toolCall,
          [
            toolWithApproval,
            toolWithoutApproval,
          ],
          context,
        ),
      ).toBe(false);
    });

    it('should use call-level check when provided', async () => {
      const toolCall = {
        id: '1',
        name: 'safe_action',
        arguments: {},
      };
      const alwaysRequire = () => true;

      expect(
        await toolRequiresApproval(
          toolCall,
          [
            toolWithoutApproval,
          ],
          context,
          alwaysRequire,
        ),
      ).toBe(true);
    });

    it('should call-level check can override tool-level approval', async () => {
      const toolCall = {
        id: '1',
        name: 'dangerous_action',
        arguments: {},
      };
      const neverRequire = () => false;

      // Call-level check takes precedence
      expect(
        await toolRequiresApproval(
          toolCall,
          [
            toolWithApproval,
          ],
          context,
          neverRequire,
        ),
      ).toBe(false);
    });

    it('should support async call-level check', async () => {
      const toolCall = {
        id: '1',
        name: 'safe_action',
        arguments: {},
      };
      const asyncCheck = async (
        _tc: unknown,
        ctx: {
          numberOfTurns: number;
        },
      ) => {
        // Simulate async operation
        await Promise.resolve();
        return ctx.numberOfTurns > 0;
      };

      expect(
        await toolRequiresApproval(
          toolCall,
          [
            toolWithoutApproval,
          ],
          context,
          asyncCheck,
        ),
      ).toBe(true);
      expect(
        await toolRequiresApproval(
          toolCall,
          [
            toolWithoutApproval,
          ],
          {
            numberOfTurns: 0,
          },
          asyncCheck,
        ),
      ).toBe(false);
    });

    it('should support function-based tool-level requireApproval', async () => {
      // Tool with function-based approval that checks params
      const toolWithFunctionApproval = tool({
        name: 'conditional_action',
        inputSchema: z.object({
          dangerous: z.boolean(),
        }),
        requireApproval: (params) => params.dangerous === true,
        execute: async () => ({}),
      });

      // Safe action - should not require approval
      const safeCall = {
        id: '1',
        name: 'conditional_action',
        arguments: {
          dangerous: false,
        },
      };
      expect(
        await toolRequiresApproval(
          safeCall,
          [
            toolWithFunctionApproval,
          ],
          context,
        ),
      ).toBe(false);

      // Dangerous action - should require approval
      const dangerousCall = {
        id: '2',
        name: 'conditional_action',
        arguments: {
          dangerous: true,
        },
      };
      expect(
        await toolRequiresApproval(
          dangerousCall,
          [
            toolWithFunctionApproval,
          ],
          context,
        ),
      ).toBe(true);
    });

    it('should support async function-based tool-level requireApproval', async () => {
      // Tool with async function-based approval
      const toolWithAsyncApproval = tool({
        name: 'async_conditional',
        inputSchema: z.object({
          value: z.number(),
        }),
        requireApproval: async (params, ctx) => {
          // Simulate async operation
          await Promise.resolve();
          // Require approval if value > 100 OR after first turn
          return params.value > 100 || ctx.numberOfTurns > 1;
        },
        execute: async () => ({}),
      });

      // Low value, first turn - no approval needed
      const lowValueCall = {
        id: '1',
        name: 'async_conditional',
        arguments: {
          value: 50,
        },
      };
      expect(
        await toolRequiresApproval(
          lowValueCall,
          [
            toolWithAsyncApproval,
          ],
          {
            numberOfTurns: 1,
          },
        ),
      ).toBe(false);

      // High value - approval needed
      const highValueCall = {
        id: '2',
        name: 'async_conditional',
        arguments: {
          value: 150,
        },
      };
      expect(
        await toolRequiresApproval(
          highValueCall,
          [
            toolWithAsyncApproval,
          ],
          {
            numberOfTurns: 1,
          },
        ),
      ).toBe(true);

      // Low value but second turn - approval needed
      expect(
        await toolRequiresApproval(
          lowValueCall,
          [
            toolWithAsyncApproval,
          ],
          {
            numberOfTurns: 2,
          },
        ),
      ).toBe(true);
    });

    it('should pass context to function-based tool-level approval', async () => {
      const receivedContexts: Array<{
        numberOfTurns: number;
      }> = [];

      const toolWithContextCheck = tool({
        name: 'context_checker',
        inputSchema: z.object({}),
        requireApproval: (_params, ctx) => {
          receivedContexts.push(ctx);
          return ctx.numberOfTurns > 2;
        },
        execute: async () => ({}),
      });

      const toolCall = {
        id: '1',
        name: 'context_checker',
        arguments: {},
      };

      await toolRequiresApproval(
        toolCall,
        [
          toolWithContextCheck,
        ],
        {
          numberOfTurns: 1,
        },
      );
      await toolRequiresApproval(
        toolCall,
        [
          toolWithContextCheck,
        ],
        {
          numberOfTurns: 3,
        },
      );

      expect(receivedContexts).toEqual([
        {
          numberOfTurns: 1,
        },
        {
          numberOfTurns: 3,
        },
      ]);
    });
  });

  describe('partitionToolCalls', () => {
    const approvalTool = tool({
      name: 'needs_approval',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });

    const autoTool = tool({
      name: 'auto_execute',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });

    const context = {
      numberOfTurns: 1,
    };

    it('should partition tool calls correctly', async () => {
      const toolCalls = [
        {
          id: '1',
          name: 'needs_approval',
          arguments: {},
        },
        {
          id: '2',
          name: 'auto_execute',
          arguments: {},
        },
      ];

      const { requiresApproval, autoExecute } = await partitionToolCalls(
        toolCalls,
        [
          approvalTool,
          autoTool,
        ],
        context,
      );

      expect(requiresApproval).toHaveLength(1);
      expect(requiresApproval[0]?.name).toBe('needs_approval');
      expect(autoExecute).toHaveLength(1);
      expect(autoExecute[0]?.name).toBe('auto_execute');
    });

    it('should handle all tools requiring approval', async () => {
      const toolCalls = [
        {
          id: '1',
          name: 'needs_approval',
          arguments: {},
        },
      ];

      const { requiresApproval, autoExecute } = await partitionToolCalls(
        toolCalls,
        [
          approvalTool,
          autoTool,
        ],
        context,
      );

      expect(requiresApproval).toHaveLength(1);
      expect(autoExecute).toHaveLength(0);
    });

    it('should handle all tools auto-executing', async () => {
      const toolCalls = [
        {
          id: '1',
          name: 'auto_execute',
          arguments: {},
        },
      ];

      const { requiresApproval, autoExecute } = await partitionToolCalls(
        toolCalls,
        [
          approvalTool,
          autoTool,
        ],
        context,
      );

      expect(requiresApproval).toHaveLength(0);
      expect(autoExecute).toHaveLength(1);
    });

    it('should handle empty tool calls', async () => {
      const { requiresApproval, autoExecute } = await partitionToolCalls(
        [],
        [
          approvalTool,
          autoTool,
        ],
        context,
      );

      expect(requiresApproval).toHaveLength(0);
      expect(autoExecute).toHaveLength(0);
    });
  });

  describe('appendToMessages', () => {
    it('should append to empty messages', () => {
      const result = appendToMessages(
        [],
        [
          {
            role: 'user' as const,
            content: 'Hello',
          },
        ],
      );

      expect(result).toHaveLength(1);
    });

    it('should append to existing messages', () => {
      const existing = [
        {
          role: 'user' as const,
          content: 'Hello',
        },
      ];
      const result = appendToMessages(existing, [
        {
          role: 'assistant' as const,
          content: 'Hi there!',
        },
      ]);

      expect(result).toHaveLength(2);
    });

    it('should handle string input', () => {
      const result = appendToMessages('What is 2+2?', [
        {
          role: 'assistant' as const,
          content: '4',
        },
      ]);

      expect(result).toHaveLength(2);
    });
  });

  describe('unsentResultsToAPIFormat', () => {
    it('should stringify regular object outputs', () => {
      const results = [
        createUnsentResult('call-1', 'test_tool', {
          data: 'test',
        }),
      ];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted).toHaveLength(1);
      expect(formatted[0]?.type).toBe('function_call_output');
      expect(formatted[0]?.callId).toBe('call-1');
      expect(formatted[0]?.output).toBe('{"data":"test"}');
    });

    it('should stringify error outputs', () => {
      const result = createRejectedResult('call-1', 'test_tool', 'Something went wrong');
      const formatted = unsentResultsToAPIFormat([result]);

      expect(formatted[0]?.output).toBe('{"error":"Something went wrong"}');
    });

    it('should pass through content arrays with input_text blocks', () => {
      const contentArray = [
        {
          type: 'input_text' as const,
          text: 'Hello world',
        },
      ];
      const results = [createUnsentResult('call-1', 'test_tool', contentArray)];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted[0]?.output).toEqual(contentArray);
      expect(typeof formatted[0]?.output).not.toBe('string');
    });

    it('should pass through content arrays with input_image blocks', () => {
      const contentArray = [
        {
          type: 'input_image' as const,
          detail: 'auto' as const,
          imageUrl: 'data:image/png;base64,abc123',
        },
      ];
      const results = [createUnsentResult('call-1', 'image_gen', contentArray)];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted[0]?.output).toEqual(contentArray);
      expect(typeof formatted[0]?.output).not.toBe('string');
    });

    it('should pass through mixed content arrays', () => {
      const contentArray = [
        {
          type: 'input_text' as const,
          text: 'Generated image:',
        },
        {
          type: 'input_image' as const,
          detail: 'auto' as const,
          imageUrl: 'data:image/png;base64,abc123',
        },
      ];
      const results = [createUnsentResult('call-1', 'image_gen', contentArray)];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted[0]?.output).toEqual(contentArray);
    });

    it('should stringify arrays that are not content arrays', () => {
      const regularArray = [
        'item1',
        'item2',
      ];
      const results = [createUnsentResult('call-1', 'test_tool', regularArray)];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted[0]?.output).toBe('["item1","item2"]');
    });

    it('should stringify empty arrays', () => {
      const results = [createUnsentResult('call-1', 'test_tool', [])];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted[0]?.output).toBe('[]');
    });

    it('should stringify arrays with invalid content block types', () => {
      const invalidArray = [
        {
          type: 'unknown_type',
          data: 'test',
        },
      ];
      const results = [createUnsentResult('call-1', 'test_tool', invalidArray)];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted[0]?.output).toBe('[{"type":"unknown_type","data":"test"}]');
    });

    it('should generate correct IDs', () => {
      const results = [
        createUnsentResult('abc-123', 'tool1', 'result1'),
        createUnsentResult('def-456', 'tool2', 'result2'),
      ];

      const formatted = unsentResultsToAPIFormat(results);

      expect(formatted[0]?.id).toBe('output_abc-123');
      expect(formatted[1]?.id).toBe('output_def-456');
    });
  });

  describe('Approval Detection Type Guards', () => {
    const toolWithBooleanApproval = tool({
      name: 'needs_approval',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });

    const toolWithFunctionApproval = tool({
      name: 'conditional_approval',
      inputSchema: z.object({
        dangerous: z.boolean(),
      }),
      requireApproval: (params) => params.dangerous,
      execute: async () => ({}),
    });

    const toolWithoutApproval = tool({
      name: 'safe_tool',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });

    const toolWithFalseApproval = tool({
      name: 'explicitly_safe',
      inputSchema: z.object({}),
      requireApproval: false,
      execute: async () => ({}),
    });

    describe('toolHasApprovalConfigured', () => {
      it('should return true for tools with requireApproval: true', () => {
        expect(toolHasApprovalConfigured(toolWithBooleanApproval)).toBe(true);
      });

      it('should return true for tools with requireApproval function', () => {
        expect(toolHasApprovalConfigured(toolWithFunctionApproval)).toBe(true);
      });

      it('should return false for tools without requireApproval', () => {
        expect(toolHasApprovalConfigured(toolWithoutApproval)).toBe(false);
      });

      it('should return false for tools with requireApproval: false', () => {
        expect(toolHasApprovalConfigured(toolWithFalseApproval)).toBe(false);
      });
    });

    describe('hasApprovalRequiredTools', () => {
      it('should return true if any tool has approval configured', () => {
        expect(
          hasApprovalRequiredTools([
            toolWithoutApproval,
            toolWithBooleanApproval,
          ]),
        ).toBe(true);
      });

      it('should return true for function-based approval', () => {
        expect(
          hasApprovalRequiredTools([
            toolWithFunctionApproval,
          ]),
        ).toBe(true);
      });

      it('should return false if no tools have approval configured', () => {
        expect(
          hasApprovalRequiredTools([
            toolWithoutApproval,
            toolWithFalseApproval,
          ]),
        ).toBe(false);
      });

      it('should return false for empty array', () => {
        expect(hasApprovalRequiredTools([])).toBe(false);
      });
    });
  });
});

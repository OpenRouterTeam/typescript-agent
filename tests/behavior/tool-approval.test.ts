import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { partitionToolCalls, toolRequiresApproval } from '../../src/lib/conversation-state.js';
import { tool } from '../../src/lib/tool.js';
import type { ParsedToolCall, Tool, TurnContext } from '../../src/lib/tool-types.js';
import { hasApprovalRequiredTools, toolHasApprovalConfigured } from '../../src/lib/tool-types.js';

const turnCtx: TurnContext = {
  numberOfTurns: 1,
};

describe('tool approval - toolRequiresApproval', () => {
  it('returns false when tool has no requireApproval', async () => {
    const t = tool({
      name: 'free',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'free',
      arguments: {},
    };
    expect(
      await toolRequiresApproval(
        tc,
        [
          t,
        ],
        turnCtx,
      ),
    ).toBe(false);
  });

  it('returns true when tool has requireApproval: true', async () => {
    const t = tool({
      name: 'guarded',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'guarded',
      arguments: {},
    };
    expect(
      await toolRequiresApproval(
        tc,
        [
          t,
        ],
        turnCtx,
      ),
    ).toBe(true);
  });

  it('returns false when tool has requireApproval: false', async () => {
    const t = tool({
      name: 'open',
      inputSchema: z.object({}),
      requireApproval: false,
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'open',
      arguments: {},
    };
    expect(
      await toolRequiresApproval(
        tc,
        [
          t,
        ],
        turnCtx,
      ),
    ).toBe(false);
  });

  it('calls requireApproval function with args and context', async () => {
    const t = tool({
      name: 'conditional',
      inputSchema: z.object({
        dangerous: z.boolean(),
      }),
      requireApproval: (params) => params.dangerous,
      execute: async () => ({}),
    });
    const tc1: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'conditional',
      arguments: {
        dangerous: true,
      },
    };
    const tc2: ParsedToolCall<Tool> = {
      id: 'c2',
      name: 'conditional',
      arguments: {
        dangerous: false,
      },
    };
    expect(
      await toolRequiresApproval(
        tc1,
        [
          t,
        ],
        turnCtx,
      ),
    ).toBe(true);
    expect(
      await toolRequiresApproval(
        tc2,
        [
          t,
        ],
        turnCtx,
      ),
    ).toBe(false);
  });

  it('call-level check overrides tool-level setting', async () => {
    const t = tool({
      name: 'guarded',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'guarded',
      arguments: {},
    };
    const callCheck = () => false;
    expect(
      await toolRequiresApproval(
        tc,
        [
          t,
        ],
        turnCtx,
        callCheck,
      ),
    ).toBe(false);
  });

  it('returns false for unknown tool name', async () => {
    const t = tool({
      name: 'known',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'unknown',
      arguments: {},
    };
    expect(
      await toolRequiresApproval(
        tc,
        [
          t,
        ],
        turnCtx,
      ),
    ).toBe(false);
  });
});

describe('tool approval - partitionToolCalls', () => {
  it('separates tool calls into requiresApproval and autoExecute', async () => {
    const guarded = tool({
      name: 'guarded',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });
    const free = tool({
      name: 'free',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const tc1: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'guarded',
      arguments: {},
    };
    const tc2: ParsedToolCall<Tool> = {
      id: 'c2',
      name: 'free',
      arguments: {},
    };
    const result = await partitionToolCalls(
      [
        tc1,
        tc2,
      ],
      [
        guarded,
        free,
      ],
      turnCtx,
    );
    expect(result.requiresApproval).toHaveLength(1);
    expect(result.autoExecute).toHaveLength(1);
    expect(result.requiresApproval[0]!.name).toBe('guarded');
    expect(result.autoExecute[0]!.name).toBe('free');
  });

  it('all auto-execute when no tools require approval', async () => {
    const free = tool({
      name: 'free',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'free',
      arguments: {},
    };
    const result = await partitionToolCalls(
      [
        tc,
      ],
      [
        free,
      ],
      turnCtx,
    );
    expect(result.autoExecute).toHaveLength(1);
    expect(result.requiresApproval).toHaveLength(0);
  });

  it('all require approval when all tools need it', async () => {
    const guarded = tool({
      name: 'g1',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });
    const tc: ParsedToolCall<Tool> = {
      id: 'c1',
      name: 'g1',
      arguments: {},
    };
    const result = await partitionToolCalls(
      [
        tc,
      ],
      [
        guarded,
      ],
      turnCtx,
    );
    expect(result.requiresApproval).toHaveLength(1);
    expect(result.autoExecute).toHaveLength(0);
  });
});

describe('tool approval - type-level utilities', () => {
  it('toolHasApprovalConfigured returns true for tool with requireApproval', () => {
    const t = tool({
      name: 'g',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });
    expect(toolHasApprovalConfigured(t)).toBe(true);
  });

  it('toolHasApprovalConfigured returns false for tool without requireApproval', () => {
    const t = tool({
      name: 'f',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    expect(toolHasApprovalConfigured(t)).toBe(false);
  });

  it('hasApprovalRequiredTools returns true when any tool needs approval', () => {
    const t1 = tool({
      name: 'f',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const t2 = tool({
      name: 'g',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async () => ({}),
    });
    expect(
      hasApprovalRequiredTools([
        t1,
        t2,
      ]),
    ).toBe(true);
  });

  it('hasApprovalRequiredTools returns false when no tools need approval', () => {
    const t1 = tool({
      name: 'f',
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    expect(
      hasApprovalRequiredTools([
        t1,
      ]),
    ).toBe(false);
  });
});

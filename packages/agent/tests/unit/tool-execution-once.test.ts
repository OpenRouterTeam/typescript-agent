/**
 * Regression tests: each client tool call must execute exactly once per round.
 *
 * An earlier revision of handleApprovalCheck pre-executed auto-approve tools
 * on every response (even when nothing needed an approval gate) and then let
 * the main loop run the same calls again via executeToolRound — triple
 * execution for a plain auto tool. These tests drive the real
 * executeToolsIfNeeded loop end-to-end and pin the exactly-once contract.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { OpenResponsesResult } from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import { ModelResult } from '../../src/lib/model-result.js';
import type { ConversationState, Tool } from '../../src/lib/tool-types.js';
import { ToolType } from '../../src/lib/tool-types.js';

function makeCountingTool(name: string, onExec: () => void): Tool {
  return {
    type: ToolType.Function,
    function: {
      name,
      description: `tool ${name}`,
      inputSchema: z.object({}).loose(),
      outputSchema: z.unknown(),
      execute: async () => {
        onExec();
        return {
          ok: true,
        };
      },
    },
  } as unknown as Tool;
}

function makeToolCallResponse(name: string): OpenResponsesResult {
  return {
    id: 'resp_tool',
    output: [
      {
        type: 'function_call',
        id: 'out_1',
        callId: 'c1',
        name,
        arguments: '{}',
        status: 'completed',
      },
    ],
  } as unknown as OpenResponsesResult;
}

function makeFinalResponse(): OpenResponsesResult {
  return {
    id: 'resp_final',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'done',
          },
        ],
        status: 'completed',
      },
    ],
  } as unknown as OpenResponsesResult;
}

type Internal = {
  currentState: ConversationState<readonly Tool[]> | null;
  initPromise: Promise<void> | null;
  getInitialResponse: () => Promise<OpenResponsesResult>;
  makeFollowupRequest: (...args: unknown[]) => Promise<OpenResponsesResult>;
  shouldStopExecution: () => Promise<boolean>;
  executeToolsIfNeeded: () => Promise<void>;
};

function buildLoopedModelResult(opts: {
  tools: readonly Tool[];
  hooks?: HooksManager;
  toolName: string;
}): Internal {
  const config: Record<string, unknown> = {
    request: {
      model: 'test-model',
      input: 'hello',
    },
    client: {} as unknown as OpenRouterCore,
    tools: opts.tools,
  };
  if (opts.hooks) {
    config['hooks'] = opts.hooks;
  }
  const m = new ModelResult<readonly Tool[]>(
    config as unknown as ConstructorParameters<typeof ModelResult<readonly Tool[]>>[0],
  );
  const ent = m as unknown as Internal;
  ent.currentState = {
    id: 'conv_once',
    messages: [],
    status: 'in_progress',
    createdAt: 0,
    updatedAt: 0,
  } as ConversationState<readonly Tool[]>;
  ent.initPromise = Promise.resolve();
  ent.getInitialResponse = async () => makeToolCallResponse(opts.toolName);
  ent.makeFollowupRequest = async () => makeFinalResponse();
  ent.shouldStopExecution = async () => false;
  return ent;
}

describe('exactly-once tool execution through executeToolsIfNeeded', () => {
  it('executes an auto tool exactly once per round without hooks', async () => {
    let execCount = 0;
    const tool = makeCountingTool('t', () => {
      execCount++;
    });
    const ent = buildLoopedModelResult({
      tools: [
        tool,
      ] as const,
      toolName: 't',
    });

    await ent.executeToolsIfNeeded();

    expect(execCount).toBe(1);
  });

  it('executes an auto tool exactly once per round with a hooks manager attached', async () => {
    let execCount = 0;
    let preToolUseCount = 0;
    const hooks = new HooksManager();
    hooks.on('PreToolUse', {
      handler: () => {
        preToolUseCount++;
        return undefined;
      },
    });
    const tool = makeCountingTool('t', () => {
      execCount++;
    });
    const ent = buildLoopedModelResult({
      tools: [
        tool,
      ] as const,
      hooks,
      toolName: 't',
    });

    await ent.executeToolsIfNeeded();

    expect(execCount).toBe(1);
    expect(preToolUseCount).toBe(1);
  });

  it('executes a gated tool exactly once when PermissionRequest allows it', async () => {
    let execCount = 0;
    const hooks = new HooksManager();
    hooks.on('PermissionRequest', {
      handler: () => ({
        decision: 'allow' as const,
      }),
    });
    const base = makeCountingTool('guarded', () => {
      execCount++;
    });
    const gated = {
      ...base,
      function: {
        ...(
          base as unknown as {
            function: Record<string, unknown>;
          }
        ).function,
        requireApproval: true,
      },
    } as Tool;
    const ent = buildLoopedModelResult({
      tools: [
        gated,
      ] as const,
      hooks,
      toolName: 'guarded',
    });

    await ent.executeToolsIfNeeded();

    expect(execCount).toBe(1);
  });

  it('never executes a gated tool when PermissionRequest denies it', async () => {
    let execCount = 0;
    const hooks = new HooksManager();
    hooks.on('PermissionRequest', {
      handler: () => ({
        decision: 'deny' as const,
        reason: 'policy',
      }),
    });
    const base = makeCountingTool('guarded', () => {
      execCount++;
    });
    const gated = {
      ...base,
      function: {
        ...(
          base as unknown as {
            function: Record<string, unknown>;
          }
        ).function,
        requireApproval: true,
      },
    } as Tool;
    const ent = buildLoopedModelResult({
      tools: [
        gated,
      ] as const,
      hooks,
      toolName: 'guarded',
    });

    await ent.executeToolsIfNeeded();

    expect(execCount).toBe(0);
  });
});

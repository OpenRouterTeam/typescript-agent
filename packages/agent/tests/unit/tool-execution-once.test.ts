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
import type { OpenResponsesResult, OutputItems } from '@openrouter/sdk/models';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import type { GetResponseOptions } from '../../src/lib/model-result.js';
import { ModelResult } from '../../src/lib/model-result.js';
import type { ConversationState, Tool } from '../../src/lib/tool-types.js';
import { ToolType } from '../../src/lib/tool-types.js';

function makeCountingTool(
  name: string,
  onExec: () => void,
  opts?: {
    requireApproval?: boolean;
  },
): Tool {
  return {
    type: ToolType.Function,
    function: {
      name,
      description: `tool ${name}`,
      inputSchema: z.object({}).loose(),
      outputSchema: z.unknown(),
      requireApproval: opts?.requireApproval ?? false,
      execute: async () => {
        onExec();
        return {
          ok: true,
        };
      },
    },
  };
}

/**
 * Fully-typed OpenResponsesResult fixture. Every required field is populated
 * with a neutral value so the mocks need no `as unknown as` casts and stay
 * compile-checked against SDK type changes.
 */
function makeResponse(id: string, output: OutputItems[]): OpenResponsesResult {
  return {
    id,
    object: 'response',
    createdAt: 0,
    completedAt: 0,
    status: 'completed',
    model: 'test-model',
    output,
    error: null,
    incompleteDetails: null,
    instructions: null,
    metadata: null,
    frequencyPenalty: null,
    presencePenalty: null,
    temperature: null,
    topP: null,
    toolChoice: 'auto',
    tools: [],
    parallelToolCalls: false,
  };
}

function makeToolCallResponse(name: string): OpenResponsesResult {
  return makeResponse('resp_tool', [
    {
      type: 'function_call',
      id: 'out_1',
      callId: 'c1',
      name,
      arguments: '{}',
      status: 'completed',
    },
  ]);
}

function makeFinalResponse(): OpenResponsesResult {
  return makeResponse('resp_final', [
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
  ]);
}

/**
 * The private ModelResult internals the loop tests drive directly. The only
 * cast in this file is `ModelResult -> Internal` below: these members are
 * private by design, and the tests deliberately stub the network-facing ones
 * (getInitialResponse / makeFollowupRequest) to stay hermetic.
 */
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
  const config: GetResponseOptions<readonly Tool[]> = {
    request: {
      model: 'test-model',
      input: 'hello',
    },
    client: {} as OpenRouterCore,
    tools: opts.tools,
  };
  if (opts.hooks) {
    config.hooks = opts.hooks;
  }
  const m = new ModelResult<readonly Tool[]>(config);
  const ent = m as unknown as Internal;
  const state: ConversationState<readonly Tool[]> = {
    id: 'conv_once',
    messages: [],
    status: 'in_progress',
    createdAt: 0,
    updatedAt: 0,
  };
  ent.currentState = state;
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
    const gated = makeCountingTool(
      'guarded',
      () => {
        execCount++;
      },
      {
        requireApproval: true,
      },
    );
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
    const gated = makeCountingTool(
      'guarded',
      () => {
        execCount++;
      },
      {
        requireApproval: true,
      },
    );
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

/**
 * Tests for the hook integration points in ModelResult.
 *
 * These tests focus on orchestration: PreToolUse/PostToolUse must fire on
 * every tool-execution path (auto, auto-approve, approved), PermissionRequest
 * influences the approval gate, UserPromptSubmit fires for stateful
 * conversations, Stop hooks respect forceResume bounds and appendPrompt, and
 * SessionStart receives a populated config object.
 *
 * The ModelResult is constructed with a stub client; we drive its internal
 * state directly rather than going through betaResponsesSend so the tests
 * stay hermetic.
 */
import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { OpenResponsesResult } from '@openrouter/sdk/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { HooksManager } from '../../src/lib/hooks-manager.js';
import { ModelResult } from '../../src/lib/model-result.js';
import type {
  ConversationState,
  ParsedToolCall,
  StateAccessor,
  Tool,
  TurnContext,
  UnsentToolResult,
} from '../../src/lib/tool-types.js';
import { ToolType } from '../../src/lib/tool-types.js';

// Spy hygiene: a failed assertion before an inline mockRestore() would
// otherwise leak the console spy into subsequent tests in this file.
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAutoTool(
  name: string,
  exec: (args: unknown) => unknown = () => ({
    ok: true,
  }),
) {
  return {
    type: ToolType.Function,
    function: {
      name,
      description: `Auto tool ${name}`,
      inputSchema: z.object({}).loose(),
      outputSchema: z.unknown(),
      execute: async (args: unknown) => exec(args),
    },
  } as unknown as Tool;
}

function makeApprovalTool(name: string) {
  return {
    type: ToolType.Function,
    function: {
      name,
      description: `Approval tool ${name}`,
      inputSchema: z.object({}).loose(),
      outputSchema: z.unknown(),
      execute: async () => ({
        ran: true,
      }),
      requireApproval: true,
    },
  } as unknown as Tool;
}

function makeStateAccessor<T extends readonly Tool[]>(
  initial?: ConversationState<T> | null,
): StateAccessor<T> & {
  getLatest: () => ConversationState<T> | null;
} {
  let state: ConversationState<T> | null = initial ?? null;
  return {
    load: async () => state,
    save: async (s) => {
      state = s;
    },
    getLatest: () => state,
  };
}

type InternalModelResult = {
  currentState: ConversationState<readonly Tool[]> | null;
  stateAccessor: StateAccessor<readonly Tool[]> | null;
  contextStore: unknown;
  resolvedRequest: Record<string, unknown> | null;
  finalResponse: OpenResponsesResult | null;
  initPromise: Promise<void> | null;
  toolExecutionPromise: Promise<void> | null;
  sessionStartEmitted: boolean;
  runToolWithHooks: (
    tool: Tool,
    toolCall: ParsedToolCall<Tool>,
    turnContext: TurnContext,
  ) => Promise<{
    type: string;
    result?: unknown;
    reason?: string;
    errorMessage?: string;
    effectiveToolCall?: ParsedToolCall<Tool>;
  }>;
  emitPermissionRequest: (toolCall: ParsedToolCall<Tool>) => Promise<{
    decision: 'allow' | 'deny' | 'ask_user';
    reason?: string;
  }>;
  executeAutoApproveTools: (
    toolCalls: ParsedToolCall<Tool>[],
    turnContext: TurnContext,
  ) => Promise<UnsentToolResult<readonly Tool[]>[]>;
  executeToolRound: (
    toolCalls: ParsedToolCall<Tool>[],
    turnContext: TurnContext,
  ) => Promise<{
    toolResults: {
      callId: string;
      output: string;
    }[];
    pausedCalls: ParsedToolCall<Tool>[];
  }>;
  handleApprovalCheck: (
    toolCalls: ParsedToolCall<Tool>[],
    currentRound: number,
    currentResponse: OpenResponsesResult,
  ) => Promise<boolean>;
  maybeRunUserPromptSubmit: (input: unknown) => Promise<
    | {
        applyTo: (original: unknown) => unknown;
      }
    | undefined
  >;
  injectAppendPromptMessage: (p: string) => Promise<void>;
  executeToolsIfNeeded: () => Promise<void>;
  options: Record<string, unknown>;
};

function internal(m: ModelResult<readonly Tool[]>): InternalModelResult {
  return m as unknown as InternalModelResult;
}

function buildModelResult<T extends readonly Tool[]>(opts: {
  tools?: T;
  hooks?: HooksManager;
  state?: StateAccessor<T>;
  requireApproval?: (tc: ParsedToolCall<T[number]>, ctx: TurnContext) => boolean | Promise<boolean>;
}): ModelResult<T> {
  const config: Record<string, unknown> = {
    request: {
      model: 'test-model',
      input: 'hello',
    },
    client: {} as unknown as OpenRouterCore,
  };
  if (opts.tools) {
    config['tools'] = opts.tools;
  }
  if (opts.hooks) {
    config['hooks'] = opts.hooks;
  }
  if (opts.state) {
    config['state'] = opts.state;
  }
  if (opts.requireApproval) {
    config['requireApproval'] = opts.requireApproval;
  }
  return new ModelResult<T>(config as unknown as ConstructorParameters<typeof ModelResult<T>>[0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelResult hooks integration', () => {
  describe('runToolWithHooks', () => {
    it('fires PreToolUse and PostToolUse around a successful execution', async () => {
      const hooks = new HooksManager();
      const pre = vi.fn();
      const post = vi.fn();
      hooks.on('PreToolUse', {
        handler: pre,
      });
      hooks.on('PostToolUse', {
        handler: post,
      });

      const tool = makeAutoTool('hello');
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });

      const result = await internal(m).runToolWithHooks(
        tool,
        {
          id: 'call_1',
          name: 'hello',
          arguments: {},
        },
        {
          numberOfTurns: 1,
        },
      );

      expect(result.type).toBe('execution');
      expect(pre).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
      const [payload] = post.mock.calls[0] ?? [];
      expect(payload).toMatchObject({
        toolName: 'hello',
      });
      expect(
        (
          payload as {
            durationMs?: number;
          }
        ).durationMs,
      ).toBeGreaterThanOrEqual(0);
    });

    it('short-circuits when PreToolUse returns block=true', async () => {
      const hooks = new HooksManager();
      hooks.on('PreToolUse', {
        handler: () => ({
          block: 'nope',
        }),
      });
      const post = vi.fn();
      hooks.on('PostToolUse', {
        handler: post,
      });
      const fail = vi.fn();
      hooks.on('PostToolUseFailure', {
        handler: fail,
      });

      const execSpy = vi.fn();
      const tool = makeAutoTool('blocked', () => {
        execSpy();
        return {
          shouldNotRun: true,
        };
      });
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });

      const result = await internal(m).runToolWithHooks(
        tool,
        {
          id: 'call_b',
          name: 'blocked',
          arguments: {},
        },
        {
          numberOfTurns: 1,
        },
      );

      expect(result.type).toBe('hook_blocked');
      expect(result.reason).toBe('nope');
      expect(execSpy).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    });

    it('fires PostToolUseFailure when the tool throws', async () => {
      const hooks = new HooksManager();
      const fail = vi.fn();
      const post = vi.fn();
      hooks.on('PostToolUseFailure', {
        handler: fail,
      });
      hooks.on('PostToolUse', {
        handler: post,
      });

      const tool = makeAutoTool('bomb', () => {
        throw new Error('boom');
      });
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });

      const result = await internal(m).runToolWithHooks(
        tool,
        {
          id: 'call_x',
          name: 'bomb',
          arguments: {},
        },
        {
          numberOfTurns: 1,
        },
      );

      expect(result.type).toBe('execution');
      expect(fail).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
    });

    it('returns parse_error and skips hooks when arguments failed to parse', async () => {
      const hooks = new HooksManager();
      const pre = vi.fn();
      const post = vi.fn();
      const fail = vi.fn();
      hooks.on('PreToolUse', {
        handler: pre,
      });
      hooks.on('PostToolUse', {
        handler: post,
      });
      hooks.on('PostToolUseFailure', {
        handler: fail,
      });

      const execSpy = vi.fn();
      const tool = makeAutoTool('parsebomb', () => {
        execSpy();
        return {
          ran: true,
        };
      });
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });

      // Simulate what the stream parser leaves when JSON.parse fails on the
      // raw arguments: `arguments` stays a string instead of becoming an
      // object. The hook chain must not see this payload.
      const result = await internal(m).runToolWithHooks(
        tool,
        {
          id: 'call_parse',
          name: 'parsebomb',
          arguments: '{not valid json' as unknown as Record<string, never>,
        },
        {
          numberOfTurns: 1,
        },
      );

      expect(result.type).toBe('parse_error');
      expect(result.errorMessage).toContain('Failed to parse tool call arguments');
      expect(execSpy).not.toHaveBeenCalled();
      expect(pre).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    });

    it('preserves original null arguments on effectiveToolCall when no PreToolUse mutation fires', async () => {
      // Regression: reference-equality against the coerced `{}` payload used
      // to look like a mutation had occurred and overwrite `arguments` with
      // `{}`, erasing the distinction between "no args" and "empty args".
      // The fix tracks mutation application explicitly.
      const hooks = new HooksManager();
      const pre = vi.fn();
      hooks.on('PreToolUse', {
        handler: pre,
      });

      const tool = makeAutoTool('nopargs');
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });

      const result = await internal(m).runToolWithHooks(
        tool,
        {
          id: 'call_noargs',
          name: 'nopargs',
          arguments: null as unknown as Record<string, unknown>,
        },
        {
          numberOfTurns: 1,
        },
      );

      expect(result.type).toBe('execution');
      expect(pre).toHaveBeenCalledTimes(1);
      // effectiveToolCall.arguments must pass through unchanged when no
      // handler piped a mutation — NOT silently coerced to {}.
      expect(result.effectiveToolCall?.arguments).toBeNull();
    });

    it('applies mutatedInput from PreToolUse even when original arguments were null', async () => {
      const hooks = new HooksManager();
      hooks.on('PreToolUse', {
        handler: () => ({
          mutatedInput: {
            injected: true,
          },
        }),
      });

      const tool = makeAutoTool('withmutation');
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });

      const result = await internal(m).runToolWithHooks(
        tool,
        {
          id: 'call_mut',
          name: 'withmutation',
          arguments: null as unknown as Record<string, unknown>,
        },
        {
          numberOfTurns: 1,
        },
      );

      expect(result.type).toBe('execution');
      expect(result.effectiveToolCall?.arguments).toEqual({
        injected: true,
      });
    });

    it('threads each run session id per emit when two runs share one HooksManager', async () => {
      // Devin finding: the manager-level setSessionId default is a single
      // mutable field, so two concurrent runs sharing one manager would
      // clobber each other. The engine now passes sessionId in the per-emit
      // context; simulate the clobber by priming the manager with run B's id
      // and asserting run A's tool hooks still see run A's state id.
      const hooks = new HooksManager();
      const seen: string[] = [];
      hooks.on('PreToolUse', {
        handler: (_p, ctx) => {
          seen.push(ctx.sessionId);
        },
      });
      hooks.on('PostToolUse', {
        handler: (_p, ctx) => {
          seen.push(ctx.sessionId);
        },
      });

      const tool = makeAutoTool('shared');
      const runA = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });
      internal(runA).currentState = {
        id: 'conv_run_a',
        messages: [],
        status: 'in_progress',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as ConversationState<readonly Tool[]>;

      // Run B starts later and overwrites the manager-level default.
      hooks.setSessionId('conv_run_b');

      await internal(runA).runToolWithHooks(
        tool,
        {
          id: 'call_shared',
          name: 'shared',
          arguments: {},
        },
        {
          numberOfTurns: 1,
        },
      );

      expect(seen).toEqual([
        'conv_run_a',
        'conv_run_a',
      ]);
    });
  });

  describe('executeAutoApproveTools', () => {
    it('fires Pre/PostToolUse for each auto-executed call', async () => {
      const hooks = new HooksManager();
      const pre = vi.fn();
      const post = vi.fn();
      hooks.on('PreToolUse', {
        handler: pre,
      });
      hooks.on('PostToolUse', {
        handler: post,
      });

      const tool = makeAutoTool('auto');
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });

      const results = await internal(m).executeAutoApproveTools(
        [
          {
            id: 'c1',
            name: 'auto',
            arguments: {},
          },
          {
            id: 'c2',
            name: 'auto',
            arguments: {},
          },
        ] as ParsedToolCall<Tool>[],
        {
          numberOfTurns: 1,
        },
      );

      expect(results).toHaveLength(2);
      expect(pre).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe('PermissionRequest hook', () => {
    it('allow: skips approval gate and routes to auto-execute', async () => {
      const hooks = new HooksManager();
      hooks.on('PermissionRequest', {
        handler: () => ({
          decision: 'allow' as const,
        }),
      });
      const executed = vi.fn();
      const tool = makeAutoTool('guarded', () => {
        executed();
        return {
          ok: true,
        };
      });
      // keep requireApproval=true so it goes into needsApproval
      const approvalTool = {
        ...tool,
        function: {
          ...(
            tool as unknown as {
              function: Record<string, unknown>;
            }
          ).function,
          requireApproval: true,
        },
      } as Tool;

      const stateAccessor = makeStateAccessor<readonly Tool[]>({
        id: 'conv_perm_allow',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      });

      const m = buildModelResult({
        tools: [
          approvalTool,
        ] as const,
        hooks,
        state: stateAccessor,
      });
      // Prime internal state so handleApprovalCheck has a currentState to edit
      const ent = internal(m);
      ent.currentState = await stateAccessor.load();
      ent.stateAccessor = stateAccessor;

      const paused = await ent.handleApprovalCheck(
        [
          {
            id: 'c_allow',
            name: 'guarded',
            arguments: {},
          },
        ] as ParsedToolCall<Tool>[],
        0,
        makeResponse(),
      );

      // When the hook says allow, the call is promoted past the gate and the
      // approval flow does not pause — handleApprovalCheck returns false.
      // Execution is deferred to the normal tool round (which runs each call
      // exactly once), so nothing has executed yet at this point.
      expect(paused).toBe(false);
      expect(executed).not.toHaveBeenCalled();
    });

    it('deny: synthesizes a denied result and does not execute', async () => {
      const hooks = new HooksManager();
      hooks.on('PermissionRequest', {
        handler: () => ({
          decision: 'deny' as const,
          reason: 'policy',
        }),
      });
      const executed = vi.fn();
      const tool = {
        ...makeAutoTool('guarded', () => {
          executed();
          return {
            ok: true,
          };
        }),
      } as Tool;
      const approvalTool = {
        ...tool,
        function: {
          ...(
            tool as unknown as {
              function: Record<string, unknown>;
            }
          ).function,
          requireApproval: true,
        },
      } as Tool;

      const stateAccessor = makeStateAccessor<readonly Tool[]>({
        id: 'conv_perm_deny',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      });

      const m = buildModelResult({
        tools: [
          approvalTool,
        ] as const,
        hooks,
        state: stateAccessor,
      });
      const ent = internal(m);
      ent.currentState = await stateAccessor.load();
      ent.stateAccessor = stateAccessor;

      const paused = await ent.handleApprovalCheck(
        [
          {
            id: 'c_deny',
            name: 'guarded',
            arguments: {},
          },
        ] as ParsedToolCall<Tool>[],
        0,
        makeResponse(),
      );

      expect(paused).toBe(false);
      expect(executed).not.toHaveBeenCalled();

      // The denial is recorded for the tool round, which synthesizes a
      // rejected output instead of executing the call.
      const { toolResults } = await ent.executeToolRound(
        [
          {
            id: 'c_deny',
            name: 'guarded',
            arguments: {},
          },
        ] as ParsedToolCall<Tool>[],
        {
          numberOfTurns: 1,
        },
      );
      expect(executed).not.toHaveBeenCalled();
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]?.output).toContain('policy');
    });

    it('ask_user: falls through to the existing approval flow', async () => {
      const hooks = new HooksManager();
      hooks.on('PermissionRequest', {
        handler: () => ({
          decision: 'ask_user' as const,
        }),
      });
      const approvalTool = makeApprovalTool('guarded');

      const stateAccessor = makeStateAccessor<readonly Tool[]>({
        id: 'conv_ask',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      });

      const m = buildModelResult({
        tools: [
          approvalTool,
        ] as const,
        hooks,
        state: stateAccessor,
      });
      const ent = internal(m);
      ent.currentState = await stateAccessor.load();
      ent.stateAccessor = stateAccessor;

      const paused = await ent.handleApprovalCheck(
        [
          {
            id: 'c_ask',
            name: 'guarded',
            arguments: {},
          },
        ] as ParsedToolCall<Tool>[],
        0,
        makeResponse(),
      );

      expect(paused).toBe(true);
      const latest = stateAccessor.getLatest();
      expect(latest?.status).toBe('awaiting_approval');
      expect((latest?.pendingToolCalls ?? []).map((tc) => tc.id)).toEqual([
        'c_ask',
      ]);
    });
  });

  describe('UserPromptSubmit', () => {
    it('fires for a string input and mutates it back into the request', async () => {
      const hooks = new HooksManager();
      hooks.on('UserPromptSubmit', {
        handler: () => ({
          mutatedPrompt: 'HELLO (mutated)',
        }),
      });

      const m = buildModelResult({
        hooks,
      });
      const ent = internal(m);
      // Fresh conv state so sessionId is set.
      ent.currentState = {
        id: 'conv_1',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;

      const outcome = await ent.maybeRunUserPromptSubmit('hello');
      expect(outcome).toBeDefined();
      expect(outcome?.applyTo('hello')).toBe('HELLO (mutated)');
    });

    it('fires for structured input by finding the latest user-string message', async () => {
      const hooks = new HooksManager();
      hooks.on('UserPromptSubmit', {
        handler: ({ prompt }) => ({
          mutatedPrompt: `[wrap] ${prompt}`,
        }),
      });

      const m = buildModelResult({
        hooks,
      });
      const ent = internal(m);
      ent.currentState = {
        id: 'conv_2',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;

      const original = [
        {
          role: 'user',
          content: 'previous',
        },
        {
          role: 'assistant',
          content: 'reply',
        },
        {
          role: 'user',
          content: 'newest',
        },
      ];
      const outcome = await ent.maybeRunUserPromptSubmit(original);
      expect(outcome).toBeDefined();
      const applied = outcome?.applyTo(original) as Array<{
        role: string;
        content: string;
      }>;
      expect(applied[applied.length - 1]?.content).toBe('[wrap] newest');
      expect(applied[0]?.content).toBe('previous');
    });

    it('rejects with an explanatory error when the hook rejects', async () => {
      const hooks = new HooksManager();
      hooks.on('UserPromptSubmit', {
        handler: () => ({
          reject: 'no good',
        }),
      });

      const m = buildModelResult({
        hooks,
      });
      const ent = internal(m);
      ent.currentState = {
        id: 'conv_3',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;

      await expect(ent.maybeRunUserPromptSubmit('hello')).rejects.toThrow('no good');
    });
  });

  describe('Stop hook', () => {
    it('injectAppendPromptMessage appends a user message to state and request', async () => {
      const hooks = new HooksManager();
      const m = buildModelResult({
        hooks,
      });
      const ent = internal(m);
      ent.currentState = {
        id: 'conv_stop',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;
      ent.resolvedRequest = {
        input: [],
        model: 'test',
      };

      await ent.injectAppendPromptMessage('please continue');
      const state = ent.currentState;
      expect(Array.isArray(state?.messages)).toBe(true);
      expect(state?.messages).toHaveLength(1);
      const req = ent.resolvedRequest as {
        input: Array<{
          content: string;
        }>;
      };
      expect(req.input[0]?.content).toBe('please continue');
    });

    it('forceResume loop is capped so a misbehaving hook cannot spin forever', async () => {
      // Drive the REAL executeToolsIfNeeded loop: shouldStopExecution always
      // fires, the Stop handler always returns forceResume, and no tool round
      // ever runs (no progress). The engine must cap the overrides at
      // MAX_FORCE_RESUME_OVERRIDES (3), warn, and terminate — rather than
      // spinning forever.
      const hooks = new HooksManager();
      let stopCalls = 0;
      hooks.on('Stop', {
        handler: () => {
          stopCalls++;
          return {
            forceResume: true,
          };
        },
      });

      const tool = makeAutoTool('t');
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });
      const ent = internal(m);
      ent.currentState = {
        id: 'conv_stop_cap',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;
      ent.initPromise = Promise.resolve();

      const toolCallResponse = {
        ...makeResponse(),
        output: [
          {
            type: 'function_call',
            id: 'out_1',
            callId: 'c1',
            name: 't',
            arguments: '{}',
            status: 'completed',
          },
        ],
      } as unknown as OpenResponsesResult;

      const mProto = m as unknown as {
        getInitialResponse: () => Promise<OpenResponsesResult>;
        shouldStopExecution: () => Promise<boolean>;
      };
      mProto.getInitialResponse = async () => toolCallResponse;
      // Stop condition fires on every iteration -- no progress is possible.
      mProto.shouldStopExecution = async () => true;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await ent.executeToolsIfNeeded();

      // MAX overrides honored + 1 final Stop emit that hits the cap = 4.
      expect(stopCalls).toBe(4);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('forceResume honored 3 times'));
      warnSpy.mockRestore();
    });
  });

  describe('SessionEnd lifecycle', () => {
    it('fires SessionEnd on approval pause with reason="complete"', async () => {
      // Issue 1: approval pauses used to skip SessionEnd because the early
      // `return` after `handleApprovalCheck` jumped past the tail emission.
      const hooks = new HooksManager();
      const sessionEnd = vi.fn();
      const drainSpy = vi.spyOn(hooks, 'drain');
      hooks.on('SessionEnd', {
        handler: sessionEnd,
      });

      const approvalTool = makeApprovalTool('gated');
      const stateAccessor = makeStateAccessor<readonly Tool[]>({
        id: 'conv_end_pause',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      });

      const m = buildModelResult({
        tools: [
          approvalTool,
        ] as const,
        hooks,
        state: stateAccessor,
      });
      const ent = internal(m);
      ent.currentState = await stateAccessor.load();
      ent.stateAccessor = stateAccessor;
      // Skip initStream: it tries to make a real API call. Mark SessionStart
      // as emitted so SessionEnd is allowed to fire in the finally block.
      ent.initPromise = Promise.resolve();
      ent.sessionStartEmitted = true;
      // Prime a response carrying a tool call that requires approval so the
      // execution loop takes the "pause for approval" branch.
      ent.finalResponse = {
        ...makeResponse(),
        output: [
          {
            type: 'function_call',
            id: 'out_1',
            callId: 'call_pause',
            name: 'gated',
            arguments: '{}',
            status: 'completed',
          },
        ],
      } as unknown as OpenResponsesResult;

      await ent.executeToolsIfNeeded();

      expect(sessionEnd).toHaveBeenCalledTimes(1);
      expect(sessionEnd.mock.calls[0]?.[0]).toMatchObject({
        reason: 'complete',
      });
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('fires SessionEnd with reason="error" when the loop throws', async () => {
      const hooks = new HooksManager();
      const sessionEnd = vi.fn();
      const drainSpy = vi.spyOn(hooks, 'drain');
      hooks.on('SessionEnd', {
        handler: sessionEnd,
      });

      const m = buildModelResult({
        hooks,
      });
      const ent = internal(m);
      ent.currentState = {
        id: 'conv_end_err',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;
      ent.initPromise = Promise.resolve();
      ent.sessionStartEmitted = true;
      // No finalResponse or reusableStream => getInitialResponse throws,
      // which should still trigger SessionEnd with reason='error'.
      ent.finalResponse = null;

      await expect(ent.executeToolsIfNeeded()).rejects.toThrow();

      expect(sessionEnd).toHaveBeenCalledTimes(1);
      expect(sessionEnd.mock.calls[0]?.[0]).toMatchObject({
        reason: 'error',
      });
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('forceResume counter reset', () => {
    it('resets after a tool round with observable progress so later overrides do not trip the cap', async () => {
      // Issue 2: counter used to only increment across an entire session. Drive
      // the real executeToolsIfNeeded loop so the engine sees
      //   override -> override -> tool round (reset) -> override -> override
      // Under the OLD code this would have tripped the cap at the fourth
      // override. Under the fix the tool round resets the counter so the
      // engine finishes without emitting the cap warning.
      const hooks = new HooksManager();
      let stopCalls = 0;
      hooks.on('Stop', {
        handler: () => {
          stopCalls++;
          return {
            forceResume: true,
          };
        },
      });

      const tool = makeAutoTool('t');
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });
      const ent = internal(m);
      ent.currentState = {
        id: 'conv_reset',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;
      ent.initPromise = Promise.resolve();

      const toolCallResponse = {
        ...makeResponse(),
        output: [
          {
            type: 'function_call',
            id: 'out_1',
            callId: 'c1',
            name: 't',
            arguments: '{}',
            status: 'completed',
          },
        ],
      } as unknown as OpenResponsesResult;

      let shouldStopCalls = 0;
      const mProto = m as unknown as {
        getInitialResponse: () => Promise<OpenResponsesResult>;
        shouldStopExecution: () => Promise<boolean>;
        executeToolRound: (...args: unknown[]) => Promise<{
          toolResults: unknown[];
          pausedCalls: unknown[];
        }>;
        makeFollowupRequest: (...args: unknown[]) => Promise<OpenResponsesResult>;
      };
      mProto.getInitialResponse = async () => toolCallResponse;
      mProto.shouldStopExecution = async () => {
        shouldStopCalls++;
        // shouldStop=false at iteration 3 so the loop runs the tool round
        // (which triggers the reset). Every other iteration, shouldStop=true,
        // which emits Stop and the handler forces a resume.
        return shouldStopCalls !== 3;
      };
      mProto.executeToolRound = async () => ({
        toolResults: [
          {
            type: 'function_call_output',
            id: 'output_c1',
            callId: 'c1',
            output: '{}',
          },
        ],
        pausedCalls: [],
      });
      // Return the same tool-call response so the loop keeps going after
      // the reset, giving us more forceResume iterations.
      mProto.makeFollowupRequest = async () => toolCallResponse;

      // Track stopCalls at the moment of the cap warning so we can assert
      // the cap fired AFTER the reset window (stopCalls > MAX+1 rather than
      // stopCalls == MAX+1 under the old code).
      let stopCallsAtCap = -1;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
        if (
          typeof msg === 'string' &&
          msg.includes('forceResume honored') &&
          stopCallsAtCap === -1
        ) {
          stopCallsAtCap = stopCalls;
        }
      });
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('loop took too long')), 2000);
      });
      try {
        await Promise.race([
          ent.executeToolsIfNeeded(),
          timeoutPromise,
        ]);
      } catch {
        // Loop eventually breaks (cap trips post-reset too) and
        // validateFinalResponse may throw on the stubbed output. Either way,
        // we only care about when the cap fired relative to the tool round.
      }
      warnSpy.mockRestore();

      // The cap MUST have fired at some point (sanity check that the guard
      // still works at all).
      expect(stopCallsAtCap).toBeGreaterThan(-1);
      // Under the OLD code (no reset), the cap fires on the 4th Stop emission
      // (override count hits 3 at that point). That means stopCallsAtCap==4.
      // Under the FIX, the reset happens at iteration 3 (shouldStop=false
      // branch, tool round runs), so the cap cannot fire until at least 3
      // more overrides accumulate after that -- i.e. stopCallsAtCap >= 5.
      expect(stopCallsAtCap).toBeGreaterThanOrEqual(5);
    });

    it('hook-blocked tool outputs count as progress and reset the counter (documented edge case)', async () => {
      // A PreToolUse hook that blocks EVERY call still produces rejected
      // function_call_output items, which the model receives as feedback.
      // That deliberately counts as progress (toolResults.length > 0) and
      // resets the forceResume counter -- each reset costs a full model
      // round trip, so the loop cannot spin hot, and stopWhen conditions
      // still bound the run. This test pins that choice: with a blocking
      // PreToolUse hook interleaved (same shape as the reset test above),
      // the cap fires only AFTER the reset window, exactly like a round of
      // real executions would.
      const hooks = new HooksManager();
      let stopCalls = 0;
      hooks.on('Stop', {
        handler: () => {
          stopCalls++;
          return {
            forceResume: true,
          };
        },
      });
      // Block every tool call -- no tool body ever executes.
      const preToolUse = vi.fn(() => ({
        block: 'blocked by policy',
      }));
      hooks.on('PreToolUse', {
        handler: preToolUse,
      });

      const executed = vi.fn();
      const tool = makeAutoTool('t', () => {
        executed();
        return {
          ok: true,
        };
      });
      const m = buildModelResult({
        tools: [
          tool,
        ] as const,
        hooks,
      });
      const ent = internal(m);
      ent.currentState = {
        id: 'conv_blocked_progress',
        messages: [],
        status: 'in_progress',
        createdAt: 0,
        updatedAt: 0,
      } as ConversationState<readonly Tool[]>;
      ent.initPromise = Promise.resolve();

      const toolCallResponse = {
        ...makeResponse(),
        output: [
          {
            type: 'function_call',
            id: 'out_1',
            callId: 'c1',
            name: 't',
            arguments: '{}',
            status: 'completed',
          },
        ],
      } as unknown as OpenResponsesResult;

      let shouldStopCalls = 0;
      const mProto = m as unknown as {
        getInitialResponse: () => Promise<OpenResponsesResult>;
        shouldStopExecution: () => Promise<boolean>;
        makeFollowupRequest: (...args: unknown[]) => Promise<OpenResponsesResult>;
      };
      mProto.getInitialResponse = async () => toolCallResponse;
      mProto.shouldStopExecution = async () => {
        shouldStopCalls++;
        // Let the REAL executeToolRound run at iteration 3; the blocking
        // PreToolUse hook produces a rejected output (no execution).
        return shouldStopCalls !== 3;
      };
      mProto.makeFollowupRequest = async () => toolCallResponse;

      let stopCallsAtCap = -1;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
        if (
          typeof msg === 'string' &&
          msg.includes('forceResume honored') &&
          stopCallsAtCap === -1
        ) {
          stopCallsAtCap = stopCalls;
        }
      });
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('loop took too long')), 2000);
      });
      try {
        await Promise.race([
          ent.executeToolsIfNeeded(),
          timeoutPromise,
        ]);
      } catch {
        // As in the reset test: only the cap timing matters.
      }
      warnSpy.mockRestore();

      // The tool body never ran -- only the blocked output was produced.
      expect(executed).not.toHaveBeenCalled();
      expect(preToolUse).toHaveBeenCalled();
      // The cap still fires eventually (sanity), but only after the blocked
      // round reset the counter: >= 5 Stop emissions, same threshold as the
      // real-execution reset test.
      expect(stopCallsAtCap).toBeGreaterThanOrEqual(5);
    });
  });

  // SessionStart end-to-end emission (via the real initStream) is covered in
  // hooks-session-lifecycle.test.ts, which mocks betaResponsesSend at the
  // module level.
});

// ---------------------------------------------------------------------------
// Local helper to avoid deep OpenResponsesResult construction noise
// ---------------------------------------------------------------------------

function makeResponse(): OpenResponsesResult {
  return {
    id: 'resp_test',
    object: 'response',
    createdAt: 0,
    model: 'test-model',
    status: 'completed',
    completedAt: 0,
    output: [],
    error: null,
    incompleteDetails: null,
    temperature: null,
    topP: null,
    presencePenalty: null,
    frequencyPenalty: null,
    metadata: null,
    instructions: null,
    tools: [],
    toolChoice: 'auto',
    parallelToolCalls: false,
  } as unknown as OpenResponsesResult;
}

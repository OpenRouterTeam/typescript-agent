import type { OpenRouterCore } from '@openrouter/sdk/core';
import type { $ZodObject, $ZodShape, $ZodType, infer as zodInfer } from 'zod/v4/core';
import type { CallModelInput } from './async-params.js';
import { extractTextFromResponse } from './conversation-state.js';
import type { ModelResult } from './model-result.js';
import { TASK_TOOL_NAME } from './tool-check.js';
import type { TaskTranscriptSource } from './tool-task.js';
import { truncateTranscriptTail } from './tool-task.js';
import type {
  AsyncToolAck,
  ContextFromSchema,
  ConversationState,
  NextTurnParamsFunctions,
  StateAccessor,
  Tool,
  ToolApprovalCheck,
  ToolCheckConfig,
  ToolExecuteContext,
  ToolLoopKey,
  UnifiedTool,
} from './tool-types.js';
import { SHARED_CONTEXT_KEY, ToolType } from './tool-types.js';

/**
 * The child run spec an agent tool produces per call.
 *
 * Exclusions and why:
 * - `state`: the engine supplies an internal in-memory accessor (it is what
 *   makes the live transcript possible). A child persisting to the parent's
 *   accessor would clobber the parent conversation; durable child sessions
 *   are a separate feature.
 * - `signal`: the engine supplies it (parent abort / timeout / cancelTask
 *   propagate into the child).
 * - `approveToolCalls`/`rejectToolCalls`: approval decisions belong to a
 *   durable session.
 *
 * `hooks` IS allowed — a child may declare its own hooks explicitly. The
 * parent's hooks are never inherited (they are written against the parent's
 * tool vocabulary and their session accounting would double-fire per child).
 */
export type AgentRunSpec<TChildTools extends readonly Tool[] = readonly Tool[]> = Omit<
  CallModelInput<TChildTools>,
  'state' | 'approveToolCalls' | 'rejectToolCalls' | 'signal'
>;

const TEXT_PREVIEW_CHARS = 200;
const ARGS_PREVIEW_CHARS = 80;

function preview(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Live transcript over an agent child's conversation, rendered from the
 * child's (internal, in-memory) conversation state — the actual message
 * history, robust regardless of streaming vs non-streaming transport.
 */
export class AgentTranscriptSource implements TaskTranscriptSource {
  private turnsStarted = 0;
  private turnsEnded = 0;
  private currentActivity = 'starting';

  constructor(private readonly readState: () => ConversationState | null) {}

  noteTurnStart(): void {
    this.turnsStarted++;
    this.currentActivity = `turn ${this.turnsStarted} in progress`;
  }

  noteTurnEnd(lastText: string): void {
    this.turnsEnded++;
    this.currentActivity = lastText ? `responded: ${preview(lastText, 80)}` : 'thinking';
  }

  setActivity(activity: string): void {
    this.currentActivity = activity;
  }

  statusExtras(): Record<string, unknown> {
    return {
      // Ended turns only — an in-flight turn shows up in turnsStarted and
      // currentActivity, but is not counted as completed.
      turnsCompleted: this.turnsEnded,
      turnsStarted: this.turnsStarted,
      currentActivity: this.currentActivity,
    };
  }

  render(maxChars: number): string {
    const state = this.readState();
    if (!state || !Array.isArray(state.messages)) {
      return '';
    }
    const lines: string[] = [];
    for (const item of state.messages as Array<Record<string, unknown>>) {
      const type = item['type'];
      const role = item['role'];
      if (role === 'user' && typeof item['content'] === 'string') {
        lines.push(`user: ${preview(item['content'], TEXT_PREVIEW_CHARS)}`);
      } else if (type === 'message' && role === 'assistant') {
        const content = item['content'];
        const text = Array.isArray(content)
          ? content
              .map(
                (c) =>
                  (
                    c as {
                      text?: string;
                    }
                  ).text ?? '',
              )
              .join('')
              .trim()
          : '';
        if (text) {
          lines.push(`assistant: ${preview(text, TEXT_PREVIEW_CHARS)}`);
        }
      } else if (type === 'function_call') {
        lines.push(`→ ${String(item['name'])}(${preview(item['arguments'], ARGS_PREVIEW_CHARS)})`);
      } else if (type === 'function_call_output') {
        lines.push(`  ⇒ ${preview(item['output'], ARGS_PREVIEW_CHARS)}`);
      }
    }
    const full = lines.join('\n');
    return truncateTranscriptTail(full, maxChars);
  }
}

/** Configuration for `tool.agent()`. */
export type AgentToolConfig<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TChildTools extends readonly Tool[] = readonly Tool[],
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
> = {
  name: TName;
  description?: string;
  inputSchema: TInput;
  /**
   * Required. The mapped child result is validated against it — the same
   * rule every long-running tool obeys (results settle after the round).
   */
  outputSchema: TOutput;
  /** Build the child run spec from this call's arguments. */
  agent: (
    params: zodInfer<TInput>,
    context?: ToolExecuteContext<TName, ContextFromSchema<TCtx>>,
  ) => AgentRunSpec<TChildTools> | Promise<AgentRunSpec<TChildTools>>;
  /**
   * Map the finished child run to this tool's output. Default:
   * `{ text: await child.getText() }` — so the natural outputSchema is
   * `z.object({ text: z.string() })`.
   */
  result?: (child: ModelResult<TChildTools>) => Promise<zodInfer<TOutput>> | zodInfer<TOutput>;
  /** Hold the round this long before placeholdering. Default 250ms. */
  graceMs?: number;
  /** Deadline for the whole child run, in ms. */
  timeoutMs?: number;
  /** Max simultaneous child runs of this tool. */
  maxConcurrency?: number;
  /** Model-facing acknowledgement merged into the pending placeholder. */
  ack?: AsyncToolAck<zodInfer<TInput>>;
  /** Check-in config (the SDK default reports turns + activity). */
  check?: ToolCheckConfig;
  contextSchema?: TCtx;
  nextTurnParams?: NextTurnParamsFunctions<zodInfer<TInput>>;
  requireApproval?: boolean | ToolApprovalCheck<zodInfer<TInput>>;
  loopKey?: ToolLoopKey<zodInfer<TInput>>;
};

/** Paused child statuses that an in-memory agent child cannot recover from. */
const CHILD_PAUSE_STATUSES = new Set([
  'awaiting_approval',
  'awaiting_hitl',
  'awaiting_client_tools',
  'awaiting_async_tools',
]);

/**
 * Create an agent tool: a long-running tool whose work IS a child
 * `callModel` conversation. The child runs as a background task — the
 * parent loop keeps going, its per-turn activity feeds the task log (one
 * entry per child turn), its conversation is the check-in transcript, and
 * its final answer (via the `result` mapper) is delivered like any
 * background result. Steering messages (`sendToTask`, or a check call's
 * `task.send`) are injected into the child as user messages at its next
 * turn boundary. `cancelTask` / parent abort cancel the child run.
 */
export function agentToolBuilder<
  TInput extends $ZodObject<$ZodShape>,
  TOutput extends $ZodType,
  TChildTools extends readonly Tool[] = readonly Tool[],
  TCtx extends $ZodObject<$ZodShape> = $ZodObject<$ZodShape>,
  TName extends string = string,
>(
  config: AgentToolConfig<TInput, TOutput, TChildTools, TCtx, TName>,
): UnifiedTool<TInput, TOutput, $ZodType<unknown>, Record<string, unknown>, TCtx> {
  // Same reserved-name guards as tool() — a subagent named 'shared' would
  // collide with the shared-context store key, one named 'task' would
  // disable the built-in task-interaction tool.
  if (config.name === SHARED_CONTEXT_KEY) {
    throw new Error(
      `Tool name "${SHARED_CONTEXT_KEY}" is reserved for shared context. Choose a different name.`,
    );
  }
  if (config.name === TASK_TOOL_NAME) {
    throw new Error(
      `Tool name "${TASK_TOOL_NAME}" is reserved for the built-in task-interaction tool. Choose a different name.`,
    );
  }

  if (config.outputSchema === undefined) {
    throw new Error(
      `Agent tool "${config.name}" must declare an outputSchema. The child's mapped result is validated when it settles.`,
    );
  }

  const defaultResult = async (child: ModelResult<TChildTools>) => ({
    text: await child.getText(),
  });
  const mapResult = config.result ?? (defaultResult as NonNullable<typeof config.result>);

  // The synthesized run: a plain async fn driving the child to completion.
  // Turn activity surfaces through ctx.log (task log + preliminary events);
  // the transcript reads the child's live in-memory conversation state.
  async function run(
    params: zodInfer<TInput>,
    ctx?: ToolExecuteContext<TName, ContextFromSchema<TCtx>> & {
      client?: OpenRouterCore;
      log?: (entry: unknown) => void;
      onMessage?: (handler: (message: unknown) => void) => void;
      taskTranscript?: {
        transcriptSource?: TaskTranscriptSource;
      };
    },
  ): Promise<zodInfer<TOutput>> {
    const client = ctx?.client;
    if (!client) {
      throw new Error(
        `Agent tool "${config.name}": no client available on the run context. Agent tools must execute inside a callModel run.`,
      );
    }

    const spec = await config.agent(params, ctx);

    // Internal in-memory accessor: the child's message history IS the
    // transcript, and getState() enables the pause-detection below. Never
    // the caller's accessor — a child persisting there would clobber the
    // parent conversation.
    let childState: ConversationState | null = null;
    const childAccessor: StateAccessor = {
      load: async () => childState,
      save: async (state) => {
        childState = state;
      },
    };

    const transcript = new AgentTranscriptSource(() => childState);
    if (ctx?.taskTranscript) {
      ctx.taskTranscript.transcriptSource = transcript;
    }

    // Lazy import: agent-tool → call-model → model-result would otherwise
    // be a static cycle (same pattern as bindDeferredCompletion).
    const { callModel } = await import('../inner-loop/call-model.js');

    const userOnTurnStart = spec.onTurnStart;
    const userOnTurnEnd = spec.onTurnEnd;

    const child = callModel(client, {
      ...spec,
      state: childAccessor,
      ...(ctx?.signal !== undefined && {
        signal: ctx.signal,
      }),
      onTurnStart: async (turnContext) => {
        transcript.noteTurnStart();
        await userOnTurnStart?.(turnContext);
      },
      onTurnEnd: async (turnContext, response) => {
        const text = extractTextFromResponse(response);
        transcript.noteTurnEnd(text);
        // One log entry per child turn — feeds tailLogs and preliminary
        // results on the parent stream.
        ctx?.log?.({
          turn: turnContext.numberOfTurns,
          textPreview: preview(text.trim(), TEXT_PREVIEW_CHARS),
        });
        await userOnTurnEnd?.(turnContext, response);
      },
    } as CallModelInput<TChildTools> & {
      state: StateAccessor<TChildTools>;
    }) as ModelResult<TChildTools>;

    // Steering: forward inbound task messages into the child conversation
    // as user messages at its next safe turn boundary.
    ctx?.onMessage?.((message) => {
      child.queueUserMessage(typeof message === 'string' ? message : JSON.stringify(message));
    });

    // Drive the child to completion.
    await child.getResponse();
    transcript.setActivity('finished');

    // In-memory children cannot pause durably: a paused child means a tool
    // inside it awaits input that will never arrive. Fail loudly instead of
    // silently returning a partial answer.
    const finalStatus = childState !== null ? (childState as ConversationState).status : undefined;
    if (finalStatus !== undefined && CHILD_PAUSE_STATUSES.has(finalStatus)) {
      throw new Error(
        `Agent tool "${config.name}": the child run paused with status '${finalStatus}'. Agent children run in-memory and cannot pause — avoid HITL/manual/deferred/approval tools inside agents (use lifecycle: 'deferred' on the parent tool instead).`,
      );
    }

    return await mapResult(child);
  }

  const fn: Record<string, unknown> = {
    lifecycle: 'background',
    kind: 'agent',
    name: config.name,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    run,
  };
  const optionalFields = [
    'description',
    'contextSchema',
    'nextTurnParams',
    'requireApproval',
    'loopKey',
    'timeoutMs',
    'maxConcurrency',
    'ack',
    'graceMs',
    'check',
  ] as const;
  for (const field of optionalFields) {
    if (config[field] !== undefined) {
      fn[field] = config[field];
    }
  }

  return {
    type: ToolType.Function,
    function: fn as unknown as UnifiedTool<
      TInput,
      TOutput,
      $ZodType<unknown>,
      Record<string, unknown>,
      TCtx
    >['function'],
  };
}

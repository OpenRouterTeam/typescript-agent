import type {
  ConversationState,
  InferToolEvent,
  InferToolOutput,
  Tool,
  ToolPreliminaryResultEvent,
  ToolResultEvent,
} from '@openrouter/agent';

export type ActivationInput<TShared extends Record<string, unknown> = Record<string, unknown>> = {
  state?: ConversationState;
  context?: TShared;
};

export type ActivationPredicate<TShared extends Record<string, unknown> = Record<string, unknown>> =
  (input: ActivationInput<TShared>) => boolean;

type ToolName<T> = T extends {
  function: {
    name: infer N extends string;
  };
}
  ? N
  : never;

/** Maps a tool array to a record keyed by each tool's literal name. */
export type InferToolSet<T extends readonly Tool[]> = {
  [K in T[number] as ToolName<K>]: K;
};

/**
 * Active tool partition. Without threading the activation configuration
 * through the type system, this equals the full set. Exposed for API parity
 * with the source library; runtime truth comes from `inferTools().activeTools`.
 */
export type InferActiveTools<T extends readonly Tool[]> = InferToolSet<T>;

/** Inactive tool partition; see `InferActiveTools` for the caveat. */
export type InferInactiveTools<T extends readonly Tool[]> = InferToolSet<T>;

/**
 * SDK-native analog of the source library's UI-message-part helper.
 * Produces a discriminated union of streaming events keyed by tool name.
 */
export type InferUIToolSet<T extends readonly Tool[]> = {
  [K in T[number] as ToolName<K>]:
    | (ToolPreliminaryResultEvent<InferToolEvent<K>> & {
        toolName: ToolName<K>;
      })
    | (ToolResultEvent<InferToolOutput<K>, InferToolEvent<K>> & {
        toolName: ToolName<K>;
      });
}[ToolName<T[number]>];

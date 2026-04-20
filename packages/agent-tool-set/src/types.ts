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

/**
 * Discriminated union of streaming events keyed by tool name. The SDK-native
 * analog of the original library's UI-message-part helper.
 */
export type InferToolSet<T extends readonly Tool[]> = {
  [K in T[number] as ToolName<K>]:
    | (ToolPreliminaryResultEvent<InferToolEvent<K>> & {
        toolName: ToolName<K>;
      })
    | (ToolResultEvent<InferToolOutput<K>, InferToolEvent<K>> & {
        toolName: ToolName<K>;
      });
}[ToolName<T[number]>];

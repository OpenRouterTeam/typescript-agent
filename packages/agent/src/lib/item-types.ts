import type {
  EasyInputMessage,
  ErrorEvent,
  FunctionCallOutputItem,
  OutputFileSearchCallItem,
  OutputFunctionCallItem,
  OutputImageGenerationCallItem,
  OutputMessage,
  OutputReasoningItem,
  OutputWebSearchCallItem,
} from '@openrouter/sdk/models';
import type { ToolPreliminaryResultEvent } from './tool-types.js';

/**
 * Adds a required `id` field to a type, representing an item that has been
 * persisted in conversation history (as opposed to newly created input).
 * This is a local convention — the SDK's `EasyInputMessage` has no `id` field.
 */
type WithID<T> = T & {
  id: string;
};

/** A function call initiated by the model */
export type CallFunctionToolItem = OutputFunctionCallItem;

/** An assistant message in the response output */
export type AssistantMessageItem = OutputMessage;

/** A new user message for input (not yet persisted, no id) */
export type NewUserMessageItem = EasyInputMessage & {
  role: 'user';
};

/** A user message from conversation history (has an assigned id) */
export type UserMessageItem = WithID<EasyInputMessage> & {
  role: 'user';
};

/** A system message from conversation history (has an assigned id) */
export type SystemMessageItem = WithID<EasyInputMessage> & {
  role: 'system';
};

/** A new system message for input (not yet persisted, no id) */
export type NewSystemMessageItem = EasyInputMessage & {
  role: 'system';
};

/**
 * A new assistant message for input (not yet persisted, no id).
 *
 * Distinct from `AssistantMessageItem` (= `OutputMessage`), which is what the
 * model produces and therefore requires an `id` and structured content. This
 * member exists so caller-supplied conversation history — e.g. the output of
 * `fromChatMessages` / `fromClaudeMessages` — is assignable to `Item[]`.
 */
export type NewAssistantMessageItem = EasyInputMessage & {
  role: 'assistant';
};

/** A developer message from conversation history (has an assigned id) */
export type DeveloperMessageItem = WithID<EasyInputMessage> & {
  role: 'developer';
};

/** A manually added developer message (has no id) */
export type NewDeveloperMessageItem = EasyInputMessage & {
  role: 'developer';
};

/** Reasoning output from the model */
export type ReasoningItem = OutputReasoningItem;

/** A file search call in the response output */
export type CallFileSearchItem = OutputFileSearchCallItem;

/**
 * The output from a function call execution.
 * `FunctionCallOutputItem` already declares `id?: string | null | undefined`,
 * so no `WithID` wrapper is needed.
 */
export type FunctionResultItem = FunctionCallOutputItem;

/**
 * A preliminary result event emitted during tool execution.
 * `ToolPreliminaryResultEvent` uses `toolCallId` (not `id`) for identification.
 */
export type FunctionProgressItem = ToolPreliminaryResultEvent;

/** A web search call in the response output */
export type CallWebSearchItem = OutputWebSearchCallItem;

/** An image generation call in the response output */
export type CallImageGenerationItem = OutputImageGenerationCallItem;

/**
 * A streaming error event.
 * `ErrorEvent` has no `id` field; it uses `code`, `message`, `param`, and `sequenceNumber`.
 */
export type ErrorItem = ErrorEvent;

/**
 * Union of all item types used by this package.
 *
 * This is not exhaustive over every possible SDK output item type —
 * server tool items (e.g. `OutputDatetimeItem`, `OutputServerToolItem`)
 * are not included. Extend this union if you need to handle those.
 */
export type Item =
  | AssistantMessageItem
  | UserMessageItem
  | SystemMessageItem
  | DeveloperMessageItem
  | NewDeveloperMessageItem
  | NewUserMessageItem
  | NewSystemMessageItem
  | NewAssistantMessageItem
  | CallFunctionToolItem
  | ReasoningItem
  | CallFileSearchItem
  | FunctionResultItem
  | FunctionProgressItem
  | CallWebSearchItem
  | CallImageGenerationItem
  | ErrorItem;

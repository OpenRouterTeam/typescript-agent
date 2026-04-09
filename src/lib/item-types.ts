import type {
  EasyInputMessage,
  ErrorEvent,
  FunctionCallItem,
  FunctionCallOutputItem,
  OutputFileSearchCallItem,
  OutputImageGenerationCallItem,
  OutputMessage,
  OutputReasoningItem,
  OutputWebSearchCallItem,
} from '@openrouter/sdk/models';
import type { ToolPreliminaryResultEvent } from './tool-types.js';

type WithID<T> = T & { id: string };

/** A function call initiated by the model */
export type CallFunctionToolItem = FunctionCallItem;

/** An assistant message in the response output */
export type AssistantMessageItem = OutputMessage;

/** A new user message (input, no id) */
export type NewUserMessageItem = EasyInputMessage & { role: 'user' };

/** A user message with an id (from conversation history) */
export type UserMessageItem = WithID<EasyInputMessage> & { role: 'user' };

/** A system message with an id */
export type SystemMessageItem = WithID<EasyInputMessage> & { role: 'system' };

/** A developer message with an id */
export type DeveloperMessageItem = WithID<EasyInputMessage> & { role: 'developer' };

/** Reasoning output from the model */
export type ReasoningItem = OutputReasoningItem;

/** A file search call in the response output */
export type CallFileSearchItem = OutputFileSearchCallItem;

/** The output from a function call execution */
export type FunctionResultItem = WithID<FunctionCallOutputItem>;

/** A preliminary result event emitted during tool execution */
export type FunctionProgressItem = WithID<ToolPreliminaryResultEvent>;

/** A web search call in the response output */
export type CallWebSearchItem = OutputWebSearchCallItem;

/** An image generation call in the response output */
export type CallImageGenerationItem = OutputImageGenerationCallItem;

/** A streaming error event */
export type ErrorItem = WithID<ErrorEvent>;

/** Union of all item types */
export type Item =
  | AssistantMessageItem
  | UserMessageItem
  | SystemMessageItem
  | DeveloperMessageItem
  | NewUserMessageItem
  | CallFunctionToolItem
  | ReasoningItem
  | CallFileSearchItem
  | FunctionResultItem
  | FunctionProgressItem
  | CallWebSearchItem
  | CallImageGenerationItem
  | ErrorItem;

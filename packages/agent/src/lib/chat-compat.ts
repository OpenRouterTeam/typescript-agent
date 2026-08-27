import type * as models from '@openrouter/sdk/models';

import {
  EasyInputMessageRoleAssistant,
  EasyInputMessageRoleDeveloper,
  EasyInputMessageRoleSystem,
  EasyInputMessageRoleUser,
} from '@openrouter/sdk/models/easyinputmessage';
import type {
  NewAssistantMessageItem,
  NewDeveloperMessageItem,
  NewSystemMessageItem,
  NewUserMessageItem,
} from './item-types.js';
import { extractMessageFromResponse } from './stream-transformers.js';

/** An OpenResponses input item emitted by {@link fromChatMessages}. */
export type ChatMessageInputItem =
  | NewUserMessageItem
  | NewSystemMessageItem
  | NewAssistantMessageItem
  | NewDeveloperMessageItem
  | models.FunctionCallOutputItem
  | models.OutputFunctionCallItem;

/**
 * Type guard for ChatToolMessage
 */
function isToolResponseMessage(msg: models.ChatMessages): msg is models.ChatToolMessage {
  return msg.role === 'tool';
}

/**
 * Type guard for ChatAssistantMessage
 */
function isAssistantMessage(msg: models.ChatMessages): msg is models.ChatAssistantMessage {
  return msg.role === 'assistant';
}

/**
 * Builds a new (id-less) message item with its `role` narrowed to a single
 * literal, so the result is assignable to a concrete member of the `Item`
 * union. Mapping to the wide `EasyInputMessageRoleUnion` is not enough:
 * TypeScript will not distribute a union-typed `role` across the per-role
 * members of `Item`.
 */
function createMessageItem(
  role: 'user' | 'system' | 'assistant' | 'developer',
  content: string,
): NewUserMessageItem | NewSystemMessageItem | NewAssistantMessageItem | NewDeveloperMessageItem {
  switch (role) {
    case 'user':
      return {
        role: EasyInputMessageRoleUser.User,
        content,
      };
    case 'system':
      return {
        role: EasyInputMessageRoleSystem.System,
        content,
      };
    case 'assistant':
      return {
        role: EasyInputMessageRoleAssistant.Assistant,
        content,
      };
    case 'developer':
      return {
        role: EasyInputMessageRoleDeveloper.Developer,
        content,
      };
    default: {
      const exhaustiveCheck: never = role;
      throw new Error(`Unhandled role type: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Convert message content to a string representation.
 * Handles string, null, undefined, and object content types.
 */
function contentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === null || content === undefined) {
    return '';
  }
  return JSON.stringify(content);
}

/**
 * Convert OpenAI chat-style messages to OpenResponses input format.
 *
 * This function transforms Message[] (OpenAI chat format) to OpenResponsesInput
 * format that can be passed directly to callModel().
 *
 * @example
 * ```typescript
 * import { fromChatMessages } from '@openrouter/sdk';
 *
 * const chatMessages = [
 *   { role: "system", content: "You are a helpful assistant." },
 *   { role: "user", content: "Hello!" },
 * ];
 *
 * const response = openrouter.callModel({
 *   model: "openai/gpt-4",
 *   input: fromChatMessages(chatMessages),
 * });
 * ```
 */
export function fromChatMessages(messages: models.ChatMessages[]): ChatMessageInputItem[] {
  const result: ChatMessageInputItem[] = [];

  for (const msg of messages) {
    if (isToolResponseMessage(msg)) {
      result.push({
        type: 'function_call_output' as const,
        callId: msg.toolCallId,
        output: contentToString(msg.content),
      });
      continue;
    }

    if (isAssistantMessage(msg)) {
      const content = contentToString(msg.content);
      const toolCalls = msg.toolCalls ?? [];

      // Skip the message item only when there is no content AND we have tool
      // calls to emit in its place. A content-less assistant message with no
      // tool calls still round-trips as an empty message (pre-existing
      // behavior) rather than disappearing entirely.
      if (content.length > 0 || toolCalls.length === 0) {
        result.push(createMessageItem('assistant', content));
      }

      // One function_call item per tool call. `tc.function.arguments` is
      // already a JSON string in the chat format, so it is forwarded as-is
      // (unlike the Claude path, which stringifies a structured `input`).
      for (const tc of toolCalls) {
        result.push({
          type: 'function_call' as const,
          callId: tc.id,
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: 'completed' as const,
        });
      }

      continue;
    }

    // System, user, developer messages
    result.push(createMessageItem(msg.role, contentToString(msg.content)));
  }

  return result;
}

/**
 * Convert an OpenResponses response to OpenAI chat message format.
 *
 * This function transforms OpenResponsesResult to ChatAssistantMessage
 * (OpenAI chat format) for compatibility with code expecting chat responses.
 *
 * @example
 * ```typescript
 * import { toChatMessage } from '@openrouter/sdk';
 *
 * const response = await openrouter.callModel({
 *   model: "openai/gpt-4",
 *   input: "Hello!",
 * });
 *
 * const openResponsesResult = await response.getResponse();
 * const chatMessage = toChatMessage(openResponsesResult);
 * // chatMessage is now { role: "assistant", content: "..." }
 * ```
 */
export const toChatMessage = extractMessageFromResponse;

import type * as models from '@openrouter/sdk/models';

import {
  EasyInputMessageRoleAssistant,
  EasyInputMessageRoleDeveloper,
  EasyInputMessageRoleSystem,
  EasyInputMessageRoleUser,
} from '@openrouter/sdk/models/easyinputmessage';
import { extractMessageFromResponse } from './stream-transformers.js';

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
 * Maps chat role strings to OpenResponses role types
 */
function mapChatRole(
  role: 'user' | 'system' | 'assistant' | 'developer',
): models.EasyInputMessageRoleUnion {
  switch (role) {
    case 'user':
      return EasyInputMessageRoleUser.User;
    case 'system':
      return EasyInputMessageRoleSystem.System;
    case 'assistant':
      return EasyInputMessageRoleAssistant.Assistant;
    case 'developer':
      return EasyInputMessageRoleDeveloper.Developer;
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
export function fromChatMessages(messages: models.ChatMessages[]): models.InputsUnion {
  const result: (
    | models.EasyInputMessage
    | models.FunctionCallOutputItem
    | models.OutputFunctionCallItem
  )[] = [];

  for (const msg of messages) {
    if (isToolResponseMessage(msg)) {
      result.push({
        type: 'function_call_output' as const,
        callId:
          msg.toolCallId ??
          (
            msg as {
              tool_call_id?: string;
            }
          ).tool_call_id ??
          '',
        output: contentToString(msg.content),
      });
      continue;
    }

    if (isAssistantMessage(msg)) {
      const toolCalls =
        msg.toolCalls ??
        (
          msg as {
            tool_calls?: models.ChatToolCall[];
          }
        ).tool_calls;
      const content = contentToString(msg.content);

      if (content.length > 0 || !toolCalls?.length) {
        result.push({
          role: mapChatRole('assistant'),
          content,
        });
      }

      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          result.push({
            type: 'function_call' as const,
            callId: tc.id,
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
          });
        }
      }
      continue;
    }

    // System, user, developer messages
    result.push({
      role: mapChatRole(msg.role),
      content: contentToString(msg.content),
    });
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

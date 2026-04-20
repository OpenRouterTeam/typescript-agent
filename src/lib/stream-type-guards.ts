import type * as models from '@openrouter/sdk/models';

/**
 * Type guards for OpenResponses stream events
 * These enable proper TypeScript narrowing without type casts
 */

// Stream event type guards

export function isOutputTextDeltaEvent(event: models.StreamEvents): event is models.TextDeltaEvent {
  return 'type' in event && event.type === 'response.output_text.delta';
}

export function isReasoningDeltaEvent(
  event: models.StreamEvents,
): event is models.ReasoningDeltaEvent {
  return 'type' in event && event.type === 'response.reasoning_text.delta';
}

export function isFunctionCallArgumentsDeltaEvent(
  event: models.StreamEvents,
): event is models.FunctionCallArgsDeltaEvent {
  return 'type' in event && event.type === 'response.function_call_arguments.delta';
}

export function isOutputItemAddedEvent(
  event: models.StreamEvents,
): event is models.StreamEventsResponseOutputItemAdded {
  return 'type' in event && event.type === 'response.output_item.added';
}

export function isOutputItemDoneEvent(
  event: models.StreamEvents,
): event is models.StreamEventsResponseOutputItemDone {
  return 'type' in event && event.type === 'response.output_item.done';
}

export function isResponseCompletedEvent(
  event: models.StreamEvents,
): event is models.StreamEventsResponseCompleted {
  return 'type' in event && event.type === 'response.completed';
}

export function isResponseFailedEvent(
  event: models.StreamEvents,
): event is models.StreamEventsResponseFailed {
  return 'type' in event && event.type === 'response.failed';
}

export function isResponseIncompleteEvent(
  event: models.StreamEvents,
): event is models.StreamEventsResponseIncomplete {
  return 'type' in event && event.type === 'response.incomplete';
}

export function isFunctionCallArgumentsDoneEvent(
  event: models.StreamEvents,
): event is models.FunctionCallArgsDoneEvent {
  return 'type' in event && event.type === 'response.function_call_arguments.done';
}

// Output item type guards

export function isOutputMessage(item: unknown): item is models.OutputMessage {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'message';
}

export function isFunctionCallItem(item: unknown): item is models.OutputFunctionCallItem {
  return (
    typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call'
  );
}

export function isReasoningOutputItem(item: unknown): item is models.OutputReasoningItem {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'reasoning';
}

export function isWebSearchCallOutputItem(item: unknown): item is models.OutputWebSearchCallItem {
  return (
    typeof item === 'object' && item !== null && 'type' in item && item.type === 'web_search_call'
  );
}

export function isFileSearchCallOutputItem(item: unknown): item is models.OutputFileSearchCallItem {
  return (
    typeof item === 'object' && item !== null && 'type' in item && item.type === 'file_search_call'
  );
}

export function isImageGenerationCallOutputItem(
  item: unknown,
): item is models.OutputImageGenerationCallItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'image_generation_call'
  );
}

/**
 * Type guard for client function-call output items — the input-side items
 * we construct and send back to the API after executing a client tool.
 */
export function isFunctionCallOutputItem(item: unknown): item is models.FunctionCallOutputItem {
  if (typeof item !== 'object' || item === null || !('type' in item)) {
    return false;
  }
  return item.type === 'function_call_output';
}

/**
 * Type guard: narrows a response output item to the server-tool result
 * branches of the SDK's `OutputItems` union (web_search_call,
 * file_search_call, image_generation_call, or the generic
 * `OutputServerToolItem` that covers openrouter:datetime and any new
 * server-tool type added upstream without a dedicated SDK variant).
 *
 * Input is typed as `models.OutputItems` so the deny-list is sound: the
 * SDK union is finite, and excluding message/reasoning/function_call
 * leaves exactly the server-tool variants. Callers holding `unknown`
 * should use `hasTypeProperty` first to reach an `OutputItems`-shaped
 * value before invoking this guard.
 */
export function isServerToolResultItem(
  item: models.OutputItems,
): item is
  | models.OutputWebSearchCallItem
  | models.OutputFileSearchCallItem
  | models.OutputImageGenerationCallItem
  | models.OutputServerToolItem {
  return item.type !== 'message' && item.type !== 'reasoning' && item.type !== 'function_call';
}

// Content part type guards

export function isOutputTextPart(part: unknown): part is models.ResponseOutputText {
  return typeof part === 'object' && part !== null && 'type' in part && part.type === 'output_text';
}

export function isRefusalPart(part: unknown): part is models.OpenAIResponsesRefusalContent {
  return typeof part === 'object' && part !== null && 'type' in part && part.type === 'refusal';
}

// Annotation type guards for Claude conversion

export function isFileCitationAnnotation(annotation: unknown): annotation is models.FileCitation {
  return (
    typeof annotation === 'object' &&
    annotation !== null &&
    'type' in annotation &&
    annotation.type === 'file_citation'
  );
}

export function isURLCitationAnnotation(annotation: unknown): annotation is models.URLCitation {
  return (
    typeof annotation === 'object' &&
    annotation !== null &&
    'type' in annotation &&
    annotation.type === 'url_citation'
  );
}

export function isFilePathAnnotation(annotation: unknown): annotation is models.FilePath {
  return (
    typeof annotation === 'object' &&
    annotation !== null &&
    'type' in annotation &&
    annotation.type === 'file_path'
  );
}

// Helper to check if output has a type property
export function hasTypeProperty(item: unknown): item is {
  type: string;
} {
  return (
    typeof item === 'object' && item !== null && 'type' in item && typeof item.type === 'string'
  );
}

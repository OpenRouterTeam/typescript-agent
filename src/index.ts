// SDK type re-exports — every SDK type used in this package's public API
// so consumers don't need to depend on @openrouter/sdk directly.

export type { RequestOptions } from '@openrouter/sdk/lib/sdks';

export type {
  // Core request/response
  BaseInputsUnion,
  // Message & item types
  ChatAssistantMessage,
  ChatMessages,
  EasyInputMessage,
  EasyInputMessageContentInputImage,
  EasyInputMessageContentUnion1,
  EasyInputMessageRoleUnion,
  // Error event
  ErrorEvent,
  FunctionCallItem,
  FunctionCallOutputItem,
  // Content input types (multimodal)
  InputAudio,
  InputFile,
  InputImage,
  InputMessageItem,
  InputsUnion,
  InputText,
  InputVideo,
  OpenAIResponsesToolChoiceUnion,
  OpenResponsesResult,
  // Output item types (StreamableOutputItem members)
  OutputFileSearchCallItem,
  OutputFunctionCallItem,
  OutputImageGenerationCallItem,
  OutputInputImage,
  OutputMessage,
  OutputReasoningItem,
  OutputWebSearchCallItem,
  // Response output content
  ResponseOutputText,
  ResponsesRequest,
  StreamEvents,
  Usage,
} from '@openrouter/sdk/models';

// Clean item type aliases
export type {
  AssistantMessageItem,
  CallFileSearchItem,
  CallFunctionToolItem,
  CallImageGenerationItem,
  CallWebSearchItem,
  DeveloperMessageItem,
  ErrorItem,
  FunctionProgressItem,
  FunctionResultItem,
  Item,
  NewUserMessageItem,
  ReasoningItem,
  SystemMessageItem,
  UserMessageItem,
} from './lib/item-types.js';

// Message format compatibility helpers

// High-level model calling
export { callModel } from './inner-loop/call-model.js';
export { fromClaudeMessages, toClaudeMessage } from './lib/anthropic-compat.js';
export type {
  CallModelInput,
  CallModelInputWithState,
  ResolvedCallModelInput,
} from './lib/async-params.js';
export { hasAsyncFunctions, resolveAsyncFunctions } from './lib/async-params.js';
export { fromChatMessages, toChatMessage } from './lib/chat-compat.js';
// Claude constants and type guards
export { ClaudeContentBlockType, NonClaudeMessageRole } from './lib/claude-constants.js';
export { isClaudeStyleMessages } from './lib/claude-type-guards.js';
// Conversation state helpers
export {
  appendToMessages,
  createInitialState,
  createRejectedResult,
  createUnsentResult,
  generateConversationId,
  partitionToolCalls,
  toolRequiresApproval,
  updateState,
} from './lib/conversation-state.js';
export type { GetResponseOptions } from './lib/model-result.js';
export { ModelResult } from './lib/model-result.js';
// Next turn params helpers
export {
  applyNextTurnParamsToRequest,
  buildNextTurnParamsContext,
  executeNextTurnParamsFunctions,
} from './lib/next-turn-params.js';
// Stop condition helpers
export {
  finishReasonIs,
  hasToolCall,
  isStopConditionMet,
  maxCost,
  maxTokensUsed,
  stepCountIs,
} from './lib/stop-conditions.js';
export type { StreamableOutputItem } from './lib/stream-transformers.js';
export {
  extractUnsupportedContent,
  getUnsupportedContentSummary,
  hasUnsupportedContent,
} from './lib/stream-transformers.js';
// Tool creation helpers
export { tool } from './lib/tool.js';
export type { ContextInput } from './lib/tool-context.js';
// Tool context helpers
export { buildToolExecuteContext, ToolContextStore } from './lib/tool-context.js';
// Real-time tool event broadcasting
export { ToolEventBroadcaster } from './lib/tool-event-broadcaster.js';
export type {
  ChatStreamEvent,
  ConversationState,
  ConversationStatus,
  HasApprovalTools,
  InferToolEvent,
  InferToolEventsUnion,
  InferToolInput,
  InferToolOutput,
  InferToolOutputsUnion,
  ManualTool,
  NextTurnParamsContext,
  NextTurnParamsFunctions,
  ParsedToolCall,
  PartialResponse,
  ResponseStreamEvent,
  ResponseStreamEvent as EnhancedResponseStreamEvent,
  StateAccessor,
  StepResult,
  StopCondition,
  StopWhen,
  Tool,
  ToolApprovalCheck,
  ToolCallOutputEvent,
  ToolExecutionResult,
  ToolExecutionResultUnion,
  ToolHasApproval,
  ToolPreliminaryResultEvent,
  ToolResultEvent,
  ToolStreamEvent,
  ToolWithExecute,
  ToolWithGenerator,
  TurnContext,
  TurnEndEvent,
  TurnStartEvent,
  TypedToolCall,
  TypedToolCallUnion,
  UnsentToolResult,
  Warning,
} from './lib/tool-types.js';
export {
  hasApprovalRequiredTools,
  hasExecuteFunction,
  isGeneratorTool,
  isRegularExecuteTool,
  isToolCallOutputEvent,
  isToolPreliminaryResultEvent,
  isToolResultEvent,
  isTurnEndEvent,
  isTurnStartEvent,
  ToolType,
  toolHasApprovalConfigured,
} from './lib/tool-types.js';
// Turn context helpers
export { buildTurnContext, normalizeInputToArray } from './lib/turn-context.js';
export type { SDKOptions } from './openrouter.js';
export { OpenRouter } from './openrouter.js';

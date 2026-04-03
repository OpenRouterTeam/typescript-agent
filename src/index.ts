// Message format compatibility helpers

export type {
  CallModelInput,
  CallModelInputWithState,
  ResolvedCallModelInput,
} from './lib/async-params.js';
export type { GetResponseOptions } from './lib/model-result.js';
export type { StreamableOutputItem } from './lib/stream-transformers.js';
export type { ContextInput } from './lib/tool-context.js';
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

// High-level model calling
export { callModel } from './inner-loop/call-model.js';
export { fromClaudeMessages, toClaudeMessage } from './lib/anthropic-compat.js';
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
export {
  extractUnsupportedContent,
  getUnsupportedContentSummary,
  hasUnsupportedContent,
} from './lib/stream-transformers.js';
// Tool creation helpers
export { tool } from './lib/tool.js';
// Tool context helpers
export { buildToolExecuteContext, ToolContextStore } from './lib/tool-context.js';
// Real-time tool event broadcasting
export { ToolEventBroadcaster } from './lib/tool-event-broadcaster.js';
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

// Hooks system
export { HooksManager } from './lib/hooks-manager.js';
export { resolveHooks } from './lib/hooks-resolve.js';
export { matchesTool } from './lib/hooks-matchers.js';
export { HookName } from './lib/hooks-types.js';
export type {
  HookContext,
  HookHandler,
  HookEntry,
  HookReturn,
  HookRegistry,
  HookDefinition,
  AsyncOutput,
  ToolMatcher,
  EmitResult,
  InlineHookConfig,
  HooksManagerOptions,
  BuiltInHookDefinitions,
  PreToolUsePayload,
  PreToolUseResult,
  PostToolUsePayload,
  PostToolUseFailurePayload,
  StopPayload,
  StopResult,
  PermissionRequestPayload,
  PermissionRequestResult,
  UserPromptSubmitPayload,
  UserPromptSubmitResult,
  SessionStartPayload,
  SessionEndPayload,
} from './lib/hooks-types.js';
export {
  BUILT_IN_HOOKS,
  BUILT_IN_HOOK_NAMES,
  PreToolUsePayloadSchema,
  PreToolUseResultSchema,
  PostToolUsePayloadSchema,
  PostToolUseFailurePayloadSchema,
  StopPayloadSchema,
  StopResultSchema,
  PermissionRequestPayloadSchema,
  PermissionRequestResultSchema,
  UserPromptSubmitPayloadSchema,
  UserPromptSubmitResultSchema,
  SessionStartPayloadSchema,
  SessionEndPayloadSchema,
} from './lib/hooks-schemas.js';

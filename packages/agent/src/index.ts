// SDK type re-exports — every SDK type used in this package's public API
// so consumers don't need to depend on @openrouter/sdk directly.

// Hooks — interception points for requests and responses
export { SDKHooks } from '@openrouter/sdk/hooks/hooks';
export type {
  AfterErrorContext,
  AfterErrorHook,
  AfterSuccessContext,
  AfterSuccessHook,
  BeforeCreateRequestContext,
  BeforeCreateRequestHook,
  BeforeRequestContext,
  BeforeRequestHook,
  HookContext,
  SDKInitHook,
} from '@openrouter/sdk/hooks/types';
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
  OutputImage,
  OutputImage as OutputInputImage,
  OutputImageGenerationCallItem,
  OutputItems,
  OutputMessage,
  OutputReasoningItem,
  OutputWebSearchCallItem,
  // Response output content
  ResponseOutputText,
  ResponsesRequest,
  ResponsesRequestToolUnion,
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
  CONVERSATION_STATE_VERSION,
  createInitialState,
  createRejectedResult,
  createUnsentResult,
  deserializeConversationState,
  generateConversationId,
  InvalidStateError,
  partitionToolCalls,
  serializeConversationState,
  toolRequiresApproval,
  UnsupportedStateVersionError,
  updateState,
} from './lib/conversation-state.js';
// Doom-loop detection (see the `doomLoop` option on callModel)
export type {
  DoomLoopAction,
  DoomLoopCallRecord,
  DoomLoopConfig,
  DoomLoopDetectorKind,
  DoomLoopEscalationConfig,
  DoomLoopLadder,
  DoomLoopOption,
  DoomLoopSerializedState,
  DoomLoopStreak,
  DoomLoopTextOptions,
  DoomLoopVerdict,
  LoopKeyResolution,
  TextRepetitionResult,
} from './lib/doom-loop.js';
export {
  canonicalizeKeyMaterial,
  DEFAULT_DOOM_LOOP_LADDER,
  DEFAULT_MAX_ESCALATIONS,
  DoomLoopMonitor,
  detectTextRepetition,
  fingerprintKeyMaterial,
  fingerprintToolCall,
  MAX_CANONICALIZE_DEPTH,
  resolveLoopKeyMaterial,
} from './lib/doom-loop.js';
// Lifecycle hooks system (PreToolUse, PostToolUse, Stop, SessionStart, ...).
// Distinct from the SDK transport hooks re-exported above (SDKHooks,
// BeforeRequestHook, HookContext, ...), which intercept HTTP requests.
// Internals (matchesTool, resolveHooks, BUILT_IN_HOOKS, raw Zod schemas) are
// deliberately NOT exported: everything here is semver surface, and the raw
// schema objects are mutable.
export { HooksManager } from './lib/hooks-manager.js';
export type {
  AsyncOutput,
  BuiltInHookDefinitions,
  DoomLoopDetectedPayload,
  DoomLoopDetectedResult,
  EmitResult,
  HookDefinition,
  HookEntry,
  HookHandler,
  HookRegistry,
  HookReturn,
  HooksManagerOptions,
  InlineHookConfig,
  LifecycleHookContext,
  ModelCallUsage,
  PermissionRequestPayload,
  PermissionRequestResult,
  PostModelCallPayload,
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreToolUsePayload,
  PreToolUseResult,
  SessionEndPayload,
  SessionStartPayload,
  SessionUsageTotals,
  StopPayload,
  StopResult,
  ToolMatcher,
  UserPromptSubmitPayload,
  UserPromptSubmitResult,
} from './lib/hooks-types.js';
export { HookName, isAsyncOutput } from './lib/hooks-types.js';
export type { GetResponseOptions } from './lib/model-result.js';
export { DEFAULT_FINAL_RESPONSE_DIRECTIVE, ModelResult } from './lib/model-result.js';
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
export { markMcp, serverTool, tool } from './lib/tool.js';
export type { ContextInput } from './lib/tool-context.js';
// Tool context helpers
export { buildToolExecuteContext, ToolContextStore } from './lib/tool-context.js';
// Real-time tool event broadcasting
export { ToolEventBroadcaster } from './lib/tool-event-broadcaster.js';
export type {
  ChatStreamEvent,
  ClientTool,
  ConversationState,
  ConversationStatus,
  HasApprovalTools,
  HITLTool,
  HITLToolFunction,
  InferToolEvent,
  InferToolEventsUnion,
  InferToolInput,
  InferToolOutput,
  InferToolOutputsUnion,
  ManualTool,
  McpBranded,
  NextTurnParamsContext,
  NextTurnParamsFunctions,
  ParsedToolCall,
  PartialResponse,
  ResponseStreamEvent,
  ResponseStreamEvent as EnhancedResponseStreamEvent,
  ServerTool,
  ServerToolConfig,
  ServerToolResultItem,
  ServerToolType,
  StateAccessor,
  StepResult,
  StopCondition,
  StopWhen,
  ToModelOutputFunction,
  ToModelOutputResult,
  Tool,
  ToolApprovalCheck,
  ToolCallOutputEvent,
  ToolExecutionResult,
  ToolExecutionResultUnion,
  ToolHasApproval,
  ToolLoopKey,
  ToolLoopKeyFn,
  ToolOutputContentItem,
  ToolPreliminaryResultEvent,
  ToolResultEvent,
  ToolResultItem,
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
  isAutoResolvableTool,
  isClientTool,
  isGeneratorTool,
  isHITLTool,
  isManualTool,
  isMcpTool,
  isRegularExecuteTool,
  isServerTool,
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
export type { Hook, OpenRouterOptions, SDKOptions } from './openrouter.js';
export { OpenRouter } from './openrouter.js';

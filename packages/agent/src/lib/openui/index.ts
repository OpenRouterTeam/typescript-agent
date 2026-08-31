/**
 * OpenUI (generative UI) bindings for the Agent SDK.
 *
 * The API owns the heavy lifting — prompt injection, streaming OpenUI Lang
 * parsing, and library validation (see DEV-765). This module ships the thin
 * client half: the component-library model, the typed fragment builder for
 * tool-authored UI, and the `openui()` plugin helper for `callModel()`.
 */
export {
  OPENUI_LANG_DIALECT,
  OPENUI_ROOT_REF,
  serializeExpr,
  type UiExpr,
  type UiFragment,
  type UiLiteralValue,
} from './document.js';
export {
  type FragmentArg,
  type FragmentBuilder,
  type FragmentNode,
  fragment,
  type UiBuiltinOptions,
  uiBuiltin,
  uiRef,
  uiState,
} from './fragment.js';
export {
  type ComponentDefinition,
  type CreateLibraryOptions,
  componentProps,
  createLibrary,
  defineComponent,
  OPENUI_BUILTIN_COMPONENTS,
  type PropSignature,
  type UiLibrary,
} from './library.js';
export { type OpenUiPlugin, type OpenUiWireComponent, openui } from './plugin.js';
export {
  OPENUI_WIRE_EVENT,
  translateUiEvent,
  type UiDocumentEvent,
  type UiFragmentEvent,
  type UiStatementEvent,
  type UiStreamEvent,
} from './ui-stream.js';

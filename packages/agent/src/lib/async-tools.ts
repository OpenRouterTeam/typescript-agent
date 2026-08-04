/**
 * The async-tool subsystem's façade: task lifecycle, the model-facing `task`
 * tool, the registry of in-flight tasks, and the concurrency primitives that
 * bound them.
 *
 * These four modules are one feature and are always used together, so the
 * engine imports them through here rather than reaching into each. That also
 * keeps `model-result.ts` under the structural gate's fan-out ceiling
 * (`no_god_files` trips above 15 outbound edges): four direct edges for one
 * subsystem became one.
 *
 * Re-exports only — no logic. Anything needing a subset (tests, other lib
 * modules) should still import the specific module directly.
 */

export type { SettledToolTask } from './async-tool-registry.js';
export { AsyncToolRegistry } from './async-tool-registry.js';
export type { TaskToolInput } from './tool-check.js';
export {
  buildTaskToolStub,
  defaultCheckResult,
  hasTaskToolNameCollision,
  persistedTaskCheckResult,
  resolveCheckConfig,
  TASK_TOOL_NAME,
  TaskToolInputSchema,
} from './tool-check.js';
export type { Semaphore as ToolSemaphore } from './tool-concurrency.js';
export { acquireAll, Semaphore } from './tool-concurrency.js';
export type { ToolTaskMode } from './tool-task.js';
export { TASK_RESULT_BOUNDARY, ToolTask } from './tool-task.js';

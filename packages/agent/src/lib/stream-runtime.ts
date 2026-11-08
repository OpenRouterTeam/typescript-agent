/**
 * The response-stream runtime's façade: multi-consumer buffering
 * (`ReusableReadableStream`) and typed stream failures (`StreamFailedError`,
 * `StreamStalledError`).
 *
 * These modules are one feature and the engine uses them together, so
 * `model-result.ts` imports them through here rather than reaching into
 * each. That also keeps it under the structural gate's fan-out ceiling
 * (`no_god_files` trips above 15 outbound edges). Same pattern as
 * `async-tools.ts`.
 *
 * Re-exports only, no logic. Anything needing a subset (tests, other lib
 * modules) should still import the specific module directly.
 */

export type { StreamReplay } from './reusable-stream.js';
export { ReusableReadableStream } from './reusable-stream.js';
export { StreamFailedError } from './stream-errors.js';

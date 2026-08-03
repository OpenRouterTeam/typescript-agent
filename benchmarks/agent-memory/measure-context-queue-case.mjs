import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run context queue cases with --expose-gc.');
}

const variant = process.argv[2];
const updateCount = Number.parseInt(process.argv[3] ?? '', 10);
if (variant !== 'array-shift' && variant !== 'head-index') {
  throw new Error('Unexpected context queue variant.');
}
if (!Number.isSafeInteger(updateCount) || updateCount < 1) {
  throw new Error('Update count must be a positive integer.');
}

const memory = () => {
  const value = process.memoryUsage();
  return value.heapUsed + value.external;
};
const settle = async () => {
  globalThis.gc();
  await yieldToEventLoop();
  globalThis.gc();
  await yieldToEventLoop();
};

await settle();
const baseline = memory();
const queue = Array.from(
  {
    length: updateCount,
  },
  (_, update) => ({
    tool: {
      update,
    },
  }),
);
const peak = memory();
let checksum = 0;
const startedAt = performance.now();
if (variant === 'array-shift') {
  while (queue.length > 0) {
    checksum += queue.shift().tool.update;
  }
} else {
  let queueHead = 0;
  while (queueHead < queue.length) {
    checksum += queue[queueHead++].tool.update;
  }
  queue.length = 0;
}
const durationMs = performance.now() - startedAt;
await settle();
const retained = memory();
const expectedChecksum = ((updateCount - 1) * updateCount) / 2;
if (checksum !== expectedChecksum) {
  throw new Error(`Unexpected checksum: ${checksum}`);
}

console.log(
  JSON.stringify({
    variant,
    eventCount: updateCount,
    durationMs,
    peakDeltaBytes: peak - baseline,
    retainedDeltaBytes: retained - baseline,
  }),
);

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run journal cases with --expose-gc.');
}

const variant = process.argv[2];
const eventCount = Number.parseInt(process.argv[3] ?? '', 10);
if (variant !== 'legacy-double' && variant !== 'single-journal') {
  throw new Error('Variant must be "legacy-double" or "single-journal".');
}
if (!Number.isSafeInteger(eventCount) || eventCount < 1) {
  throw new Error('Event count must be a positive integer.');
}

const [{ ReusableReadableStream }, { ToolEventBroadcaster }] = await Promise.all([
  import('../../packages/agent/esm/lib/reusable-stream.js'),
  import('../../packages/agent/esm/lib/tool-event-broadcaster.js'),
]);
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
let peak = baseline;
let sourceIndex = 0;
const source = new ReadableStream({
  async pull(controller) {
    if (sourceIndex === eventCount) {
      controller.close();
      return;
    }
    const prefix = `${sourceIndex}:`;
    controller.enqueue({
      index: sourceIndex,
      payload: `${prefix}${'x'.repeat(Math.max(0, 64 - prefix.length))}`,
    });
    sourceIndex += 1;
    if (sourceIndex % 256 === 0) {
      await yieldToEventLoop();
      peak = Math.max(peak, memory());
    }
  },
});
const broadcaster = new ToolEventBroadcaster();
const outputConsumer = broadcaster.createConsumer();
let received = 0;
const consumeOutput = async () => {
  for await (const _event of outputConsumer) {
    received += 1;
  }
};
const outputConsumption = consumeOutput();

let replay;
if (variant === 'legacy-double') {
  replay = new ReusableReadableStream(source);
  for await (const event of replay.createConsumer()) {
    broadcaster.push(event);
  }
} else {
  const reader = source.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      broadcaster.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}
peak = Math.max(peak, memory());
broadcaster.complete();
await outputConsumption;
await settle();
const retained = memory();

if (received !== eventCount) {
  throw new Error(`Expected ${eventCount} events, received ${received}.`);
}
if (variant === 'legacy-double' && !replay?.isComplete) {
  throw new Error('Legacy replay did not complete.');
}

console.log(
  JSON.stringify({
    variant,
    eventCount,
    peakDeltaBytes: peak - baseline,
    retainedDeltaBytes: retained - baseline,
  }),
);

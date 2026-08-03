import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run reusable stream cases with --expose-gc.');
}

const retention = process.argv[2];
const eventCount = Number.parseInt(process.argv[3] ?? '', 10);
if (retention !== 'full' && retention !== 'active-consumers') {
  throw new Error('Retention must be "full" or "active-consumers".');
}
if (!Number.isSafeInteger(eventCount) || eventCount < 1) {
  throw new Error('Event count must be a positive integer.');
}

const { ReusableReadableStream } = await import('../../packages/agent/esm/lib/reusable-stream.js');
const sample = () => {
  const memory = process.memoryUsage();
  return memory.heapUsed + memory.external;
};
const settle = async () => {
  globalThis.gc();
  await yieldToEventLoop();
  globalThis.gc();
  await yieldToEventLoop();
};

await settle();
const baseline = sample();
let peak = baseline;
let index = 0;
const source = new ReadableStream({
  async pull(controller) {
    if (index === eventCount) {
      controller.close();
      return;
    }
    const prefix = `${index}:`;
    controller.enqueue({
      index,
      payload: `${prefix}${'x'.repeat(Math.max(0, 64 - prefix.length))}`,
    });
    index += 1;
    if (index % 256 === 0) {
      await yieldToEventLoop();
      peak = Math.max(peak, sample());
    }
  },
});
const stream = new ReusableReadableStream(source, retention);
let received = 0;
for await (const _event of stream.createConsumer()) {
  received += 1;
}
peak = Math.max(peak, sample());
await settle();
const retained = sample();

if (received !== eventCount) {
  throw new Error(`Expected ${eventCount} events, received ${received}.`);
}

console.log(
  JSON.stringify({
    retention,
    eventCount,
    peakDeltaBytes: peak - baseline,
    retainedDeltaBytes: retained - baseline,
  }),
);

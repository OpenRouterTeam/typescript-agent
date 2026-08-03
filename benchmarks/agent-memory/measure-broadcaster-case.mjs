import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run broadcaster cases with --expose-gc.');
}

const retention = process.argv[2];
const eventCount = Number.parseInt(process.argv[3] ?? '', 10);
if (retention !== 'full' && retention !== 'active-consumers') {
  throw new Error('Retention must be "full" or "active-consumers".');
}
if (!Number.isSafeInteger(eventCount) || eventCount < 1) {
  throw new Error('Event count must be a positive integer.');
}

const { ToolEventBroadcaster } = await import(
  '../../packages/agent/esm/lib/tool-event-broadcaster.js'
);
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
const broadcaster = new ToolEventBroadcaster(retention);
const consumer = broadcaster.createConsumer();
let received = 0;
const consume = async () => {
  for await (const _event of consumer) {
    received += 1;
  }
};
const consumption = consume();

for (let index = 0; index < eventCount; index += 1) {
  const prefix = `${index}:`;
  broadcaster.push({
    index,
    payload: `${prefix}${'x'.repeat(Math.max(0, 64 - prefix.length))}`,
  });
  if (index % 256 === 0) {
    await yieldToEventLoop();
    peak = Math.max(peak, sample());
  }
}
broadcaster.complete();
await consumption;
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

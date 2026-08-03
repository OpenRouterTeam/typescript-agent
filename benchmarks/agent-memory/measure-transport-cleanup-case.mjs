import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run transport cleanup cases with --expose-gc.');
}

const variant = process.argv[2];
if (variant !== 'legacy-retained' && variant !== 'transport-released') {
  throw new Error('Unexpected transport cleanup variant.');
}

const { ReusableReadableStream } = await import('../../packages/agent/esm/lib/reusable-stream.js');
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
const createSource = () => {
  const transportState = new Uint8Array(16 * 1024 * 1024);
  transportState.fill(7);
  let sent = false;
  const source = new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.close();
      } else {
        sent = true;
        controller.enqueue('event');
      }
    },
  });
  Object.assign(source, {
    transportState,
  });
  return source;
};

class LegacyReplay {
  buffer = [];

  constructor(sourceStream) {
    this.sourceStream = sourceStream;
  }

  async consume() {
    const reader = this.sourceStream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
        this.buffer.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

const createLegacy = async () => {
  const replay = new LegacyReplay(createSource());
  await replay.consume();
  return replay;
};
const createReleased = async () => {
  const replay = new ReusableReadableStream(createSource());
  for await (const _event of replay.createConsumer()) {
    // Drain the source.
  }
  return replay;
};

await settle();
const baseline = memory();
const held = variant === 'legacy-retained' ? await createLegacy() : await createReleased();
const peak = memory();
await settle();
const retained = memory();

if (held.buffer?.[0] !== 'event') {
  throw new Error('Replay did not retain the event.');
}

console.log(
  JSON.stringify({
    variant,
    eventCount: 1,
    peakDeltaBytes: peak - baseline,
    retainedDeltaBytes: retained - baseline,
  }),
);

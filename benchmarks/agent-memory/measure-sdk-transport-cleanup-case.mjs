import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run SDK transport cleanup cases with --expose-gc.');
}

const variant = process.argv[2];
const eventCount = Number.parseInt(process.argv[3] ?? '', 10);
if (variant !== 'legacy-sdk-stream' && variant !== 'released-sdk-stream') {
  throw new Error('Unexpected SDK transport cleanup variant.');
}
if (!Number.isSafeInteger(eventCount) || eventCount < 1) {
  throw new Error('Event count must be a positive integer.');
}

const [{ ReusableReadableStream }, { EventStream }, { ResponsesStreamingResponse$inboundSchema }] =
  await Promise.all([
    import('../../packages/agent/esm/lib/reusable-stream.js'),
    import('../../packages/agent/node_modules/@openrouter/sdk/esm/lib/event-streams.js'),
    import(
      '../../packages/agent/node_modules/@openrouter/sdk/esm/models/responsesstreamingresponse.js'
    ),
  ]);
const memory = () => {
  const value = process.memoryUsage();
  return value.heapUsed + value.external;
};
const settle = async () => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    globalThis.gc();
    await yieldToEventLoop();
  }
};
const encoder = new TextEncoder();
const createSdkEventStream = () => {
  let index = 0;
  const source = new ReadableStream({
    async pull(controller) {
      if (index === eventCount) {
        controller.close();
        return;
      }
      const prefix = `${index}:`;
      const delta = `${prefix}${'x'.repeat(Math.max(0, 64 - prefix.length))}`;
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            sequence_number: index,
            item_id: 'message_1',
            output_index: 0,
            content_index: 0,
            delta,
            logprobs: [],
          })}\n\n`,
        ),
      );
      index += 1;
      if (index % 256 === 0) {
        await yieldToEventLoop();
      }
    },
  });
  return new EventStream(source, (message) => {
    if (message.data === '[DONE]') {
      return {
        done: true,
        value: undefined,
      };
    }
    return {
      done: false,
      value: ResponsesStreamingResponse$inboundSchema.parse(message).data,
    };
  });
};

class LegacyReplay {
  buffer = [];

  constructor(sourceStream) {
    this.sourceStream = sourceStream;
    this.sourceReader = null;
  }

  async consume() {
    this.sourceReader = this.sourceStream.getReader();
    try {
      while (true) {
        const result = await this.sourceReader.read();
        if (result.done) {
          return;
        }
        this.buffer.push(result.value);
      }
    } finally {
      this.sourceReader.releaseLock();
    }
  }
}

const runCase = async () => {
  const sdkStream = createSdkEventStream();
  const streamReference = new WeakRef(sdkStream);
  if (variant === 'legacy-sdk-stream') {
    const replay = new LegacyReplay(sdkStream);
    await replay.consume();
    return {
      replay,
      streamReference,
    };
  }
  const replay = new ReusableReadableStream(sdkStream);
  for await (const _event of replay.createConsumer()) {
    // Drain and retain parsed replay events.
  }
  return {
    replay,
    streamReference,
  };
};

await settle();
const baseline = memory();
let peak = baseline;
const timer = setInterval(() => {
  peak = Math.max(peak, memory());
}, 1);
timer.unref();
const held = await runCase();
clearInterval(timer);
peak = Math.max(peak, memory());
await settle();
const retained = memory();
const transportCollected = held.streamReference.deref() === undefined;

if (held.replay.buffer.length !== eventCount) {
  throw new Error(`Expected ${eventCount} replay events, received ${held.replay.buffer.length}.`);
}

console.log(
  JSON.stringify({
    variant,
    eventCount,
    peakDeltaBytes: peak - baseline,
    retainedDeltaBytes: retained - baseline,
    transportCollected,
  }),
);

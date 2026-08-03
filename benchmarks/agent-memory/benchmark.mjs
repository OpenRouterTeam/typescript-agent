import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';

const MIB = 1024 * 1024;
const WORKERS_LIMIT_BYTES = 128 * MIB;
const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? 'all';
const model = args.model ?? 'openai/gpt-4.1-nano';
const sequentialIterations = integerArg('iterations', 15);
const retainedIterations = integerArg('retained', 6);
const warmupIterations = integerArg('warmups', 2);
const sampleIntervalMs = integerArg('sample-interval-ms', 2);
const syntheticDeltaCounts = integerListArg(
  'synthetic-counts',
  [
    1_000,
    5_000,
    10_000,
  ],
);
const syntheticConsumers = listArg('synthetic-consumers', [
  'text-deltas',
  'cumulative-items',
]);
const bundlePath = args.bundle;
const concurrencyLevels = integerListArg(
  'concurrency-levels',
  [
    1,
    4,
    8,
  ],
);
const concurrencyOutputWords = integerArg('concurrency-output-words', 0);
const multiTurnCount = integerArg('multi-turn-count', 4);
const multiTurnOutputWords = integerArg('multi-turn-output-words', 2_048);
const outputWordCounts = integerListArg(
  'output-words',
  [
    32,
    256,
    1_024,
  ],
);
const liveSections = listArg('sections', [
  'sequential',
  'sdk-control',
  'retained',
  'concurrency',
  'output-scaling',
  'tool-loop',
  'multi-turn-long',
]);

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run with --expose-gc so settled heap measurements are meaningful.');
}

const report = {
  metadata: {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    mode,
    model,
    bundlePath: bundlePath ?? null,
    liveSections,
    concurrencyLevels,
    concurrencyOutputWords,
    multiTurnCount,
    multiTurnOutputWords,
    outputWordCounts,
    workersLimitBytes: WORKERS_LIMIT_BYTES,
    v8HeapSizeLimitBytes: getHeapStatistics().heap_size_limit,
    sampleIntervalMs,
  },
  measurements: {},
};

const beforeImport = await settledMemory();
const importPeak = await capturePeak(async () => {
  if (mode === 'raw-fetch') {
    return {};
  }
  if (bundlePath) {
    const agent = await import(pathToFileURL(resolve(bundlePath)).href);
    return {
      agent,
    };
  }
  if (mode === 'synthetic') {
    const [reusable, transformers] = await Promise.all([
      import('../../packages/agent/esm/lib/reusable-stream.js'),
      import('../../packages/agent/esm/lib/stream-transformers.js'),
    ]);
    return {
      reusable,
      transformers,
    };
  }
  if (mode === 'live') {
    return {
      agent: await import('../../packages/agent/esm/index.js'),
    };
  }
  const [agent, reusable, transformers] = await Promise.all([
    import('../../packages/agent/esm/index.js'),
    import('../../packages/agent/esm/lib/reusable-stream.js'),
    import('../../packages/agent/esm/lib/stream-transformers.js'),
  ]);
  return {
    agent,
    reusable,
    transformers,
  };
});
const afterImport = await settledMemory();

report.measurements.import = {
  before: beforeImport,
  after: afterImport,
  delta: memoryDelta(afterImport, beforeImport),
  peak: importPeak.peak,
  peakDelta: memoryDelta(importPeak.peak, beforeImport),
};

if (mode === 'all' || mode === 'synthetic') {
  if (bundlePath) {
    throw new Error('Synthetic mode uses internal modules and cannot run with --bundle.');
  }
  report.measurements.synthetic = await runSynthetic(importPeak.value);
}

if (mode === 'all' || mode === 'live') {
  const apiKey = getApiKey();
  report.measurements.live = await runLive(importPeak.value.agent, apiKey);
}

if (mode === 'raw-fetch') {
  if (bundlePath) {
    throw new Error('Raw fetch mode cannot run with --bundle.');
  }
  report.measurements.rawFetch = await runRawFetch(getApiKey());
}

console.log(JSON.stringify(report, null, 2));

async function runSynthetic(modules) {
  const { ReusableReadableStream } = modules.reusable;
  const { buildItemsStream, extractTextDeltas } = modules.transformers;
  const cases = [];

  for (const consumer of syntheticConsumers) {
    if (consumer !== 'text-deltas' && consumer !== 'cumulative-items') {
      throw new Error('--synthetic-consumers accepts only "text-deltas" and "cumulative-items".');
    }
    for (const deltaCount of syntheticDeltaCounts) {
      const baseline = await settledMemory();
      let stream = new ReusableReadableStream(makeSyntheticTextStream(deltaCount, 64));
      let emitted = 0;
      let finalTextLength = 0;

      const measured = await capturePeak(async () => {
        const iterable =
          consumer === 'text-deltas' ? extractTextDeltas(stream) : buildItemsStream(stream);
        for await (const value of iterable) {
          emitted += 1;
          if (consumer === 'text-deltas') {
            finalTextLength += value.length;
          } else if (value.type === 'message') {
            const part = value.content?.[0];
            if (part?.type === 'output_text') {
              finalTextLength = part.text.length;
            }
          }
        }
      });

      const retained = await settledMemory();
      stream = null;
      const released = await settledMemory();
      cases.push({
        consumer,
        deltaCount,
        payloadBytes: deltaCount * 64,
        emitted,
        finalTextLength,
        baseline,
        peak: measured.peak,
        peakDelta: memoryDelta(measured.peak, baseline),
        retained,
        retainedDelta: memoryDelta(retained, baseline),
        released,
        releasedDelta: memoryDelta(released, baseline),
      });
    }
  }

  return {
    cases,
  };
}

async function runLive(agent, apiKey) {
  const { OpenRouter, stepCountIs, tool } = agent;
  const z = agent.z ?? (await import('../../packages/agent/node_modules/zod/v4/index.js')).z;
  const client = new OpenRouter({
    apiKey,
  });

  for (let i = 0; i < warmupIterations; i += 1) {
    await runShortRequest(client);
  }

  const measurements = {
    warmupIterations,
  };
  if (liveSections.includes('sequential')) {
    measurements.sequential = await benchmarkSequential(client);
  }
  if (liveSections.includes('sdk-control')) {
    const betaResponsesSend =
      agent.betaResponsesSend ??
      (
        await import(
          '../../packages/agent/node_modules/@openrouter/sdk/esm/funcs/betaResponsesSend.js'
        )
      ).betaResponsesSend;
    measurements.sdkControl = await benchmarkSdkControl(client, betaResponsesSend);
  }
  if (liveSections.includes('retained')) {
    measurements.retainedResults = await benchmarkRetainedResults(client);
  }
  if (liveSections.includes('concurrency')) {
    measurements.concurrency = await benchmarkConcurrency(client);
  }
  if (liveSections.includes('output-scaling')) {
    measurements.outputScaling = await benchmarkOutputScaling(client);
  }
  if (liveSections.includes('tool-loop')) {
    measurements.toolLoop = await benchmarkToolLoop({
      client,
      tool,
      stepCountIs,
      z,
    });
  }
  if (liveSections.includes('multi-turn-long')) {
    measurements.multiTurnLong = await benchmarkLongMultiTurn({
      executeTurn: async (input) => {
        let held = client.callModel({
          model,
          input,
          maxOutputTokens: multiTurnOutputWords + 64,
          temperature: 0,
        });
        const response = await held.getResponse();
        return {
          text: extractResponseText(response),
          usage: normalizeUsage(response.usage),
          release: () => {
            if (held === null) {
              return;
            }
            held = null;
          },
        };
      },
    });
  }
  return measurements;
}

async function runRawFetch(apiKey) {
  for (let i = 0; i < warmupIterations; i += 1) {
    const response = await fetchOpenRouter(apiKey, {
      input: 'Reply with exactly the word ok.',
      maxOutputTokens: 16,
    });
    response.release();
  }

  return {
    warmupIterations,
    multiTurnLong: await benchmarkLongMultiTurn({
      executeTurn: (input) =>
        fetchOpenRouter(apiKey, {
          input,
          maxOutputTokens: multiTurnOutputWords + 64,
        }),
    }),
  };
}

async function benchmarkSequential(client) {
  const baseline = await settledMemory();
  const settledSamples = [];
  let absolutePeak = baseline;
  let outputTokens = 0;

  for (let i = 0; i < sequentialIterations; i += 1) {
    const measured = await capturePeak(() => runShortRequest(client));
    outputTokens += measured.value.outputTokens;
    absolutePeak = maxMemory(absolutePeak, measured.peak);
    settledSamples.push(await settledMemory());
  }

  const final = settledSamples.at(-1) ?? baseline;
  return {
    iterations: sequentialIterations,
    outputTokens,
    baseline,
    peak: absolutePeak,
    peakDelta: memoryDelta(absolutePeak, baseline),
    final,
    finalDelta: memoryDelta(final, baseline),
    heapUsedSlopeBytesPerRequest: linearSlope(settledSamples.map((sample) => sample.heapUsed)),
    trackedSlopeBytesPerRequest: linearSlope(settledSamples.map((sample) => sample.tracked)),
    settledSamples,
  };
}

async function benchmarkSdkControl(client, betaResponsesSend) {
  const baseline = await settledMemory();
  const settledSamples = [];
  let absolutePeak = baseline;
  let outputTokens = 0;

  for (let i = 0; i < sequentialIterations; i += 1) {
    const measured = await capturePeak(async () => {
      const result = await betaResponsesSend(client, {
        responsesRequest: {
          ...shortRequest(),
          stream: true,
        },
      });
      if (!result.ok) {
        throw result.error;
      }
      let response;
      for await (const event of result.value) {
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          response = event.response;
        }
      }
      if (!response) {
        throw new Error('SDK control stream ended without a response.');
      }
      return response.usage?.outputTokens ?? 0;
    });
    outputTokens += measured.value;
    absolutePeak = maxMemory(absolutePeak, measured.peak);
    settledSamples.push(await settledMemory());
  }

  const final = settledSamples.at(-1) ?? baseline;
  return {
    iterations: sequentialIterations,
    outputTokens,
    baseline,
    peak: absolutePeak,
    peakDelta: memoryDelta(absolutePeak, baseline),
    final,
    finalDelta: memoryDelta(final, baseline),
    heapUsedSlopeBytesPerRequest: linearSlope(settledSamples.map((sample) => sample.heapUsed)),
    trackedSlopeBytesPerRequest: linearSlope(settledSamples.map((sample) => sample.tracked)),
    settledSamples,
  };
}

async function benchmarkRetainedResults(client) {
  const baseline = await settledMemory();
  const held = [];
  const settledSamples = [];
  let absolutePeak = baseline;

  for (let i = 0; i < retainedIterations; i += 1) {
    const measured = await capturePeak(async () => {
      const result = client.callModel(shortRequest());
      const response = await result.getResponse();
      return {
        result,
        outputTokens: response.usage?.outputTokens ?? 0,
      };
    });
    held.push(measured.value.result);
    absolutePeak = maxMemory(absolutePeak, measured.peak);
    settledSamples.push(await settledMemory());
  }

  const retained = settledSamples.at(-1) ?? baseline;
  held.length = 0;
  const released = await settledMemory();
  return {
    iterations: retainedIterations,
    baseline,
    peak: absolutePeak,
    peakDelta: memoryDelta(absolutePeak, baseline),
    retained,
    retainedDelta: memoryDelta(retained, baseline),
    released,
    releasedDelta: memoryDelta(released, baseline),
    heapUsedSlopeBytesPerHeldResult: linearSlope(settledSamples.map((sample) => sample.heapUsed)),
    trackedSlopeBytesPerHeldResult: linearSlope(settledSamples.map((sample) => sample.tracked)),
    settledSamples,
  };
}

async function benchmarkConcurrency(client) {
  const cases = [];
  for (const concurrency of concurrencyLevels) {
    const baseline = await settledMemory();
    let held = [];
    const measured = await capturePeak(async () => {
      held = Array.from(
        {
          length: concurrency,
        },
        () =>
          client.callModel(
            concurrencyOutputWords > 0 ? outputRequest(concurrencyOutputWords) : shortRequest(),
          ),
      );
      const responses = await Promise.all(held.map((result) => result.getResponse()));
      return responses.reduce((sum, response) => sum + (response.usage?.outputTokens ?? 0), 0);
    });
    const retained = await settledMemory();
    held = [];
    const released = await settledMemory();
    cases.push({
      concurrency,
      outputTokens: measured.value,
      baseline,
      peak: measured.peak,
      peakDelta: memoryDelta(measured.peak, baseline),
      retained,
      retainedDelta: memoryDelta(retained, baseline),
      released,
      releasedDelta: memoryDelta(released, baseline),
    });
  }
  return {
    cases,
  };
}

async function benchmarkOutputScaling(client) {
  const cases = [];
  for (const targetWords of outputWordCounts) {
    const baseline = await settledMemory();
    let held = client.callModel(outputRequest(targetWords));
    let eventCount = 0;
    const measured = await capturePeak(async () => {
      for await (const _event of held.getFullResponsesStream()) {
        eventCount += 1;
      }
      return held.getResponse();
    });
    const retained = await settledMemory();
    const outputTokens = measured.value.usage?.outputTokens ?? 0;
    const outputCharacters = extractResponseText(measured.value).length;
    held = null;
    const released = await settledMemory();
    cases.push({
      targetWords,
      outputTokens,
      outputCharacters,
      eventCount,
      baseline,
      peak: measured.peak,
      peakDelta: memoryDelta(measured.peak, baseline),
      retained,
      retainedDelta: memoryDelta(retained, baseline),
      released,
      releasedDelta: memoryDelta(released, baseline),
    });
  }
  return {
    cases,
  };
}

async function benchmarkToolLoop({ client, tool, stepCountIs, z }) {
  let executions = 0;
  const recordStep = tool({
    name: 'record_step',
    description: 'Record exactly one numbered step and return the next step number.',
    inputSchema: z.object({
      step: z.number().int().min(1).max(3),
    }),
    outputSchema: z.object({
      recorded: z.number(),
      nextStep: z.number().nullable(),
    }),
    execute: async ({ step }) => {
      executions += 1;
      return {
        recorded: step,
        nextStep: step < 3 ? step + 1 : null,
      };
    },
  });

  const baseline = await settledMemory();
  let held = client.callModel({
    model,
    input:
      'Call record_step for step 1. After its result, call it for step 2. After that result, call it for step 3. Then answer only "done". Do not skip a step.',
    tools: [
      recordStep,
    ],
    stopWhen: stepCountIs(4),
    maxOutputTokens: 64,
    temperature: 0,
  });
  let eventCount = 0;
  let turns = 0;
  const measured = await capturePeak(async () => {
    for await (const event of held.getFullResponsesStream()) {
      eventCount += 1;
      if (event.type === 'turn.start') {
        turns += 1;
      }
    }
    return held.getResponse();
  });
  const retained = await settledMemory();
  const outputTokens = measured.value.usage?.outputTokens ?? 0;
  held = null;
  const released = await settledMemory();
  return {
    executions,
    turns,
    eventCount,
    outputTokens,
    baseline,
    peak: measured.peak,
    peakDelta: memoryDelta(measured.peak, baseline),
    retained,
    retainedDelta: memoryDelta(retained, baseline),
    released,
    releasedDelta: memoryDelta(released, baseline),
  };
}

async function benchmarkLongMultiTurn({ executeTurn }) {
  const initialBaseline = await settledMemory();
  const conversation = [];
  const turns = [];
  let absolutePeak = initialBaseline;
  const totalUsage = emptyUsage();

  for (let turn = 1; turn <= multiTurnCount; turn += 1) {
    conversation.push({
      role: 'user',
      content: `Turn ${turn}: output exactly ${multiTurnOutputWords} copies of the word "token", separated by single spaces. Output nothing else.`,
    });
    const turnBaseline = await settledMemory();
    const measured = await capturePeak(() => executeTurn(conversation));
    absolutePeak = maxMemory(absolutePeak, measured.peak);
    addUsage(totalUsage, measured.value.usage);

    conversation.push({
      role: 'assistant',
      content: measured.value.text,
    });
    const retainedWithResult = await settledMemory();
    measured.value.release();
    const conversationOnly = await settledMemory();

    turns.push({
      turn,
      conversationCharacters: conversation.reduce(
        (sum, message) => sum + message.content.length,
        0,
      ),
      outputCharacters: measured.value.text.length,
      usage: measured.value.usage,
      baseline: turnBaseline,
      peak: measured.peak,
      peakDelta: memoryDelta(measured.peak, turnBaseline),
      retainedWithResult,
      retainedWithResultDelta: memoryDelta(retainedWithResult, turnBaseline),
      conversationOnly,
      totalDelta: memoryDelta(conversationOnly, initialBaseline),
    });
  }

  const conversationRetained = await settledMemory();
  conversation.length = 0;
  const released = await settledMemory();
  return {
    turnCount: multiTurnCount,
    targetOutputWordsPerTurn: multiTurnOutputWords,
    totalUsage,
    initialBaseline,
    peak: absolutePeak,
    peakDelta: memoryDelta(absolutePeak, initialBaseline),
    conversationRetained,
    conversationRetainedDelta: memoryDelta(conversationRetained, initialBaseline),
    released,
    releasedDelta: memoryDelta(released, initialBaseline),
    turns,
  };
}

async function fetchOpenRouter(apiKey, { input, maxOutputTokens }) {
  const response = await fetch('https://openrouter.ai/api/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: maxOutputTokens,
      temperature: 0,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Raw OpenRouter request failed (${response.status}): ${JSON.stringify(body).slice(0, 500)}`,
    );
  }

  let held = body;
  return {
    text: extractResponseText(body),
    usage: normalizeUsage(body.usage),
    release: () => {
      if (held === null) {
        return;
      }
      held = null;
    },
  };
}

async function runShortRequest(client) {
  const result = client.callModel(shortRequest());
  const response = await result.getResponse();
  return {
    outputTokens: response.usage?.outputTokens ?? 0,
  };
}

function shortRequest() {
  return {
    model,
    input: 'Reply with exactly the word ok.',
    maxOutputTokens: 16,
    temperature: 0,
  };
}

function outputRequest(targetWords) {
  return {
    model,
    input: `Output exactly ${targetWords} copies of the word "token", separated by single spaces. Output nothing else.`,
    maxOutputTokens: targetWords + 32,
    temperature: 0,
  };
}

function makeSyntheticTextStream(deltaCount, chunkBytes) {
  let index = -1;
  return new ReadableStream({
    pull(controller) {
      index += 1;
      if (index === 0) {
        controller.enqueue({
          type: 'response.output_item.added',
          item: {
            id: 'message_1',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        });
        return;
      }
      if (index <= deltaCount) {
        const prefix = `${index}:`;
        controller.enqueue({
          type: 'response.output_text.delta',
          itemId: 'message_1',
          delta: `${prefix}${'x'.repeat(Math.max(0, chunkBytes - prefix.length))}`,
        });
        return;
      }
      controller.close();
    },
  });
}

function extractResponseText(response) {
  const text = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') {
      continue;
    }
    for (const part of item.content ?? []) {
      if (part.type === 'output_text') {
        text.push(part.text);
      }
    }
  }
  return text.join('');
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
  };
}

function normalizeUsage(usage) {
  return {
    inputTokens: usage?.inputTokens ?? usage?.input_tokens ?? 0,
    outputTokens: usage?.outputTokens ?? usage?.output_tokens ?? 0,
    totalTokens: usage?.totalTokens ?? usage?.total_tokens ?? 0,
    cachedTokens:
      usage?.inputTokensDetails?.cachedTokens ?? usage?.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens:
      usage?.outputTokensDetails?.reasoningTokens ??
      usage?.output_tokens_details?.reasoning_tokens ??
      0,
    cost: usage?.cost ?? 0,
  };
}

function addUsage(total, usage) {
  for (const key of Object.keys(total)) {
    total[key] += usage[key];
  }
}

async function settledMemory() {
  globalThis.gc();
  await delay(0);
  globalThis.gc();
  await delay(0);
  return readMemory();
}

async function capturePeak(operation) {
  let peak = readMemory();
  const timer = setInterval(() => {
    peak = maxMemory(peak, readMemory());
  }, sampleIntervalMs);
  timer.unref();
  try {
    const value = await operation();
    peak = maxMemory(peak, readMemory());
    return {
      value,
      peak,
    };
  } finally {
    clearInterval(timer);
  }
}

function readMemory() {
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    rss: memory.rss,
    tracked: memory.heapUsed + memory.external,
    workersLimitFraction: (memory.heapUsed + memory.external) / WORKERS_LIMIT_BYTES,
  };
}

function maxMemory(left, right) {
  return {
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    heapTotal: Math.max(left.heapTotal, right.heapTotal),
    external: Math.max(left.external, right.external),
    arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
    rss: Math.max(left.rss, right.rss),
    tracked: Math.max(left.tracked, right.tracked),
    workersLimitFraction: Math.max(left.workersLimitFraction, right.workersLimitFraction),
  };
}

function memoryDelta(value, baseline) {
  return {
    heapUsed: value.heapUsed - baseline.heapUsed,
    heapTotal: value.heapTotal - baseline.heapTotal,
    external: value.external - baseline.external,
    arrayBuffers: value.arrayBuffers - baseline.arrayBuffers,
    rss: value.rss - baseline.rss,
    tracked: value.tracked - baseline.tracked,
    workersLimitFraction: value.workersLimitFraction - baseline.workersLimitFraction,
  };
}

function linearSlope(values) {
  if (values.length < 2) {
    return 0;
  }
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - xMean) * (values[index] - yMean);
    denominator += (index - xMean) ** 2;
  }
  return numerator / denominator;
}

function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (tokens[index + 1] && !tokens[index + 1].startsWith('--')) {
      parsed[rawKey] = tokens[index + 1];
      index += 1;
    } else {
      parsed[rawKey] = 'true';
    }
  }
  return parsed;
}

function integerArg(name, fallback) {
  const raw = args[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return value;
}

function listArg(name, fallback) {
  const raw = args[name];
  return raw === undefined ? fallback : raw.split(',').filter(Boolean);
}

function integerListArg(name, fallback) {
  const values = listArg(name, fallback.map(String)).map((raw) => Number.parseInt(raw, 10));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`--${name} must be a comma-separated list of non-negative integers.`);
  }
  return values;
}

function getApiKey() {
  const apiKey = process.env.OPENROUTER_TEST_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Set OPENROUTER_TEST_KEY (preferred) or OPENROUTER_API_KEY for live mode.');
  }
  return apiKey;
}

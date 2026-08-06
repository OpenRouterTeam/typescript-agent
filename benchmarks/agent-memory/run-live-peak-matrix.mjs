import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='));
const runs = Number.parseInt(runsArg?.slice('--runs='.length) ?? '20', 10);
const concurrency = Number.parseInt(concurrencyArg?.slice('--concurrency='.length) ?? '4', 10);
if (!Number.isSafeInteger(runs) || runs < 20) {
  throw new Error('--runs must be an integer of at least 20.');
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  throw new Error('--concurrency must be a positive integer.');
}
if (!process.env.OPENROUTER_TEST_KEY && !process.env.OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_TEST_KEY or OPENROUTER_API_KEY is required.');
}

const benchmark = fileURLToPath(new URL('./benchmark.mjs', import.meta.url));
const bundle = fileURLToPath(
  new URL('../../.turbo/agent-memory/cloudflare-worker.bundle.mjs', import.meta.url),
);
const cases = [
  'no-tools',
  'tool-turns',
];
const schedule = Array.from(
  {
    length: runs,
  },
  () => cases,
)
  .flat()
  .map((name) => ({
    name,
    order: Math.random(),
  }))
  .sort((left, right) => left.order - right.order);
const samples = new Map(
  cases.map((name) => [
    name,
    [],
  ]),
);

const runCase = (name) =>
  new Promise((resolve, reject) => {
    const section = name === 'no-tools' ? 'output-scaling' : 'tool-turns';
    const args = [
      '--expose-gc',
      '--max-old-space-size=128',
      '--max-semi-space-size=8',
      benchmark,
      '--mode=live',
      `--bundle=${bundle}`,
      '--model=openai/gpt-5.6-luna',
      `--sections=${section}`,
      '--warmups=1',
      ...(name === 'no-tools'
        ? [
            '--output-words=2048',
          ]
        : [
            '--tool-turn-count=10',
            '--tool-final-output-words=2048',
          ]),
    ];
    const child = spawn(process.execPath, args, {
      env: process.env,
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${name} failed (${String(code)}): ${stderr || stdout}`));
        return;
      }
      const report = JSON.parse(stdout);
      const measurement =
        name === 'no-tools'
          ? report.measurements.live.outputScaling.cases[0]
          : report.measurements.live.toolTurns;
      if (name === 'tool-turns' && (measurement.executions !== 10 || measurement.turns !== 11)) {
        reject(
          new Error(
            `Tool case did not complete 10 sequential turns: ${JSON.stringify({
              executions: measurement.executions,
              turns: measurement.turns,
              executedSteps: measurement.executedSteps,
            })}`,
          ),
        );
        return;
      }
      resolve({
        peakBytes: measurement.peak.tracked,
        baselineBytes: measurement.baseline.tracked,
        peakDeltaBytes: measurement.peakDelta.tracked,
        eventCount: measurement.eventCount,
        outputTokens: measurement.outputTokens,
      });
    });
  });

let nextIndex = 0;
const workers = Array.from(
  {
    length: Math.min(concurrency, schedule.length),
  },
  async () => {
    while (nextIndex < schedule.length) {
      const index = nextIndex++;
      const entry = schedule[index];
      const result = await runCase(entry.name);
      samples.get(entry.name).push(result);
      process.stderr.write(
        `[${String(index + 1)}/${String(schedule.length)}] ${entry.name} complete\n`,
      );
    }
  },
);
await Promise.all(workers);

const percentile = (values, fraction) => {
  const sorted = [
    ...values,
  ].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};
const summarize = (name) => {
  const values = samples.get(name);
  const metric = (key) => values.map((value) => value[key]);
  return {
    name,
    runs: values.length,
    peakBytes: {
      median: percentile(metric('peakBytes'), 0.5),
      p95: percentile(metric('peakBytes'), 0.95),
      min: Math.min(...metric('peakBytes')),
      max: Math.max(...metric('peakBytes')),
    },
    peakDeltaBytes: {
      median: percentile(metric('peakDeltaBytes'), 0.5),
      p95: percentile(metric('peakDeltaBytes'), 0.95),
    },
    eventCount: {
      median: percentile(metric('eventCount'), 0.5),
      p95: percentile(metric('eventCount'), 0.95),
    },
    outputTokens: {
      median: percentile(metric('outputTokens'), 0.5),
      p95: percentile(metric('outputTokens'), 0.95),
    },
  };
};

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      model: 'openai/gpt-5.6-luna',
      randomizedOrder: true,
      processConcurrency: concurrency,
      results: cases.map(summarize),
    },
    null,
    2,
  ),
);

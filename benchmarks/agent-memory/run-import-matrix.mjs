import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const runsArg = args.find((arg) => arg.startsWith('--runs='));
const runs = runsArg ? Number.parseInt(runsArg.slice('--runs='.length), 10) : 20;
const cases = args
  .filter((arg) => !arg.startsWith('--'))
  .map((arg) => {
    const separator = arg.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Expected label=module-path, received: ${arg}`);
    }
    return {
      label: arg.slice(0, separator),
      target: arg.slice(separator + 1),
    };
  });

if (!Number.isSafeInteger(runs) || runs < 1) {
  throw new Error('--runs must be a positive integer.');
}
if (cases.length === 0) {
  throw new Error('Pass at least one label=module-path case.');
}

const worker = fileURLToPath(new URL('./measure-import-case.mjs', import.meta.url));
const schedule = Array.from(
  {
    length: runs,
  },
  () => cases,
)
  .flat()
  .map((value) => ({
    value,
    order: Math.random(),
  }))
  .sort((left, right) => left.order - right.order)
  .map(({ value }) => value);
const samples = new Map(
  cases.map(({ label }) => [
    label,
    [],
  ]),
);

for (const entry of schedule) {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      worker,
      entry.target,
    ],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Import case "${entry.label}" failed:\n${result.stderr || result.stdout || 'unknown error'}`,
    );
  }
  samples.get(entry.label).push(JSON.parse(result.stdout));
}

const percentile = (values, fraction) => {
  const sorted = [
    ...values,
  ].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
};

const results = cases.map(({ label, target }) => {
  const caseSamples = samples.get(label);
  const tracked = caseSamples.map((sample) => sample.delta.tracked);
  const durations = caseSamples.map((sample) => sample.importDurationMs);
  return {
    label,
    target,
    runs,
    trackedBytes: {
      median: percentile(tracked, 0.5),
      p95: percentile(tracked, 0.95),
      min: Math.min(...tracked),
      max: Math.max(...tracked),
    },
    importDurationMs: {
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
  };
});

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      randomizedOrder: true,
      results,
    },
    null,
    2,
  ),
);

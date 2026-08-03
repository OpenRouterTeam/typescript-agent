import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runRetentionPeakMatrix(
  workerUrl,
  retentions = [
    'full',
    'active-consumers',
  ],
) {
  const runsArg = process.argv.find((arg) => arg.startsWith('--runs='));
  const countArg = process.argv.find((arg) => arg.startsWith('--events='));
  const runs = Number.parseInt(runsArg?.slice('--runs='.length) ?? '20', 10);
  const eventCount = Number.parseInt(countArg?.slice('--events='.length) ?? '50000', 10);
  if (!Number.isSafeInteger(runs) || runs < 20) {
    throw new Error('--runs must be an integer of at least 20.');
  }
  if (!Number.isSafeInteger(eventCount) || eventCount < 1) {
    throw new Error('--events must be a positive integer.');
  }

  const worker = fileURLToPath(workerUrl);
  const schedule = Array.from(
    {
      length: runs,
    },
    () => retentions,
  )
    .flat()
    .map((retention) => ({
      retention,
      order: Math.random(),
    }))
    .sort((left, right) => left.order - right.order);
  const samples = new Map(
    retentions.map((retention) => [
      retention,
      [],
    ]),
  );

  for (const { retention } of schedule) {
    const result = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        worker,
        retention,
        String(eventCount),
      ],
      {
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `${retention} case failed`);
    }
    samples.get(retention).push(JSON.parse(result.stdout));
  }

  const percentile = (values, fraction) => {
    const sorted = [
      ...values,
    ].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  };
  const results = retentions.map((retention) => {
    const values = samples.get(retention);
    const peaks = values.map((value) => value.peakDeltaBytes);
    const retained = values.map((value) => value.retainedDeltaBytes);
    const durations = values
      .map((value) => value.durationMs)
      .filter((value) => typeof value === 'number');
    return {
      retention,
      runs,
      eventCount,
      peakDeltaBytes: {
        median: percentile(peaks, 0.5),
        p95: percentile(peaks, 0.95),
        min: Math.min(...peaks),
        max: Math.max(...peaks),
      },
      retainedDeltaBytes: {
        median: percentile(retained, 0.5),
        p95: percentile(retained, 0.95),
      },
      ...(durations.length > 0 && {
        durationMs: {
          median: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
        },
      }),
    };
  });

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        randomizedOrder: true,
        results,
      },
      null,
      2,
    ),
  );
}

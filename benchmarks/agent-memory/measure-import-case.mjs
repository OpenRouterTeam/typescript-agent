import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run import cases with --expose-gc.');
}

const target = process.argv[2];
if (!target) {
  throw new Error('Pass one module path to import.');
}

const sample = () => {
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    external: memory.external,
    tracked: memory.heapUsed + memory.external,
  };
};
const settle = async () => {
  globalThis.gc();
  await delay(0);
  globalThis.gc();
  await delay(0);
};

await settle();
const before = sample();
const startedAt = performance.now();
await import(pathToFileURL(resolve(target)).href);
const importDurationMs = performance.now() - startedAt;
await settle();
const after = sample();

console.log(
  JSON.stringify({
    target: resolve(target),
    importDurationMs,
    before,
    after,
    delta: {
      heapUsed: after.heapUsed - before.heapUsed,
      external: after.external - before.external,
      tracked: after.tracked - before.tracked,
    },
  }),
);

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  throw new Error('Pass at least one tree-shaken, minified bundle path.');
}

const bundles = [];
for (const input of paths) {
  const path = resolve(input);
  const source = await readFile(path);
  bundles.push({
    name: basename(path),
    path,
    rawBytes: source.byteLength,
    gzipBytes: gzipSync(source, {
      level: 9,
    }).byteLength,
    brotliBytes: brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength,
  });
}

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      build: {
        bundler: 'esbuild@0.28.1',
        format: 'esm',
        minified: true,
        platform: 'browser',
        target: 'es2022',
        treeShaking: true,
      },
      bundles,
    },
    null,
    2,
  ),
);

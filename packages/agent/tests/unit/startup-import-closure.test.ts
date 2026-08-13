import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the startup cost of the "hot" published subpaths.
 *
 * Consumers such as OpenRouter's Cloudflare Workers statically import
 * `@openrouter/agent/tool`, `/tool-types`, and `/stop-conditions` from code
 * that runs during Worker startup, where Cloudflare enforces a hard 1s CPU
 * ceiling on script validation. A runtime (non-type) import of
 * `@openrouter/sdk` from any module reachable from those subpaths pulls in
 * the Speakeasy models barrel — hundreds of modules of top-level Zod schema
 * construction — which in 0.9.0 added ~200ms of startup CPU per worker and
 * blocked deploys (Cloudflare error 10021).
 *
 * This test walks the static, runtime import graph of each hot subpath's
 * source and asserts it never reaches `@openrouter/sdk`. Type-only imports
 * are fine (erased at compile time); dynamic `import()` is fine (deferred by
 * bundlers off the startup path). If a hot subpath genuinely needs an SDK
 * value, re-export it from a leaf module or inline the literal instead.
 */

const HOT_SUBPATH_ENTRY_FILES = [
  'src/lib/tool.ts',
  'src/lib/tool-types.ts',
  'src/lib/stop-conditions.ts',
] as const;

/** External packages a hot subpath may load at runtime. */
const ALLOWED_EXTERNAL_PREFIXES = [
  'zod',
] as const;

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

describe('startup import closure of hot subpaths', () => {
  it.each(HOT_SUBPATH_ENTRY_FILES)('%s never runtime-imports @openrouter/sdk', (entryFile) => {
    const { files, externals } = walkRuntimeImportClosure(path.join(PACKAGE_ROOT, entryFile));

    const forbidden = [
      ...externals,
    ].filter(
      (specifier) => !ALLOWED_EXTERNAL_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
    );

    expect(
      forbidden,
      `runtime import closure: ${[
        ...files,
      ].join(', ')}`,
    ).toEqual([]);
  });
});

interface RuntimeImportClosure {
  files: ReadonlySet<string>;
  externals: ReadonlySet<string>;
}

/**
 * Collects the static runtime import graph starting at `entryPath`.
 * Follows `import ... from`, `export ... from`, and bare side-effect imports.
 * Skips `import type` / `export type` (erased by tsc) and dynamic `import()`
 * (deferred by bundlers). Relative edges are traversed; bare specifiers are
 * recorded as externals.
 */
function walkRuntimeImportClosure(entryPath: string): RuntimeImportClosure {
  const edgePattern = /(?:^|\n)\s*(import|export)\s+(type\s)?([^'"]*?from\s*)?['"]([^'"]+)['"]/g;
  const files = new Set<string>();
  const externals = new Set<string>();
  const queue = [
    entryPath,
  ];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(edgePattern)) {
      const [, keyword, typeModifier, fromClause, specifier] = match;
      const isTypeOnly = typeModifier !== undefined;
      const isBareExport = keyword === 'export' && fromClause === undefined;
      if (isTypeOnly || isBareExport || specifier === undefined) {
        continue;
      }
      if (specifier.startsWith('.')) {
        queue.push(resolveRelativeTsImport(path.dirname(file), specifier));
      } else {
        externals.add(specifier);
      }
    }
  }
  return {
    files,
    externals,
  };
}

/** Maps a `./module.js` ESM specifier back to its TypeScript source file. */
function resolveRelativeTsImport(fromDir: string, specifier: string): string {
  const resolved = path.resolve(fromDir, specifier.replace(/\.js$/, '.ts'));
  if (existsSync(resolved)) {
    return resolved;
  }
  return path.resolve(fromDir, specifier);
}

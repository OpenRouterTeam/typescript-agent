import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../src/version.js';

// src/version.ts is generated from package.json but committed, because CI's
// lint/typecheck/unit-test jobs run without a build step. This test is what
// makes that safe: a stale generated file fails here rather than silently
// shipping a wrong `clientInfo` version to every MCP server we connect to.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function packageJsonVersion(): string {
  const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('package.json did not parse to an object');
  }
  const version = (parsed as Record<string, unknown>)['version'];
  if (typeof version !== 'string') {
    throw new Error('package.json has no string "version"');
  }
  return version;
}

describe('PACKAGE_VERSION', () => {
  it('matches package.json — regenerate with `pnpm --filter @openrouter/mcp gen:version`', () => {
    expect(PACKAGE_VERSION).toBe(packageJsonVersion());
  });

  it('is a non-empty semver-shaped string', () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

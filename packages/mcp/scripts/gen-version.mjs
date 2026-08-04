#!/usr/bin/env node
/**
 * Generates src/version.ts from this package's package.json `version`.
 *
 * package.json is the single source of truth. The generated file is committed
 * (not gitignored) because CI's lint/typecheck/unit-test jobs run without a
 * build step, and turbo's `dependsOn: ["^build"]` only builds upstream
 * packages — so nothing would regenerate it before those jobs compile `src`.
 *
 * tests/unit/version.test.ts fails when the committed constant drifts from
 * package.json, so a stale file cannot merge or publish silently.
 *
 * Run `pnpm --filter @openrouter/mcp gen:version` after bumping the version
 * (changesets does the bump; `build` reruns this before `tsc`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(packageRoot, 'package.json');
const outPath = join(packageRoot, 'src', 'version.ts');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const { version } = pkg;

if (typeof version !== 'string' || version.length === 0) {
  console.error(`gen-version: no usable "version" in ${pkgPath}`);
  process.exit(1);
}

// Charset allow-list (semver plus pre-release/build punctuation) so the value
// provably cannot break out of the string literal below — no quotes,
// backslashes, newlines, or backticks can pass. Interpolating into committed,
// import-executed TS without this would let a malformed `version` inject code;
// developer-controlled, so defense-in-depth, but one regex is cheap. The
// single-quoted literal below is safe ONLY because of this guard (a
// JSON.stringify'd literal would fight biome's single-quote formatting of
// src/, and CI checks the generated file for drift).
if (!/^[0-9A-Za-z.+-]+$/.test(version)) {
  console.error(`gen-version: "version" contains characters outside [0-9A-Za-z.+-]: ${version}`);
  process.exit(1);
}

const contents = `// DO NOT EDIT — generated from package.json by scripts/gen-version.mjs.
// Run \`pnpm --filter @openrouter/mcp gen:version\` after bumping the version.

/** This package's version, self-reported to MCP servers as \`clientInfo\`. */
export const PACKAGE_VERSION = '${version}';
`;

// Skip the write when unchanged so turbo/watch modes don't see a dirty output.
let existing;
try {
  existing = readFileSync(outPath, 'utf8');
} catch {
  existing = undefined;
}

if (existing === contents) {
  console.log(`gen-version: src/version.ts already at ${version}`);
} else {
  writeFileSync(outPath, contents);
  console.log(`gen-version: wrote src/version.ts at ${version}`);
}

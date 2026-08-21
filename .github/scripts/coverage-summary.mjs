#!/usr/bin/env node
/**
 * Prints a markdown coverage summary table for the CI job summary.
 * Reads each package's coverage-summary.json (written by vitest's
 * json-summary reporter). Missing files are reported, not fatal — the
 * threshold gate in the test step is what enforces coverage.
 */
import { readFileSync } from 'node:fs';

const packages = ['agent', 'mcp'];

const rows = ['| Package | Statements | Branches | Functions | Lines |', '| --- | --- | --- | --- | --- |'];

for (const pkg of packages) {
  const path = `packages/${pkg}/coverage/coverage-summary.json`;
  try {
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    const total = summary.total;
    rows.push(
      `| ${pkg} | ${total.statements.pct}% | ${total.branches.pct}% | ${total.functions.pct}% | ${total.lines.pct}% |`,
    );
  } catch {
    rows.push(`| ${pkg} | ⚠️ no coverage report | | | |`);
  }
}

console.log('## Coverage\n');
console.log(rows.join('\n'));

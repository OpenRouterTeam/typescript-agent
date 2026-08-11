import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../../src/mcp/version.js';

describe('MCP client PACKAGE_VERSION', () => {
  it('matches the agent package version', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8'),
    );
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

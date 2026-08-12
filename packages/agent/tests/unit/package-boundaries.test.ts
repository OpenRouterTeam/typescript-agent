import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function customConditions(config: string): string[] | undefined {
  const match = /"customConditions"\s*:\s*\[([^\]]*)\]/u.exec(config);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return [
    ...match[1].matchAll(/"([^"]+)"/gu),
  ].map((entry) => entry[1] ?? '');
}

describe('package build boundaries', () => {
  it.each([
    [
      'agent',
      new URL('../../tsconfig.json', import.meta.url),
    ],
    [
      'mcp facade',
      new URL('../../../mcp/tsconfig.json', import.meta.url),
    ],
  ])('%s resolves dependencies through published exports', async (_name, configUrl) => {
    const config = await readFile(configUrl, 'utf8');
    expect(customConditions(config)).toEqual([]);
  });
});

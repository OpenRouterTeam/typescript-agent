import { describe, it, expect } from 'vitest';
import { matchesTool } from '../../src/lib/hooks-matchers.js';

describe('matchesTool', () => {
  it('matches all tools when matcher is undefined', () => {
    expect(matchesTool(undefined, 'Bash')).toBe(true);
    expect(matchesTool(undefined, 'ReadFile')).toBe(true);
  });

  it('matches exact string', () => {
    expect(matchesTool('Bash', 'Bash')).toBe(true);
    expect(matchesTool('Bash', 'ReadFile')).toBe(false);
    expect(matchesTool('Bash', 'bash')).toBe(false);
  });

  it('matches RegExp', () => {
    expect(matchesTool(/^(Read|Write)File$/, 'ReadFile')).toBe(true);
    expect(matchesTool(/^(Read|Write)File$/, 'WriteFile')).toBe(true);
    expect(matchesTool(/^(Read|Write)File$/, 'DeleteFile')).toBe(false);
  });

  it('matches function predicate', () => {
    const matcher = (name: string) => name.startsWith('File');
    expect(matchesTool(matcher, 'FileRead')).toBe(true);
    expect(matchesTool(matcher, 'Bash')).toBe(false);
  });
});

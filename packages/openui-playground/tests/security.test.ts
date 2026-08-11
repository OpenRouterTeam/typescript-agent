import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeHtml, resolveMember } from '../public/render-utils.js';
import { resolveStaticPath } from '../src/static.js';

describe('playground rendering', () => {
  it('returns undefined when a nested member is missing', () => {
    expect(
      resolveMember(
        {
          rows: undefined,
        },
        [
          'rows',
          'title',
        ],
      ),
    ).toBeUndefined();
  });

  it('escapes every model-controlled diagnostics HTML character', () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
      '&#60;img src=&#34;x&#34; onerror=&#39;alert(1)&#39;&#62;&#38;',
    );
  });
});

describe('static path containment', () => {
  const publicDir = resolve('/tmp/openui-playground/public');

  it('accepts files inside public', () => {
    expect(resolveStaticPath(publicDir, '/app.js')).toBe(resolve(publicDir, 'app.js'));
    expect(resolveStaticPath(publicDir, '/')).toBe(resolve(publicDir, 'index.html'));
  });

  it('rejects traversal and sibling-prefix paths', () => {
    expect(resolveStaticPath(publicDir, '/../public-notes/secret.txt')).toBeNull();
    expect(resolveStaticPath(publicDir, '/../../secret.txt')).toBeNull();
  });
});

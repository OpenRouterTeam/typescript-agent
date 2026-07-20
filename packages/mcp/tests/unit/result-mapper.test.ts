import { describe, expect, it } from 'vitest';
import { MCPToolCallError } from '../../src/errors.js';
import { mapCallToolResult } from '../../src/result-mapper.js';

describe('mapCallToolResult', () => {
  it('prefers structuredContent when present', () => {
    const out = mapCallToolResult('t', {
      structuredContent: {
        ok: true,
        count: 3,
      },
      content: [
        {
          type: 'text',
          text: 'ignored',
        },
      ],
    });
    expect(out).toEqual({
      ok: true,
      count: 3,
    });
  });

  it('collapses text content blocks', () => {
    const out = mapCallToolResult('t', {
      content: [
        {
          type: 'text',
          text: 'line 1',
        },
        {
          type: 'text',
          text: 'line 2',
        },
      ],
    });
    expect(out).toBe('line 1\nline 2');
  });

  it('represents non-text blocks with a typed placeholder', () => {
    const out = mapCallToolResult('t', {
      content: [
        {
          type: 'text',
          text: 'see image',
        },
        {
          type: 'image',
          data: 'base64',
          mimeType: 'image/png',
        },
      ],
    });
    expect(out).toBe('see image\n[image content]');
  });

  it('throws MCPToolCallError when isError is true', () => {
    expect(() =>
      mapCallToolResult('my_tool', {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'boom',
          },
        ],
      }),
    ).toThrow(MCPToolCallError);
  });

  it('throws with a default message when error content is empty', () => {
    expect(() =>
      mapCallToolResult('my_tool', {
        isError: true,
      }),
    ).toThrow('MCP tool returned an error');
  });
});

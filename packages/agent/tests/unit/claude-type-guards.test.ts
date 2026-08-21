import { describe, expect, it } from 'vitest';
import { ClaudeContentBlockType } from '../../src/lib/claude-constants.js';
import { isClaudeStyleMessages } from '../../src/lib/claude-type-guards.js';

describe('isClaudeStyleMessages', () => {
  it('returns false for non-array input', () => {
    expect(isClaudeStyleMessages('hello')).toBe(false);
    expect(isClaudeStyleMessages(null)).toBe(false);
    expect(isClaudeStyleMessages(undefined)).toBe(false);
    expect(isClaudeStyleMessages(42)).toBe(false);
    expect(
      isClaudeStyleMessages({
        role: 'user',
      }),
    ).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(isClaudeStyleMessages([])).toBe(false);
  });

  it('detects tool_result content blocks', () => {
    const input = [
      {
        role: 'user',
        content: [
          {
            type: ClaudeContentBlockType.ToolResult,
            tool_use_id: 'x',
            content: 'ok',
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(true);
  });

  it('detects image blocks with a source', () => {
    const input = [
      {
        role: 'user',
        content: [
          {
            type: ClaudeContentBlockType.Image,
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'abc',
            },
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(true);
  });

  it('rejects image blocks without a source object', () => {
    const noSource = [
      {
        role: 'user',
        content: [
          {
            type: ClaudeContentBlockType.Image,
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(noSource)).toBe(false);

    const nonObjectSource = [
      {
        role: 'user',
        content: [
          {
            type: ClaudeContentBlockType.Image,
            source: 'base64',
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(nonObjectSource)).toBe(false);
  });

  it('detects tool_use blocks with a string id', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          {
            type: ClaudeContentBlockType.ToolUse,
            id: 'toolu_1',
            name: 'x',
            input: {},
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(true);
  });

  it('rejects tool_use blocks with a non-string id', () => {
    const input = [
      {
        role: 'assistant',
        content: [
          {
            type: ClaudeContentBlockType.ToolUse,
            id: 123,
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(false);
  });

  it('returns false for plain OpenAI-style string content', () => {
    const input = [
      {
        role: 'user',
        content: 'hello',
      },
      {
        role: 'assistant',
        content: 'hi there',
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(false);
  });

  it('returns false when any message has a non-Claude role', () => {
    const input = [
      {
        role: 'system',
        content: [
          {
            type: ClaudeContentBlockType.ToolResult,
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(false);

    expect(
      isClaudeStyleMessages([
        {
          role: 'developer',
          content: [
            {
              type: ClaudeContentBlockType.ToolResult,
            },
          ],
        },
      ]),
    ).toBe(false);

    expect(
      isClaudeStyleMessages([
        {
          role: 'tool',
          content: [
            {
              type: ClaudeContentBlockType.Image,
              source: {},
            },
          ],
        },
      ]),
    ).toBe(false);
  });

  it('skips non-record entries and messages without a role', () => {
    const input = [
      'not-a-message',
      {
        content: [
          {
            type: ClaudeContentBlockType.ToolResult,
          },
        ],
      }, // no role
      {
        role: 'user',
        content: [
          {
            type: ClaudeContentBlockType.ToolResult,
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(true);
  });

  it('skips messages that carry a top-level type (responses-style items)', () => {
    const input = [
      {
        role: 'user',
        type: 'message',
        content: [
          {
            type: ClaudeContentBlockType.ToolResult,
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(false);
  });

  it('returns false when content blocks are all plain text', () => {
    const input = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hello',
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(false);
  });

  it('ignores non-record blocks inside content arrays', () => {
    const input = [
      {
        role: 'user',
        content: [
          'just-a-string',
          null,
          42,
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(false);
  });

  it('detects Claude blocks in later messages even if earlier ones are plain', () => {
    const input = [
      {
        role: 'user',
        content: 'hello',
      },
      {
        role: 'assistant',
        content: [
          {
            type: ClaudeContentBlockType.ToolUse,
            id: 'toolu_9',
            name: 'x',
            input: {},
          },
        ],
      },
    ];
    expect(isClaudeStyleMessages(input)).toBe(true);
  });
});

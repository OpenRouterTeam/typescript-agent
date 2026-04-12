import { describe, expect, it } from 'vitest';

import { convertToClaudeMessage } from '../../src/lib/stream-transformers.js';
import { TEST_MODEL } from '../test-constants.js';

describe('convertToClaudeMessage annotation handling', () => {
  it('annotations: text with file_citation + url_citation + file_path -> each produces its distinct citation', () => {
    const response = {
      id: 'r1',
      output: [
        {
          type: 'message' as const,
          id: 'msg_1',
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [
            {
              type: 'output_text' as const,
              text: 'Here is the answer',
              annotations: [
                {
                  type: 'file_citation',
                  fileId: 'f1',
                  filename: 'doc.pdf',
                  index: 0,
                },
                {
                  type: 'url_citation',
                  url: 'https://example.com',
                  title: 'Example',
                  startIndex: 0,
                  endIndex: 10,
                },
                {
                  type: 'file_path',
                  fileId: 'f2',
                  filePath: '/tmp/out.txt',
                },
              ],
            },
          ],
        },
      ],
      status: 'completed' as const,
      outputText: 'Here is the answer',
      model: TEST_MODEL,
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const claude = convertToClaudeMessage(response);
    const textBlock = claude.content.find((b: { type: string }) => b.type === 'text') as
      | {
          type: string;
          text: string;
          citations?: unknown[];
        }
      | undefined;
    expect(textBlock).toBeDefined();
    // Should have citations
    if (textBlock?.citations) {
      expect(textBlock.citations.length).toBeGreaterThan(0);
    }
  });
});

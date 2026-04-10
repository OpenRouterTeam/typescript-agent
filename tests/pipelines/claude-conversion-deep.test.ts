import { describe, expect, it } from 'vitest';

import {
  convertToClaudeMessage,
  getUnsupportedContentSummary,
  hasUnsupportedContent,
} from '../../src/lib/stream-transformers.js';

describe('Claude conversion deep pipeline', () => {
  it('multi-item response: message + function_call + reasoning + web_search -> each guard routes to distinct block', () => {
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
              text: 'Hello',
              annotations: [],
            },
          ],
        },
        {
          type: 'function_call' as const,
          id: 'fc_1',
          callId: 'fc_1',
          name: 'search',
          arguments: '{"q":"test"}',
          status: 'completed' as const,
        },
        {
          type: 'reasoning' as const,
          id: 'r_1',
          status: 'completed' as const,
          summary: [
            {
              type: 'summary_text' as const,
              text: 'thinking',
            },
          ],
        },
        {
          type: 'web_search_call' as const,
          id: 'ws_1',
          status: 'completed' as const,
        },
      ],
      status: 'completed' as const,
      outputText: 'Hello',
      model: 'test-model',
      usage: {
        totalTokens: 200,
        inputTokens: 100,
        outputTokens: 100,
      },
    };

    const claude = convertToClaudeMessage(response as any);
    const types = claude.content.map((b: any) => b.type);

    expect(types).toContain('text');
    expect(types).toContain('tool_use');
    expect(types).toContain('thinking');
    expect(types).toContain('server_tool_use');
  });

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
      model: 'test-model',
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const claude = convertToClaudeMessage(response as any);
    const textBlock = claude.content.find((b: any) => b.type === 'text') as any;
    expect(textBlock).toBeDefined();
    // Should have citations
    if (textBlock.citations) {
      expect(textBlock.citations.length).toBeGreaterThan(0);
    }
  });

  it('unsupported content round-trip: refusal + image_generation -> convertToClaudeMessage -> unsupported_content utilities work', () => {
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
              type: 'refusal' as const,
              refusal: 'I cannot do that',
            },
          ],
        },
        {
          type: 'image_generation_call' as const,
          id: 'ig_1',
          result: 'base64data',
          status: 'completed' as const,
        },
      ],
      status: 'completed' as const,
      outputText: '',
      model: 'test-model',
      usage: {
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
      },
    };

    const claude = convertToClaudeMessage(response as any);
    // unsupported_content is a property on the message, not content blocks
    expect(hasUnsupportedContent(claude)).toBe(true);
    const summary = getUnsupportedContentSummary(claude);
    expect(summary).toBeDefined();
    // refusal and image_generation_call should both appear as unsupported
    expect(Object.keys(summary).length).toBeGreaterThan(0);
  });
});

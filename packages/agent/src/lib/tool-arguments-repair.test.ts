import { describe, expect, it } from 'vitest';

import { parseToolCallArgumentsLenient } from './tool-arguments-repair.js';

describe('parseToolCallArgumentsLenient', () => {
  describe('well-formed input', () => {
    it('parses valid JSON without repair', () => {
      const result = parseToolCallArgumentsLenient('{"action": {"commands": ["ls"]}}');
      expect(result).toEqual({
        status: 'parsed',
        value: {
          action: {
            commands: [
              'ls',
            ],
          },
        },
      });
    });

    it('treats empty and whitespace-only input as an empty object', () => {
      expect(parseToolCallArgumentsLenient('')).toEqual({
        status: 'parsed',
        value: {},
      });
      expect(parseToolCallArgumentsLenient('  \n ')).toEqual({
        status: 'parsed',
        value: {},
      });
    });
  });

  describe('XML scaffold leak (Claude family)', () => {
    // Verbatim shape from production: model starts JSON, slips into its
    // internal <parameter> scaffolding.
    it('recovers a single-parameter scaffold with a JSON prefix key', () => {
      const raw = '{"action": \n<parameter name="commands">["mkdir -p /tmp/app"]}';
      const result = parseToolCallArgumentsLenient(raw);
      expect(result).toEqual({
        status: 'repaired',
        strategy: 'xml-scaffold',
        value: {
          action: {
            commands: [
              'mkdir -p /tmp/app',
            ],
          },
        },
      });
    });

    it('recovers multiple parameters including numbers', () => {
      const raw =
        '{"action": \n<parameter name="commands">["ls -la", "cat /tmp/x"]</parameter>\n<parameter name="timeout_ms">30000</parameter>}';
      const result = parseToolCallArgumentsLenient(raw);
      expect(result).toEqual({
        status: 'repaired',
        strategy: 'xml-scaffold',
        value: {
          action: {
            commands: [
              'ls -la',
              'cat /tmp/x',
            ],
            timeout_ms: 30000,
          },
        },
      });
    });

    it('recovers the `<parameter=name>` spelling without a prefix key', () => {
      const raw = '<parameter=commands>\n["echo hi"]';
      const result = parseToolCallArgumentsLenient(raw);
      expect(result).toEqual({
        status: 'repaired',
        strategy: 'xml-scaffold',
        value: {
          commands: [
            'echo hi',
          ],
        },
      });
    });

    it('recovers a scaffold whose command content itself contains XML', () => {
      const raw =
        '{"action": \n<parameter name="commands">["cat << \'XEOF\' > /tmp/cfg/characters.xml\\n<?xml version=\\"1.0\\"?>\\n<characters>\\n<character id=\\"1\\"></character>\\n</characters>\\nXEOF"]}';
      const result = parseToolCallArgumentsLenient(raw);
      expect(result.status).toBe('repaired');
      if (result.status !== 'repaired') {
        return;
      }
      const action = (
        result.value as {
          action: {
            commands: string[];
          };
        }
      ).action;
      expect(action.commands).toHaveLength(1);
      expect(action.commands[0]).toContain('<?xml version="1.0"?>');
    });
  });

  describe('unrecoverable input', () => {
    it('reports unparseable for a lone opening brace', () => {
      expect(parseToolCallArgumentsLenient('{')).toEqual({
        status: 'unparseable',
      });
    });

    it('reports unparseable for non-JSON prose', () => {
      expect(parseToolCallArgumentsLenient('I will now run the command.')).toEqual({
        status: 'unparseable',
      });
    });

    it('reports unparseable for a scaffold with an empty parameter body', () => {
      expect(parseToolCallArgumentsLenient('{"action": <parameter name="commands">')).toEqual({
        status: 'unparseable',
      });
    });
  });
});

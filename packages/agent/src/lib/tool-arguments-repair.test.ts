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

  describe('valid-prefix repair (corrupted long payloads)', () => {
    it('recovers a payload spliced with re-escaped duplicate content mid-value', () => {
      // Shape from a live capture: valid JSON through the commands array and
      // `"timeout_ms": 30000`, then garbage spliced in mid-number of the
      // next field. The commands array must survive; the number being cut
      // mid-digits must NOT be recovered as a wrong value.
      const raw =
        '{"action": {"commands": ["cat << EOF > /tmp/x\\nhello\\nEOF"], "timeout_ms": 30000, "max_output_length": 200-- spliced duplicate \\\\n<!-- garbage --> {\\"commands\\"';
      const result = parseToolCallArgumentsLenient(raw);
      expect(result.status).toBe('repaired');
      if (result.status !== 'repaired') {
        return;
      }
      expect(result.strategy).toBe('valid-prefix');
      const action = (
        result.value as {
          action: Record<string, unknown>;
        }
      ).action;
      expect(action['commands']).toEqual([
        'cat << EOF > /tmp/x\nhello\nEOF',
      ]);
      expect(action['timeout_ms']).toBe(30000);
      // Cut candidates exclude digits, so the corrupted field is dropped
      // rather than repaired to a truncated number.
      expect(action['max_output_length']).toBeUndefined();
    });

    it('drops an unterminated trailing string instead of executing half of it', () => {
      const raw = '{"action": {"commands": ["echo complete", "rm -rf /tmp/scratch/some/deep/pa';
      const result = parseToolCallArgumentsLenient(raw);
      expect(result).toEqual({
        status: 'repaired',
        strategy: 'valid-prefix',
        value: {
          action: {
            commands: [
              'echo complete',
            ],
          },
        },
      });
    });

    it('recovers a payload truncated right after a boolean literal', () => {
      const raw = '{"flag": true, "commands": ["ls"], "stream": false';
      const result = parseToolCallArgumentsLenient(raw);
      expect(result).toEqual({
        status: 'repaired',
        strategy: 'valid-prefix',
        value: {
          flag: true,
          commands: [
            'ls',
          ],
          stream: false,
        },
      });
    });

    it('does not cut inside string content that contains braces and quotes', () => {
      const raw =
        '{"action": {"commands": ["python3 -c \\"print({\'a\': [1,2]})\\"", "echo done"]}, "broken": "unterminat';
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
      expect(action.commands).toEqual([
        'python3 -c "print({\'a\': [1,2]})"',
        'echo done',
      ]);
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

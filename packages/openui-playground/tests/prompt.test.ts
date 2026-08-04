import { createLibrary, defineComponent } from '@openrouter/agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { libraryPrompt } from '../src/lang/prompt.js';

/*
 * The prompt is the only place the model learns a prop's legal values. An enum
 * serializes as `{type: 'string', enum: [...]}`, so a `type`-first check labels
 * it a bare `string` and every enum prop's values stay invisible.
 */
describe('libraryPrompt enum props', () => {
  const library = createLibrary([
    defineComponent({
      name: 'Badge',
      props: z.object({
        tone: z.enum([
          'info',
          'warn',
          'danger',
        ]),
        label: z.string(),
      }),
    }),
  ]);

  it('lists an enum prop’s valid values instead of "string"', () => {
    const prompt = libraryPrompt(library);
    expect(prompt).toContain('tone: "info" | "warn" | "danger"');
  });

  it('still labels non-enum props by type', () => {
    expect(libraryPrompt(library)).toContain('label: string');
  });
});

/**
 * The playground's demo component library — a small but representative
 * vocabulary (layout, text, data display, inputs, actions) that exercises
 * positional props, optional props, enums, arrays, and nesting. The client
 * renderer in public/app.js implements exactly these components; keep the
 * two in sync.
 */
import { createLibrary, defineComponent } from '@openrouter/agent';
import { z } from 'zod/v4';

export const demoLibrary = createLibrary([
  defineComponent({
    name: 'Stack',
    description: 'Layout container. direction defaults to "column".',
    props: z.object({
      children: z.array(z.unknown()),
      direction: z
        .enum([
          'row',
          'column',
        ])
        .optional(),
      gap: z.number().optional(),
    }),
  }),
  defineComponent({
    name: 'Card',
    description: 'Bordered container with an optional title.',
    props: z.object({
      title: z.string().optional(),
      children: z.array(z.unknown()).optional(),
    }),
  }),
  defineComponent({
    name: 'Heading',
    description: 'Section heading. level 1-3, defaults to 2.',
    props: z.object({
      text: z.string(),
      level: z.number().optional(),
    }),
  }),
  defineComponent({
    name: 'Text',
    description: 'A paragraph of body text.',
    props: z.object({
      value: z.string(),
      muted: z.boolean().optional(),
    }),
  }),
  defineComponent({
    name: 'Stat',
    description: 'A labeled metric (big value, small label, optional delta like "+12%").',
    props: z.object({
      label: z.string(),
      value: z.string(),
      delta: z.string().optional(),
    }),
  }),
  defineComponent({
    name: 'Badge',
    description: 'Small status pill.',
    props: z.object({
      text: z.string(),
      tone: z
        .enum([
          'neutral',
          'success',
          'warning',
          'danger',
        ])
        .optional(),
    }),
  }),
  defineComponent({
    name: 'Table',
    description:
      'Data table. columns is an array of header strings; rows is an array of arrays of cell strings.',
    props: z.object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    }),
  }),
  defineComponent({
    name: 'Input',
    description: 'Single-line text input. Pass a $state ref as value to two-way bind.',
    props: z.object({
      name: z.string(),
      value: z.unknown().optional(),
      placeholder: z.string().optional(),
    }),
  }),
  defineComponent({
    name: 'Select',
    description: 'Dropdown. Pass a $state ref as value to two-way bind.',
    props: z.object({
      name: z.string(),
      options: z.array(z.string()),
      value: z.unknown().optional(),
    }),
  }),
  defineComponent({
    name: 'Button',
    description: 'Action button. action is an Action(...) block.',
    props: z.object({
      label: z.string(),
      action: z.unknown().optional(),
      variant: z
        .enum([
          'primary',
          'secondary',
          'danger',
        ])
        .optional(),
    }),
  }),
  defineComponent({
    name: 'Progress',
    description: 'Progress bar, value 0-100.',
    props: z.object({
      value: z.number(),
      label: z.string().optional(),
    }),
  }),
]);

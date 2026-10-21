import { z } from 'zod/v4';
import { tool } from '../../src/lib/tool.js';

const manualTool = tool({
  name: 'manual_wire_schema',
  inputSchema: z.object({
    value: z.string(),
  }),
  wireInputSchema: {
    type: 'object',
    properties: {
      value: {
        type: 'string',
      },
    },
  },
  execute: false,
});
void manualTool;

// @ts-expect-error wireInputSchema is only accepted for manual tools
tool({
  name: 'executable_wire_schema',
  inputSchema: z.object({
    value: z.string(),
  }),
  execute: () => 'done',
  wireInputSchema: {
    type: 'object',
  },
});

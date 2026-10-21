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

// Since Standard Schema support, every tool kind accepts wireInputSchema.
const executableTool = tool({
  name: 'executable_wire_schema',
  inputSchema: z.object({
    value: z.string(),
  }),
  execute: () => 'done',
  wireInputSchema: {
    type: 'object',
  },
});
void executableTool;

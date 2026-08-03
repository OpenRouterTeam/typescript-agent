---
'@openrouter/agent': minor
---

OpenUI bindings: a component-library model (`defineComponent`, `createLibrary`, `componentProps`), a typed fragment builder (`fragment`, `uiRef`, `uiState`, `uiBuiltin`), the `openui` plugin helper, `serializeExpr`/`OPENUI_LANG_DIALECT` for emitting OpenUI Lang, a `toUIOutput` tool option that renders a tool's result as UI, and `ModelResult.getUiStream()` for consuming fragments as they arrive.

A tool declares how its output renders, and the caller streams the fragments:

```ts
import {
  callModel,
  createLibrary,
  defineComponent,
  fragment,
  openui,
  tool,
} from '@openrouter/agent';
import { z } from 'zod/v4';

const library = createLibrary([
  defineComponent({
    name: 'Card',
    description: 'Container with a title',
    props: z.object({
      title: z.string(),
      children: z.array(z.unknown()).optional(),
    }),
  }),
  defineComponent({
    name: 'Text',
    props: z.object({
      value: z.string(),
    }),
  }),
]);

const ui = fragment(library);

const weather = tool({
  name: 'weather',
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    summary: z.string(),
  }),
  execute: ({ city }) => ({
    summary: `Clear in ${city}`,
  }),
  // Renders the tool's result instead of leaving the model to describe it.
  toUIOutput: ({ input, output }) =>
    ui.Card(input.city, [
      ui.Text(output.summary),
    ]),
});

const result = callModel(client, {
  model: 'anthropic/claude-sonnet-4.5',
  input: 'What is the weather in Lisbon?',
  tools: [
    weather,
  ],
  plugins: [
    // `as never` until the SDK regen adds `openui` to its plugin union; the
    // wire shape is already accepted by the API.
    openui(library) as never,
  ],
});

for await (const event of result.getUiStream()) {
  if (event.type === 'fragment') {
    // source: 'root = Card("Lisbon", [Text("Clear in Lisbon")])'
    console.log(event.source);
  }
}
```

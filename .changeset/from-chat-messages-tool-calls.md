---
'@openrouter/agent': minor
---

Fix `fromChatMessages` dropping assistant tool calls and give both message converters precise array return types that work with `callModel`, `Item[]`, and the SDK's `InputsUnion`.

Assistant `toolCalls` now become `function_call` items, preserving their already-serialized `arguments`. A message containing both text and tool calls emits both items; an empty assistant message is omitted only when tool calls replace it.

```ts
import { callModel, fromChatMessages, type ChatMessages, type Item } from '@openrouter/agent';

const messages: ChatMessages[] = [
  {
    role: 'assistant',
    content: null,
    toolCalls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Austin"}' },
      },
    ],
  },
];

const input: Item[] = fromChatMessages(messages);
const result = callModel(client, { model: 'openai/gpt-4o-mini', input });
```

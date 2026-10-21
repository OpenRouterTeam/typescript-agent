---
'@openrouter/agent': minor
---

`serverTool()` results now assign to bare `ServerTool` and to mixed `Array<ClientTool | ServerTool>` arrays without a cast. Before this change, `ServerTool<'openrouter:datetime'>` was not assignable to `ServerTool` (= `ServerTool<ServerToolType>`), because `config: Extract<ServerToolConfig, { type: T }>` made the interface invariant over `T`.

```ts
import { serverTool, tool, type ClientTool, type ServerTool } from '@openrouter/agent';

const datetime: ServerTool = serverTool({ type: 'openrouter:datetime' }); // no cast
const tools: Array<ClientTool | ServerTool> = [saveNote, datetime];
```

**Breaking (type-level only, no runtime change):** `ServerTool` is now a conditional type alias rather than an interface.

- Bare `ServerTool` (no type argument) is now exactly `ServerToolBase`. It drops the required literal `id` (`` `server:${ServerToolType}` ``), so `id` becomes optional `string`. It also stops being the generic interface whose `config` follows `T`, so code that relied on `ServerTool`'s generic shape (for example `S extends ServerTool<infer K>`) must infer from `config.type` instead.
- Declaration merging (`interface ServerTool { ... }` augmentation) no longer works, because type aliases can't be merged.

Migration:

- To keep a narrowed `config` or a required literal `id`, pass the type argument: `ServerTool<'openrouter:web_search'>`, or use `ReturnType<typeof serverTool<'openrouter:web_search'>>`. `ServerTool<T>` and `ServerTool<T, TId>` work as before.
- If you augmented `ServerTool` with declaration merging, augment `ServerToolBase` instead (it is still an interface).
- Replace `S extends ServerTool<infer K>` with `S extends { readonly config: { readonly type: infer K } }`.

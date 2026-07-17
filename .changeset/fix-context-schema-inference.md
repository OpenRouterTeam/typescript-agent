---
"@openrouter/agent": patch
---

Infer tool context types from `contextSchema` end-to-end: `tool()` now preserves the concrete Zod schema through its overloads, so `execute`'s `ctx.local` is typed from the schema and `callModel`'s `context` map slots accept/reject the real per-tool shape — no more `ctx.local as X` or `context: map as any`. Tools without a `contextSchema` still resolve their map slot to `Record<string, never>`. Types-only; runtime behavior unchanged.

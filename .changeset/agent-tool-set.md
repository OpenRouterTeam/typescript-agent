---
"@openrouter/agent-tool-set": minor
"@openrouter/agent": minor
---

Add `@openrouter/agent-tool-set` (port of ai-tool-set v1.0.0, MIT © zirkelc): declarative activate / deactivate / activateWhen / deactivateWhen for tools with state- and context-aware predicates. Integrates with a new `activeTools?: readonly string[]` option on `callModel` that filters which tools are sent to the model for a given call.

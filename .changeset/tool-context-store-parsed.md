---
"@openrouter/agent": patch
---

`setContext` and `setSharedContext` now store the schema's parsed output for each updated field, so field transforms, defaults and coercions apply to stored context, and they validate the merged context against the full schema before storing it, so object-level refinements are enforced at write time. An update that fails validation throws and leaves the stored context unchanged.

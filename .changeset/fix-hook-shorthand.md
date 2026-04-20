---
'@openrouter/agent': patch
---

Fix `hooks` constructor option silently no-oping when a plain hook object (e.g. `{ beforeRequest: ... }`) was passed: the underlying SDK only honors `hooks` when it is an `SDKHooks` instance, and the previous wrapper forwarded the plain object unchanged.

`new OpenRouter({ hooks })` now accepts any of:

- an `SDKHooks` instance (used as-is),
- a single hook object (`BeforeRequestHook`, `AfterSuccessHook`, etc.), or
- an array of hook objects.

Shorthand inputs are normalized into an `SDKHooks` instance before handoff. Hook types (`BeforeRequestHook`, `BeforeRequestContext`, `AfterSuccessHook`, `SDKHooks`, etc.) are now re-exported from the package entry point.

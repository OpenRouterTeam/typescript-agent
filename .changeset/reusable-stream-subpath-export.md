---
"@openrouter/agent": patch
---

Add a `./reusable-stream` subpath export so consumers can import `ReusableReadableStream` directly (`@openrouter/agent/reusable-stream`) instead of going through the root barrel or patching the package. Mirrors the existing `./tool-event-broadcaster` entry; both replay classes are the units consumers need when asserting stream-retention behavior against the published package.

---
"@openrouter/agent": patch
---

Remove the runtime `@openrouter/sdk/models` import from `turn-context.ts`. The namespace import existed only to read `EasyInputMessageRoleUser.User` (the string `'user'`), but it made every consumer that statically imports `@openrouter/agent/tool` (via `agent-tool` → `conversation-state` → `turn-context`) evaluate the entire Speakeasy models barrel — hundreds of modules of top-level Zod schema construction — at module load. On Cloudflare Workers this added ~200ms of startup CPU per worker and pushed large workers past the 1s script-validation ceiling (error 10021).

The import is now type-only (erased at compile time) and the role literal is inlined, keeping behavior identical. A new unit test walks the static runtime import graph of the hot subpaths (`/tool`, `/tool-types`, `/stop-conditions`) and fails if any of them ever reaches `@openrouter/sdk` at runtime again.

---
'@openrouter/mcp': patch
---

Generate the `clientInfo` version from `package.json` instead of hardcoding it. `build`
regenerates `src/version.ts`, and a unit test fails if the committed value drifts, so the
version reported to MCP servers cannot go stale across a release.

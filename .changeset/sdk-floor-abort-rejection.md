---
'@openrouter/agent': patch
---

Raise the `@openrouter/sdk` floor to `^0.13.59`. That release fixes an unhandled promise rejection raised when a request is aborted while the SDK is still reading a non-streamed response body (OpenRouterTeam/typescript-sdk#350). Each aborted `callModel` run used to emit one stray `unhandledRejection`, which can crash Node processes running with `--unhandled-rejections=strict`.

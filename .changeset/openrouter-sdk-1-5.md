---
'@openrouter/agent': minor
---

Upgrade `@openrouter/sdk` from `^0.13.7` to `^1.5.85`.

The SDK renamed the code-interpreter image output type to `CodeInterpreterImageOutput`. It is re-exported under that name, and the existing `OutputImage` and `OutputInputImage` exports remain as aliases of it.

`BaseInputsUnion` no longer includes `any` in the SDK, so it now describes only the `instructions` field it is used for. Functions that took or returned a single input item typed as `BaseInputsUnion` (`appendToMessages`, `normalizeInputToArray`, `buildTaskResultMessage`) are typed with the SDK's `InputsUnion1` instead.

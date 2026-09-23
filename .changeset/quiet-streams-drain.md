---
'@openrouter/agent': patch
---

Fix two run-teardown races found by TLA+ model checking. `ReusableReadableStream.createConsumer()` called while `cancel()` is awaiting the source reader now yields an already-done consumer instead of one that reads a cleared buffer slot and throws. `onRunEnd: 'drain'` now persists and broadcasts (`delivery: 'dropped'`) a background task settlement that lands during the final drain turn, where it was previously left unharvested with the persisted task still `working`.

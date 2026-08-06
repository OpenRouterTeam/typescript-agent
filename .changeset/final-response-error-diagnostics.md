---
'@openrouter/agent': patch
---

Clarify the `validateFinalResponse` error messages so an empty final turn can't be misread as "validation rejected my tool call" (issue #45).

`Invalid final response: empty or invalid output` now names the actual defect: `output array is empty (length 0) for response "<id>"` — with the response id and a pointer to the `strictFinalResponse`/`allowFinalResponse` options — versus `output is not an array (got <type>)` when the payload is malformed. `Invalid final response: missing required fields` now lists which fields were absent (`id`, `output`, or both).

Diagnostics only — no behavior change. Validation remains a pure array-length check, so tool-call-only output still passes (it always did; that was the misdiagnosis in #45). Both historical message prefixes are unchanged, so any matcher on them keeps working.

---
'@openrouter/agent': patch
---

`allowFinalResponse: true` now appends a built-in final-answer directive (exported as `DEFAULT_FINAL_RESPONSE_DIRECTIVE`) as the final user message on the forced no-tools turn. Previously bare `true` stripped tools but gave the model no signal that this was its last turn, so models that emit tool-call syntax as text (e.g. GLM) would attempt another tool call and leak unparsed `<tool_call>…` text into the final content (DEV-658). A non-empty string still overrides the directive wording; pass `''` to append no message (the previous bare-`true` behavior).

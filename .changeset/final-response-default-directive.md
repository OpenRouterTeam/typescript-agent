---
'@openrouter/agent': minor
---

The forced final turn after `stopWhen` halts mid-tool-call is now **on by default** and uses `toolChoice: 'none'` instead of stripping `tools` (stripping busted the prompt-cache prefix). It appends a built-in final-answer directive (exported as `DEFAULT_FINAL_RESPONSE_DIRECTIVE`) as the final user message. Previously the final turn required opting in via `allowFinalResponse`, stripped the tools block, and bare `true` appended no directive — models that emit tool-call syntax as text (e.g. GLM) would attempt another tool call and leak unparsed `<tool_call>…` text into the final content (DEV-658).

```ts
callModel(client, {
  model: 'z-ai/glm-5.2',
  input: 'Research this step by step.',
  tools: [searchTool],
  stopWhen: stepCountIs(3),
  // was: no final turn unless allowFinalResponse was set; bare `true`
  //      stripped tools (cache-busting) and appended no directive, so
  //      GLM-style models could leak raw `<tool_call>…` as the answer
  // now: default-on final turn with toolChoice:'none' (tools kept, cache
  //      preserved) + DEFAULT_FINAL_RESPONSE_DIRECTIVE user message

  // custom wording still overrides the default:
  // allowFinalResponse: 'Summarize what you found.',
  // append no message (turn still happens):
  // allowFinalResponse: '',
  // restore the old opt-out (no final turn, run ends on the tool-call turn):
  // allowFinalResponse: false,
});
```

Note: runs that previously ended on a halted tool-call turn now make one additional model request by default. Pass `allowFinalResponse: false` to keep the old behavior.

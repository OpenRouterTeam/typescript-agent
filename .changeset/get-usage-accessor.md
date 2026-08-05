---
'@openrouter/agent': minor
---

New `ModelResult.getUsage()` accessor: aggregate token/cost usage across every model call a run made.

```ts
const result = callModel(client, { model, input, tools });

for await (const item of result.getItemsStream()) {
  render(item);
}

// new: aggregate totals across EVERY round of the tool loop
const usage = await result.getUsage();
console.log(usage.modelCalls, usage.totalTokens, usage.cost);

// was (and still is): the FINAL round's response only
const response = await result.getResponse();
console.log(response.usage?.totalTokens);
```

`getResponse()` resolves to the *final* round's response, so in a multi-round tool loop the tokens spent on the intermediate `tool_calls` generations were unreachable — and `getItemsStream()` carries output items only, never surfacing the `response.completed` events that hold each round's usage block. Callers streaming items therefore had no way to account for a run's real token spend without registering a hook.

`await result.getUsage()` returns the same `SessionUsageTotals` shape as the `SessionEnd` hook's `totalUsage` (`modelCalls`, `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`, and `cost` when the server reported it), summed over the initial request, each tool-round follow-up, the empty-final retry, the `allowFinalResponse` final turn, and approval-resume requests. It gates on run completion like `getResponse()` does, so totals are final whether awaited directly, after `getResponse()`, or after draining any streaming getter — including `getItemsStream()` (on an approval-resumed run, reading usage never advances the tool loop; await `getResponse()`/`getText()` first for final totals there). Unlike `getResponse()` it never rejects (a failed run still consumed tokens), returning the totals accrued so far.

The usage aggregate is now accumulated independently of the hook system, so it is correct for callers who configured no hooks at all; previously it only advanced as a side effect of `PostModelCall` emission. `SessionEnd.totalUsage` and `getUsage()` read from one snapshot helper and cannot drift.

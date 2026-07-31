# @openrouter/openui-playground

Local webapp to **test, bench, and eval** OpenUI generative-UI support in the
Agent SDK (DEV-773 / DEV-765).

```bash
OPENROUTER_API_KEY=sk-... pnpm --filter @openrouter/openui-playground dev
# → http://localhost:5170
```

## What it does

- Sends your prompt to a model via `callModel()` with the demo component
  library (Stack/Card/Heading/Text/Stat/Badge/Table/Input/Select/Button/Progress).
- **Progressively renders** the generated UI as OpenUI Lang statements complete
  — statement by statement, mid-stream.
- Shows the raw model text, the parsed OpenUI Lang stream, parse/validation
  diagnostics, and per-run bench stats (TTFB, first-statement latency, total
  time, statement count, token usage, cost) with a session history table for
  comparing models and prompts.

## Modes

| Mode | What happens | Status |
|---|---|---|
| `emulate` (default) | The playground injects the library prompt locally and runs the reference streaming parser over the model's text stream — emulating what the API's `openui` plugin will do server-side (DEV-771). | Works today |
| `native` | Sends the `openui(library)` plugin preference and consumes `ModelResult.getUiStream()`. | Blocked on DEV-771/DEV-772; the API rejects the unknown plugin id until then |

The two modes emit the same event shapes, so once native lands you can A/B the
paths in the history table with zero client changes.

## Env

- `OPENROUTER_API_KEY` (required)
- `PORT` (default `5170`)
- `OPENUI_PLAYGROUND_MODEL` (default `anthropic/claude-sonnet-5`)

## Layout

- `src/lang/parser.ts` — reference incremental OpenUI Lang parser (the same
  logic DEV-770 ports into openrouter-web; conformance tests in `tests/`)
- `src/lang/prompt.ts` — library → system prompt (mirror of the API's injection)
- `src/demo-library.ts` — the component vocabulary (keep `public/app.js` renderer in sync)
- `src/generate.ts` — one generation run → normalized SSE event stream + stats
- `src/server.ts` — plain `node:http` server; no build step
- `public/` — static client: progressive renderer, Lang stream, bench panels

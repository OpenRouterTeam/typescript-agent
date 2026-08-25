---
'@openrouter/agent': patch
---

Identify Agent SDK requests with an Agent SDK user-agent suffix that includes the package version.

```ts
import { OpenRouter } from '@openrouter/agent';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
// Requests use the Agent SDK user agent by default.
// Pass userAgent to override the default identification.
```

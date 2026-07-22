# @openrouter/agent-tool-set

Declarative, state-aware activation and deactivation for tools used with `@openrouter/agent`.

Port of [`ai-tool-set`](https://github.com/zirkelc/ai-tool-set) (MIT © Chris Cook), adapted for this SDK's ordered `Tool[]` / `callModel` model. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## What it adds

- **Stable tool-set IDs** for every addressable tool:
  - client tools → `function.name`
  - server tools → `server:${config.type}` by default (overridable via `serverTool(config, { id })`)
- A **typed three-way partition** of those IDs: definitely enabled, definitely disabled, conditional.
- **Exhaustive runtime snapshots** from `resolve()` / `resolveSituation()` — every ID appears in `statusByTool`.
- **Named declarative situations** with compile-time exact tool tuples when the situation is fully static.
- Integration with `callModel`'s `activeTools` option via the snapshot's spread-safe `.callModel` input.

## Install

```bash
pnpm add @openrouter/agent-tool-set
```

## Usage

```ts
import { OpenRouter, tool, serverTool, callModel } from '@openrouter/agent';
import {
  createToolSet,
  type InferEnabledIds,
  type InferDisabledIds,
  type InferConditionalIds,
  type InferAllIds,
} from '@openrouter/agent-tool-set';
import { z } from 'zod/v4';

type AppContext = {
  isAuthenticated: boolean;
  isAdmin: boolean;
};

const listOrders = tool({
  name: 'list_orders',
  inputSchema: z.object({}),
  execute: async () => ({ orders: [] }),
});

const cancelOrder = tool({
  name: 'cancel_order',
  inputSchema: z.object({ id: z.string() }),
  execute: async () => ({ ok: true }),
});

const login = tool({
  name: 'login',
  inputSchema: z.object({}),
  execute: async () => ({ token: '…' }),
});

const webSearch = serverTool({ type: 'web_search_2025_08_26' });
// id defaults to 'server:web_search_2025_08_26'

const allTools = [listOrders, cancelOrder, login, webSearch] as const;

const toolSet = createToolSet<typeof allTools, AppContext>({ tools: allTools })
  .deactivate('cancel_order')
  .activateWhen('list_orders', ({ context }) => context?.isAuthenticated === true)
  .defineSituations({
    guest: {
      enabled: ['login', 'server:web_search_2025_08_26'],
      disabled: ['list_orders', 'cancel_order'],
    },
    authenticated: {
      enabled: ['list_orders', 'server:web_search_2025_08_26'],
      disabled: ['login'],
      conditional: {
        cancel_order: ({ context }) => context?.isAdmin === true,
      },
    },
  });

// Compile-time partition of the *base* set (before a situation overlay):
type All = InferAllIds<typeof toolSet>;
// 'list_orders' | 'cancel_order' | 'login' | 'server:web_search_2025_08_26'
type Enabled = InferEnabledIds<typeof toolSet>; // excludes cancel_order + list_orders (conditional)
type Disabled = InferDisabledIds<typeof toolSet>; // 'cancel_order'
type Conditional = InferConditionalIds<typeof toolSet>; // 'list_orders'

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

// Named static situation → exact tool tuple at compile time
const guest = toolSet.resolveSituation('guest');
// guest.tools is exactly [login, webSearch]
// guest.enabled / guest.disabled / guest.statusByTool are exhaustive

const authenticated = toolSet.resolveSituation('authenticated', {
  context: { isAuthenticated: true, isAdmin: false },
});

const result = callModel(client, {
  model: 'openai/gpt-4o-mini',
  input: 'List my orders.',
  ...authenticated.callModel,
});
```

## Identity

| Kind | Tool-set ID |
| --- | --- |
| Client `tool({ name: 'x' })` | `'x'` |
| `serverTool({ type: 'web_search_2025_08_26' })` | `'server:web_search_2025_08_26'` |
| `serverTool(config, { id: 'server:public_search' })` | `'server:public_search'` |

Duplicate IDs throw at `createToolSet` construction. Activation methods accept only known IDs.

## Compile-time vs runtime exactness

| Resolution style | Developer-time knowledge | Runtime knowledge |
| --- | --- | --- |
| Static `activate` / `deactivate` | Exact partition | Exact snapshot |
| Named static situation (`enabled`/`disabled` only) | Exact filtered tool tuple | Exact snapshot |
| `activateWhen` / `deactivateWhen` / situation `conditional` | Upper bound (`enabled ∪ conditional`) | Exact snapshot after predicates |
| Mutable `ToolSet` | Partition types may widen | Exact snapshot |

The type system cannot execute predicates. Conditional IDs therefore expand the compile-time upper bound of active tools; after `resolve`, the returned arrays and `statusByTool` are always exhaustive and exact.

## API

### `createToolSet<T, TShared?>({ tools, mutable? })`

Build a set from an ordered tool array. Optional `TShared` types the `context` argument on predicates. Defaults to immutable.

### `.tools`

Concrete tools tuple in construction order (client + server), regardless of activation.

### `.activate(id | id[])` / `.deactivate(id | id[])`

Static flip (last-call-wins). Accepts client names **and** server IDs. Updates the compile-time partition.

### `.activateWhen(id, predicate)` / `.activateWhen({ [id]: predicate })`

Conditional activation — defaults inactive, becomes active when predicate returns `true`. Moves the ID into the conditional partition.

### `.deactivateWhen(id, predicate)` / `.deactivateWhen({ [id]: predicate })`

Conditional deactivation — defaults active, becomes inactive when predicate returns `true`. Also moves the ID into the conditional partition.

Predicate input: `{ state?: ConversationState; context?: TShared }`.

### `.defineSituations({ [name]: config })`

Declarative named situations. Each config may include:

- `enabled?: readonly Id[]` — statically on
- `disabled?: readonly Id[]` — statically off
- `conditional?: { [id]: predicate | { mode?, predicate } }` — runtime rules

Situation overlays the base partition for every ID it mentions; unmentioned IDs keep the base state. Unknown, duplicate, or conflicting IDs within one situation throw.

### `.resolve(input?)` → snapshot

```ts
{
  tools: /* active tools, construction order, concrete types */;
  activeTools: /* active *client* names for callModel */;
  callModel: { tools, activeTools }; // safe to spread into callModel()
  enabled: /* every active ID (client + server) */;
  disabled: /* every inactive ID */;
  statusByTool: {
    [id]: {
      enabled: boolean;
      reason: 'default' | 'activate' | 'deactivate' | 'activateWhen' | 'deactivateWhen' | 'situation';
      directive?: 'activate' | 'deactivate' | 'activateWhen' | 'deactivateWhen';
      predicate?: boolean; // true when a runtime predicate decided the result
    };
  };
}
```

### `.resolveSituation(name, input?)` → snapshot

Same shape as `resolve`, with the named situation overlay applied first.

### `.inferTools(input?)`

Back-compat alias for `resolve`. Prefer `resolve` in new code.

### `.clone({ mutable? })`

Copy state, optionally flipping mode.

### Inference utilities

```ts
type All = InferAllIds<typeof toolSet>;
type Enabled = InferEnabledIds<typeof toolSet>;
type Disabled = InferDisabledIds<typeof toolSet>;
type Conditional = InferConditionalIds<typeof toolSet>;
```

### `InferToolSet<TTools>`

Alias of the agent's `CorrelatedToolEventUnion<TTools>` — name-correlated preliminary/result stream events based on a tools tuple.

## Notes

- Immutable by default (every mutator returns a new `ToolSet` with refined partition types).
- `mutable: true` mutates in place. Partition type parameters may widen for soundness; runtime state is still exact.
- Last-call-wins: each directive on a given ID replaces any prior one for that ID.
- Server tools participate fully in activation once they have an ID. When active they appear in `tools` (and `enabled` / `statusByTool`) but **not** in `activeTools`, which remains the client-name list expected by `callModel`.

# typescript-agent

Monorepo for the OpenRouter TypeScript agent ecosystem.

## Packages

| Package | Path | Description |
| --- | --- | --- |
| [`@openrouter/agent`](./packages/agent) | `packages/agent` | Agent toolkit for building AI applications with OpenRouter — tool orchestration, streaming, multi-turn conversations, and format compatibility. |

## Development

This repo uses [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/) for task orchestration.

```bash
pnpm install          # install all workspace dependencies
pnpm run lint         # Biome check across all packages
pnpm run typecheck    # TypeScript noEmit across all packages
pnpm run build        # tsc across all packages
pnpm run test         # vitest unit projects across all packages
pnpm run test:e2e     # vitest e2e projects (requires OPENROUTER_API_KEY)
```

Turbo caches task results; re-running an unchanged task replays cached output.

## Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets). Each PR that ships a user-visible change should include a changeset:

```bash
pnpm changeset
```

Pick the affected packages and bump type. On merge to `main`, the release workflow opens a "Version Packages" PR. Merging that PR publishes every package with a consumed changeset to npm — no republishing of unchanged packages.

See [`.github/workflows/publish.yaml`](./.github/workflows/publish.yaml) for the full flow.

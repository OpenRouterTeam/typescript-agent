# Changeset Versioning & Release Workflow

## Overview

This repo uses [changesets](https://github.com/changesets/changesets) for version management and changelog generation.

> **Publishing happens automatically on push to `main`.** `.github/workflows/publish.yaml` triggers on both `push: main` and `workflow_dispatch`. On a push with no pending changesets, `changesets/action` publishes any package whose local version is not yet on npm; with pending changesets it opens/updates the Version Packages PR instead. The `workflow_dispatch` modes below are for driving a release manually, not a gate that prevents automatic publishes.

This diverges from the original intent recorded in `@openrouter/agent@0.1.1` ("release-gate publishing via workflow_dispatch", [#4](https://github.com/OpenRouterTeam/typescript-agent/pull/4)): the `push` leg has been passing `publish:` to `changesets/action` regardless, so the gate has not been in effect. **Auto-publish is the intended behavior going forward** — the changeset flow already gates releases (no changeset means no version bump means nothing to publish), and the Version Packages PR is the human review point. To restore the old gate instead, condition the `publish:` input on `github.event_name == 'workflow_dispatch'`.

### What actually protects a release

The changeset flow controls *what* publishes; these control *who and from where*:

| Control | Status |
| --- | --- |
| Version Packages PR review | Active — the human approval point for any version bump |
| Job-level `if: github.ref == 'refs/heads/main'` | Active — blocks publishing from any non-`main` ref |
| npm trusted publisher | Pins org, repo, workflow filename, environment. **No branch/ref claim exists**, so npm alone cannot restrict which branch publishes |
| `npm-publish` deployment branch policy | **Not configured** (all branches allowed) |
| `npm-publish` required reviewers | **Not configured** |

Because npm's trusted publisher has no ref claim and the environment has no branch policy, the job-level `if` is what prevents a `workflow_dispatch` from an arbitrary branch reaching npm. Under token auth this mattered less; OIDC mints credentials on demand from any ref that reaches the workflow. Adding a branch policy (`main` only) and/or required reviewers to the `npm-publish` environment is the defense-in-depth follow-up — GitHub settings, not repo config.

## Why Coordinate Releases?

`@openrouter/agent` depends on `@openrouter/sdk`. When Speakeasy regenerates SDK types, the agent must be updated to match. Both packages need **coordinated releases** — publishing one without the other can break consumers.

Because a merge to `main` can publish, the coordination point is **when the Version Packages PR merges**, not a separate manual publish step. Hold that PR until the matching `@openrouter/sdk` release is out.

## Adding a Changeset

When you make a change that should be included in the next release:

```bash
pnpm changeset add
```

This will prompt you to:
1. Select the package (`@openrouter/agent` and/or `@openrouter/mcp`)
2. Choose a bump type (`patch`, `minor`, `major`)
3. Write a summary of the change

This creates a markdown file in `.changeset/` that describes the change. Commit this file with your PR.

### Bump Type Guidelines

- **patch** — Bug fixes, type fixes, defensive coding improvements
- **minor** — New features, new exports, new tool capabilities
- **major** — Breaking API changes (e.g., changing `callModel` signature, removing exports)

## Release Flow

### Step 1: Version (creates a Version Packages PR)

Go to **Actions → Release → Run workflow** and select:
- **Mode:** `version`
- **Dry run:** unchecked

This runs `changesets/action` which:
- Consumes all pending `.changeset/*.md` files
- Bumps `package.json` version
- Updates `CHANGELOG.md`
- Opens a "chore: version packages" PR

Review and merge that PR to main.

### Step 2: Publish (pushes to npm)

After the Version Packages PR is merged, go to **Actions → Release → Run workflow** and select:
- **Mode:** `publish`
- **Dry run:** unchecked (or check it first to verify)

This runs `pnpm exec changeset publish --no-git-checks` to push the new version to npm.

Authentication uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — there is no npm token in CI. Provenance attestations are generated automatically by npm and do not need a `--provenance` flag. This requires:

- `id-token: write` permission on the job (already set).
- Node 24+ on the runner, since OIDC needs npm >= 11.5.1 and Node 22 ships npm 10.x. A guard step fails the run early with a clear message if npm is too old.
- A trusted publisher configured on npmjs.com for **each** package: repo `OpenRouterTeam/typescript-agent`, workflow filename `publish.yaml`, environment `npm-publish`. npm does not validate these fields on save, and all are case-sensitive — a mismatch only shows up as a failed publish (`ENEEDAUTH`, or `E404` on a `PUT`).

A package's **first** version cannot be published via OIDC ([npm/cli#8544](https://github.com/npm/cli/issues/8544)); the npm UI requires the package to exist before a trusted publisher can be attached. Bootstrap a brand-new package with one manual `npm publish --access public`, then configure its trusted publisher.

### Dry Run

To verify what would happen without making changes:
- **Mode:** `publish`
- **Dry run:** checked

The dry run uses `pnpm -r publish --dry-run`, which simulates every workspace package rather than only the ones changesets would select, so its output set may be wider than a real publish. It also never reaches the OIDC token exchange, so it validates tarball contents — not authentication.

## Coordination with @openrouter/sdk

Before releasing `@openrouter/agent`:
1. Ensure `@openrouter/sdk` has been published with any required type changes
2. Update the SDK dependency in `package.json` if needed
3. Run `pnpm install` to update the lockfile
4. Verify `pnpm run typecheck` and `pnpm run test` pass
5. Then proceed with the release flow above

## Changelog

Changelogs are auto-generated by `@changesets/changelog-github` and include:
- PR links
- Contributor attribution
- Commit references

The changelog is written to `CHANGELOG.md` during the version step.

## Configuration

- `.changeset/config.json` — Changesets configuration
- `.github/workflows/publish.yaml` — Release workflow (workflow_dispatch)
- `.github/workflows/ci.yaml` — PR validation (lint, typecheck, test)

## Common Commands

```bash
pnpm changeset add          # Add a new changeset
pnpm changeset status       # View pending changesets
pnpm changeset version      # Apply changesets locally (usually done by CI)
pnpm run build              # Build (tsc)
pnpm run typecheck          # Type check without emitting
pnpm run test               # Run unit tests
pnpm run test:e2e           # Run e2e tests (requires OPENROUTER_API_KEY)
pnpm run lint               # Lint with biome
```

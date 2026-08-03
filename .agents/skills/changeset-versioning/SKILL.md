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
| Job-level ref guard (`publish.yaml`) | Active, but **accident-only** — `workflow_dispatch` runs the workflow file from the selected ref, so a branch whose copy drops the guard ignores it |
| npm trusted publisher | Pins org, repo, workflow filename, environment. **No branch/ref claim exists**, so npm cannot restrict which branch publishes |
| `npm-publish` deployment branch policy | **Not configured** (all branches allowed) — the only real server-side ref restriction |
| `npm-publish` required reviewers | **Not configured** |

The job-level guard stops someone from mistakenly dispatching a release off `main`; it is not a security boundary, because the guard travels with the ref being dispatched. Since npm's trusted publisher carries no ref claim, **the `npm-publish` environment's deployment branch policy is the only server-side control over which branch can publish** — setting it to `main` is the actual fix, not merely defense-in-depth. This matters more under OIDC than it did under token auth, because credentials are now minted on demand from whatever ref reaches the workflow. Required reviewers on that environment are a further hardening step.

The guard deliberately still allows `mode=publish` + `dry-run` from any branch, since that leg never reaches the OIDC exchange. It does **not** exempt `dry-run` generally: with `mode=version` the changesets step runs with `publish:` wired up and ignores `dry-run`, so a blanket exemption would let a feature branch publish for real.

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

**Merging the Version Packages PR normally publishes on its own** — that merge is a push to `main`, which runs this workflow's `changesets/action` leg with `publish:` wired up. In the common case there is nothing to do here.

This mode is for **retrying or forcing** a publish (for example after a failed run, or when a version is on disk but never reached npm). Go to **Actions → Release → Run workflow** and select:
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

## What a publish triggers downstream

A real `@openrouter/agent` publish fans out to three repos via
`repository_dispatch` (event type `openrouter-agent-published`). All of these run
*after* npm already has the package, so none of them can fail the release:

| Hop | Target | Effect |
| --- | --- | --- |
| B | `openrouter-web` | Bumps the pinned `@openrouter/agent` used by server tools |
| C | `python-agent` | Opens a PR porting the release delta into the Python port |
| C | `go-agent` | Opens a PR porting the release delta into the Go port |

The port repos treat this repo as their **reference spec**: they run
[Upstreamer](https://github.com/mountgram/upstreamer) against the release tag and
gate the generated port on a mechanical verifier plus a behavioral parity eval
before advancing their sync state. Their contracts live at
`.upstreamer/upstreamer.md` in each repo.

Hop C is dispatched with the release tag (e.g. `@openrouter/agent@0.8.0`), not a
branch, so a port reproduces the exact published tree. If that tag is not on
origin — the manual publish path pushes tags best-effort — the dispatch falls
back to the publishing run's commit SHA, which is the same tree. If a dispatch
fails it logs a warning rather than failing the release: recover by running the
port repo's **Upstreamer Port** workflow manually with that ref, or wait for its
weekly cron.

Practical consequence: a breaking change to the `callModel` surface will produce
port PRs in two other repos on release. If the ports need a coordinated change,
sequence it the same way `@openrouter/sdk` coordination works.

## Configuration

- `.changeset/config.json` — Changesets configuration
- `.github/workflows/publish.yaml` — Release workflow (`push: main` + `workflow_dispatch`); also carries the HOP B/C downstream dispatches
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

# Public API Changes Require a Code Example

## Rule

Any PR that changes the public API of `@openrouter/agent` (or any published package in this repo) MUST include a fenced code example block showing the change from the consumer's perspective. No example, no merge.

## What Counts as a Public API Change

- Adding, removing, or renaming an export in `src/index.ts` or any `exports` entry in `package.json`
- Changing the signature, accepted values, or type of an exported function, option, or constant
- Changing the *behavior* of an existing option — even when the type signature is unchanged (e.g. a default that used to append nothing now appends a message)
- Adding or changing fields on serialized shapes consumers persist (`ConversationState`, tool result items)

Internal refactors, test-only changes, and docs-only changes are exempt.

## Where the Example Must Live

| Location | Required | Notes |
|---|---|---|
| PR description | Always | A `### API example` section with a ` ```ts ` block. Show usage, not diff hunks. For behavioral changes, annotate old vs. new behavior in comments. |
| Changeset (`.changeset/*.md`) | Always | Changesets become `CHANGELOG.md` via `@changesets/changelog-github`; the example makes the changelog self-documenting for consumers who never see the PR. |
| README | When the touched API is documented there | Update the existing section; don't add a parallel one. |
| JSDoc on the export | New exports and changed option semantics | The IDE hover is the API's first documentation surface. |

## Example Template

```ts
import { callModel, stepCountIs } from '@openrouter/agent';

const result = client.callModel({
  model: 'z-ai/glm-5.2',
  input: 'Research the topic step by step.',
  tools: [searchTool],
  stopWhen: stepCountIs(3),
  allowFinalResponse: true, // new: appends DEFAULT_FINAL_RESPONSE_DIRECTIVE on the final no-tools turn
});
```

Good examples:
- Compile against the current branch (crib from a test you wrote — every API change already has one)
- Show the *changed* surface, not the whole feature
- Annotate behavioral deltas in comments (`// was: …`, `// now: …`)
- Fit in ~15 lines; link to README/tests for the full picture

## Reviewer Checklist

1. Does the diff touch `src/index.ts`, `package.json#exports`, or the observable contract of anything exported?
2. If yes: PR description has an `### API example` block, and the changeset contains an example.
3. Does the example actually exercise the changed surface (not just adjacent code)?
4. For behavioral changes to existing options: does the example or changeset state the old behavior and the migration/opt-out path?

## Why

- Reviewers judge API ergonomics from usage, not from implementation diffs
- The changeset example flows into `CHANGELOG.md`, so npm consumers get migration guidance without spelunking PRs
- Writing the example surfaces awkward APIs before they ship — if the example is hard to write, the API is wrong

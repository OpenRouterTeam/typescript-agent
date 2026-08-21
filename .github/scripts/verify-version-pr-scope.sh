#!/usr/bin/env bash
#
# verify-version-pr-scope.sh — assert a Version Packages PR contains only
# mechanical `changeset version` output before an unattended merge.
#
# Two layers, both fail-closed:
#   1. Path allowlist: consumed changesets (.changeset/*.md) and per-package
#      package.json / CHANGELOG.md / src/version.ts. No root package.json
#      (private, unversioned), no lockfile (workspace:* deps don't touch it).
#      src/version.ts is the committed gen:version output (see publish.yaml's
#      `pnpm run version` note) — a Version PR bumping @openrouter/mcp always
#      carries it, so excluding it would fail every such train run.
#   2. Content vet for package.json: paths alone are not enough — a smuggled
#      `"postinstall"` script in packages/*/package.json passes a path check,
#      survives `pnpm install --frozen-lockfile` (script-only edits don't
#      desync the lockfile), and executes inside the publish job where the
#      npm OIDC id-token is in scope. So every changed line in a package.json
#      must be a version bump or an internal @openrouter/* dependency range
#      bump — exactly what `changeset version` emits (cf. Version PR #57).
#      src/version.ts gets the same treatment: every changed line must match
#      the fixed gen-version.mjs output shape (comments or the PACKAGE_VERSION
#      constant), so a smuggled statement can't ride the auto-merge either.
#
# File list is paginated via the REST API: `gh pr view --json files` caps at
# 100 entries and sorts .changeset/ first, so a padded PR could hide an
# out-of-scope file past the page boundary.
#
# Inputs (env): PR, REPO required; GH_TOKEN for gh.
# Output: "head_sha=<sha>" on stdout (the head this check vetted).
# Exit: 0 = in scope; 1 = out of scope or the diff could not be read, with
# offending entries on stderr.

set -euo pipefail

: "${PR:?PR is required}"
: "${REPO:?REPO is required}"

PR_INFO="$(gh pr view "$PR" -R "$REPO" --json headRefOid,baseRefName,changedFiles)"
HEAD_SHA="$(echo "$PR_INFO" | python3 -c 'import sys,json; print(json.load(sys.stdin)["headRefOid"])')"
BASE_REF="$(echo "$PR_INFO" | python3 -c 'import sys,json; print(json.load(sys.stdin)["baseRefName"])')"
DECLARED="$(echo "$PR_INFO" | python3 -c 'import sys,json; print(json.load(sys.stdin)["changedFiles"])')"

# Vet the diff of the immutable SHA itself (compare API), not "the PR's
# current files": with the mutable pulls/N/files endpoint, an A→B→A flip-flop
# timed inside this script could get files from revision B vetted while
# head_sha reports A. compare/<base>...<sha> is cryptographically bound to
# HEAD_SHA, so what we vet is exactly what the caller pins and merges
# (pr-gate.sh passes it to --match-head-commit).
FILES_NDJSON="$(gh api "repos/${REPO}/compare/${BASE_REF}...${HEAD_SHA}" \
  --jq '.files[] | {filename, patch}')"

echo "head_sha=${HEAD_SHA}"

if [ -z "$FILES_NDJSON" ]; then
  echo "::error::Could not read diff for ${HEAD_SHA:0:7} (empty) — refusing" >&2
  exit 1
fi

# The compare endpoint caps the files array (~300), so a padded PR could hide
# an out-of-scope path past the cap. Cross-check against the PR's own
# changed-files count and refuse on any mismatch — covers truncation AND a
# base that moved enough to skew the diff. (A real Version PR is small; a
# false refusal here just goes red and re-vets on re-run.)
ENUMERATED="$(printf '%s\n' "$FILES_NDJSON" | grep -c .)"
if [ "$ENUMERATED" != "$DECLARED" ]; then
  echo "::error::Diff for ${HEAD_SHA:0:7} enumerated ${ENUMERATED} files but PR declares ${DECLARED} — refusing" >&2
  exit 1
fi

printf '%s\n' "$FILES_NDJSON" | python3 -c '
import json, re, sys

ALLOW = re.compile(r"^(\.changeset/[^/]+\.md|packages/[^/]+/(package\.json|CHANGELOG\.md|src/version\.ts))$")
# The only lines `changeset version` changes in a package.json: the version
# field, and internal dependency ranges when updateInternalDependencies fires.
OK_LINE = re.compile(
    r"^[+-]\s*\"(version|@openrouter/[A-Za-z0-9._-]+)\":\s*\"[^\"]*\",?\s*$"
)
# gen-version.mjs emits a fixed 5-line file; a version bump only rewrites the
# string literal in the constant. Allow comment lines, the blank line, and the
# constant itself. \x27 is a single quote (this code lives inside a
# shell-single-quoted string, so literal apostrophes are unusable here).
OK_VERSION_TS_LINE = re.compile(
    r"^[+-]\s*(//.*|/\*\*.*\*/|export const PACKAGE_VERSION = \x27[^\x27]+\x27;)?\s*$"
)

bad = []
for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    f = json.loads(raw)
    name = f["filename"]
    if not ALLOW.match(name):
        bad.append(f"path outside allowlist: {name}")
        continue
    if name.endswith("package.json") or name.endswith("src/version.ts"):
        ok_line = OK_VERSION_TS_LINE if name.endswith(".ts") else OK_LINE
        patch = f.get("patch")
        if patch is None:
            # No inline patch (file too large / binary flag) — cannot vet.
            bad.append(f"unvettable diff: {name}")
            continue
        for line in patch.splitlines():
            if line.startswith(("+++", "---")) or not line.startswith(("+", "-")):
                continue
            if not ok_line.match(line):
                bad.append(f"non-version change in {name}: {line[:100]}")
                break

if bad:
    for b in bad:
        print(f"::error::{b}", file=sys.stderr)
    sys.exit(1)
print("Diff scope OK — only mechanical changeset version output.", file=sys.stderr)
'

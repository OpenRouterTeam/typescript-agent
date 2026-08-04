#!/usr/bin/env bash
#
# verify-version-pr-scope.sh — assert a Version Packages PR contains only
# mechanical `changeset version` output before an unattended merge.
#
# Two layers, both fail-closed:
#   1. Path allowlist: consumed changesets (.changeset/*.md) and per-package
#      package.json / CHANGELOG.md. No root package.json (private,
#      unversioned), no lockfile (workspace:* deps don't touch it).
#   2. Content vet for package.json: paths alone are not enough — a smuggled
#      `"postinstall"` script in packages/*/package.json passes a path check,
#      survives `pnpm install --frozen-lockfile` (script-only edits don't
#      desync the lockfile), and executes inside the publish job where the
#      npm OIDC id-token is in scope. So every changed line in a package.json
#      must be a version bump or an internal @openrouter/* dependency range
#      bump — exactly what `changeset version` emits (cf. Version PR #57).
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

HEAD_SHA="$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq '.headRefOid')"

# NDJSON, one {filename, patch} per line; --paginate walks every page.
FILES_NDJSON="$(gh api "repos/${REPO}/pulls/${PR}/files" --paginate \
  --jq '.[] | {filename, patch}')"

# The head must not have moved while we were reading the diff — otherwise the
# head_sha we report and the files we vetted could belong to different
# revisions, and a caller adopting head_sha would be pinning an unvetted head.
HEAD_AFTER="$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq '.headRefOid')"
if [ "$HEAD_AFTER" != "$HEAD_SHA" ]; then
  echo "::error::PR #${PR} head moved during the scope check (${HEAD_SHA:0:7} → ${HEAD_AFTER:0:7}) — refusing" >&2
  exit 1
fi
echo "head_sha=${HEAD_SHA}"

if [ -z "$FILES_NDJSON" ]; then
  echo "::error::Could not read file list for PR #${PR} (empty) — refusing" >&2
  exit 1
fi

# The files endpoint silently caps at 3000 entries even with --paginate, so a
# PR padded with allowlisted files could hide an out-of-scope path past the
# cap. Cross-check against the PR's own changed-files count and refuse on any
# mismatch. (A legitimate Version PR is nowhere near 3000 files.)
ENUMERATED="$(printf '%s\n' "$FILES_NDJSON" | grep -c .)"
DECLARED="$(gh api "repos/${REPO}/pulls/${PR}" --jq '.changed_files')"
if [ "$ENUMERATED" != "$DECLARED" ]; then
  echo "::error::File list truncated for PR #${PR}: enumerated ${ENUMERATED} of ${DECLARED} — refusing" >&2
  exit 1
fi

printf '%s\n' "$FILES_NDJSON" | python3 -c '
import json, re, sys

ALLOW = re.compile(r"^(\.changeset/[^/]+\.md|packages/[^/]+/(package\.json|CHANGELOG\.md))$")
# The only lines `changeset version` changes in a package.json: the version
# field, and internal dependency ranges when updateInternalDependencies fires.
OK_LINE = re.compile(
    r"^[+-]\s*\"(version|@openrouter/[A-Za-z0-9._-]+)\":\s*\"[^\"]*\",?\s*$"
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
    if name.endswith("package.json"):
        patch = f.get("patch")
        if patch is None:
            # No inline patch (file too large / binary flag) — cannot vet.
            bad.append(f"unvettable package.json diff: {name}")
            continue
        for line in patch.splitlines():
            if line.startswith(("+++", "---")) or not line.startswith(("+", "-")):
                continue
            if not OK_LINE.match(line):
                bad.append(f"non-version change in {name}: {line[:100]}")
                break

if bad:
    for b in bad:
        print(f"::error::{b}", file=sys.stderr)
    sys.exit(1)
print("Diff scope OK — only mechanical changeset version output.", file=sys.stderr)
'

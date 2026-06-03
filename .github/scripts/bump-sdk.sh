#!/usr/bin/env bash
#
# bump-sdk.sh — bump @openrouter/sdk in packages/agent and open the PR branch.
#
# Run by .github/workflows/bump-openrouter-sdk.yaml. Edits the dependency to the
# caret floor of the target version, relocks, writes a changeset, closes any
# prior bot bump PRs, commits, and pushes a new branch.
#
# Inputs (env):
#   TARGET_VERSION  required — the @openrouter/sdk version to bump to
#   GH_TOKEN        required — token with repo write (App token / PAT), so the
#                   opened PR triggers Perry + CI (GITHUB_TOKEN would not)
#
# Outputs (written to $GITHUB_OUTPUT):
#   branch  the pushed branch name (empty when noop)
#   noop    "true" when already at target (no branch/PR needed)
#
# Read the value with `pnpm exec` is avoided on purpose — plain node/jq only.

set -euo pipefail

: "${TARGET_VERSION:?TARGET_VERSION is required}"

REPO="OpenRouterTeam/typescript-agent"
PKG_JSON="packages/agent/package.json"
DEP="@openrouter/sdk"
BRANCH_PREFIX="sdk-bot/bump-openrouter-sdk-"
DESIRED_RANGE="^${TARGET_VERSION}"

out() { echo "$1=$2" >> "${GITHUB_OUTPUT:-/dev/stdout}"; }

# --- No-op guard: already at the desired caret floor? -----------------------
CURRENT_RANGE="$(node -p "require('./${PKG_JSON}').dependencies['${DEP}']")"
echo "Current ${DEP} range: ${CURRENT_RANGE} | desired: ${DESIRED_RANGE}"
if [ "$CURRENT_RANGE" = "$DESIRED_RANGE" ]; then
  echo "Already at ${DESIRED_RANGE} — nothing to do"
  out noop true
  out branch ""
  exit 0
fi

# --- Edit the dependency range ----------------------------------------------
node -e "
  const fs = require('fs');
  const p = './${PKG_JSON}';
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  json.dependencies['${DEP}'] = '${DESIRED_RANGE}';
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
  console.log('Set ${DEP} to ${DESIRED_RANGE} in ${PKG_JSON}');
"

# --- Relock (FULL install; @openrouter/sdk is an onlyBuiltDependency) --------
# A full install ensures pnpm-lock.yaml matches what the PR's own
# `pnpm install --frozen-lockfile` CI step will expect.
pnpm install --no-frozen-lockfile

# --- Changeset (patch bump of @openrouter/agent) ----------------------------
# Written directly rather than via `changeset add` so it is non-interactive and
# deterministic. An empty changeset would not bump the version, so include the
# package + summary explicitly.
mkdir -p .changeset
CHANGESET_FILE=".changeset/sdk-bump-$(date +%Y%m%d-%H%M%S).md"
cat > "$CHANGESET_FILE" <<EOF
---
"@openrouter/agent": patch
---

Bump ${DEP} to ${TARGET_VERSION}
EOF
echo "Wrote changeset ${CHANGESET_FILE}"

# --- Git identity + branch ---------------------------------------------------
git config user.name 'OpenRouter SDK Bot'
git config user.email 'sdk-bot@openrouter.ai'

BRANCH="${BRANCH_PREFIX}$(date +%Y%m%d-%H%M%S)"

# --- Close prior bot bump PRs (keep at most one open) ------------------------
# Mirrors the close-prior pattern in openrouter-web's sdk-release-prs.yaml.
PRIOR_JSON=$(gh pr list \
  --repo "$REPO" \
  --state open \
  --search "head:${BRANCH_PREFIX}" \
  --limit 500 \
  --json number \
  --jq '.[].number' || true)

if [ -n "$PRIOR_JSON" ]; then
  mapfile -t PRIOR <<< "$PRIOR_JSON"
  echo "Closing ${#PRIOR[@]} prior bot bump PR(s) superseded by this run"
  for N in "${PRIOR[@]}"; do
    gh pr close "$N" --repo "$REPO" --delete-branch \
      --comment "Superseded by a newer @openrouter/sdk bump" \
      || echo "::warning::Failed to close PR #$N (continuing)"
    sleep 1 # stay under GitHub secondary rate limits
  done
else
  echo "No prior bot bump PRs to close"
fi

# --- Commit + push -----------------------------------------------------------
git checkout -b "$BRANCH"
git add "$PKG_JSON" pnpm-lock.yaml "$CHANGESET_FILE"
git commit -m "chore: bump ${DEP} to ${TARGET_VERSION} [sdk-bot]"
git push origin "$BRANCH"

out noop false
out branch "$BRANCH"
echo "Pushed ${BRANCH}"

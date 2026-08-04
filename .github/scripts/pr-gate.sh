#!/usr/bin/env bash
#
# pr-gate.sh — poll a bump PR until Perry + CI reach a terminal state, then
# squash-merge it (when AUTO_MERGE=true) or alert and leave it red.
#
# This is the self-gating auto-merge: GitHub-native `gh pr merge --auto` cannot
# be relied on because the repo has no required status checks, so we poll the
# verdict ourselves. The verdict mirrors ~/.claude/skills/get-pr-reviewed's
# pr_status.sh — reimplemented here in pure gh + python3 (no Claude in the loop).
#
# Inputs (env):
#   PR                required — PR number
#   REPO              required — owner/name
#   GH_TOKEN          required — token with merge permission
#   AUTO_MERGE        "true" to merge on PASS; anything else = report-only
#   GATE_LABEL        optional — human label for Slack messages
#                     (default "@openrouter/sdk bump")
#   BLOCK_LABEL       optional — PR label that pauses the gate. Re-checked on
#                     every poll and immediately before merging, so a hold
#                     added mid-poll still stops the merge. Exit 0 (deliberate
#                     pause, not a failure).
#   EXPECTED_HEAD     optional — head SHA the caller vetted (e.g. a diff-scope
#                     allowlist). The merge is refused if the PR head no longer
#                     matches, closing the TOCTOU window between the caller's
#                     check and the merge. Exit 1 (needs a re-run to re-vet).
#   SCOPE_ALLOWLIST   optional, with EXPECTED_HEAD — extended regex of allowed
#                     file paths. When the head moved, the gate re-vets the
#                     PR's files against this before refusing: a moved head
#                     whose full diff still matches (e.g. changesets/action
#                     refreshed the Version PR mid-gate) adopts the new head
#                     and keeps polling instead of failing the run.
#   SLACK_BOT_TOKEN   optional — Slack bot token for chat.postMessage
#   SLACK_CHANNEL_ID  optional — Slack channel for alerts
#   RUN_URL           optional — link back to this workflow run
#
# Exit: 0 on PASS (merged or report-only). Non-zero on FAIL/TIMEOUT so the run
# surfaces red in the Actions UI.

set -euo pipefail

: "${PR:?PR is required}"
: "${REPO:?REPO is required}"

GATE_LABEL="${GATE_LABEL:-@openrouter/sdk bump}"

INTERVAL="${INTERVAL:-30}"
TIMEOUT="${TIMEOUT:-1800}"      # 30 min overall
PERRY_TIMEOUT="${PERRY_TIMEOUT:-480}" # 8 min for perry/review to appear at all
SETTLE="${SETTLE:-45}"

AI_REVIEWERS='perry/review|Devin Review|Graphite / AI Reviews|codex|claude'

slack() {
  # slack "<text>"
  local text="$1"
  if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_CHANNEL_ID:-}" ]; then
    echo "(slack not configured; would have posted) $text"
    return 0
  fi
  curl -fsS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-type: application/json; charset=utf-8" \
    --data "$(python3 -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'unfurl_links':False,'text':sys.argv[2]}))" "$SLACK_CHANNEL_ID" "$text")" \
    >/dev/null || echo "::warning::Slack post failed (continuing)"
}

PR_URL="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/pull/${PR}"

# True when BLOCK_LABEL is set and currently on the PR. Queried live each time
# so a hold applied while we're polling takes effect before any merge.
held() {
  [ -n "${BLOCK_LABEL:-}" ] || return 1
  # Fail closed: this is the final safety control before an unattended merge,
  # so "couldn't read the labels" must not be read as "no hold".
  local labels
  if ! labels="$(gh pr view "$PR" -R "$REPO" --json labels --jq '.labels[].name')"; then
    echo "::warning::could not read labels for PR #${PR}; treating as held (fail closed)"
    return 0
  fi
  printf '%s\n' "$labels" | grep -qxF "$BLOCK_LABEL"
}

# Returns one of: PASS PENDING FAIL_CI FAIL_REVIEWER, plus a reason line on
# stderr. Reads checks + PR meta in two gh calls.
verdict() {
  local checks meta
  checks="$(gh pr checks "$PR" -R "$REPO" --json name,state 2>/dev/null || echo '[]')"
  meta="$(gh pr view "$PR" -R "$REPO" --json mergeable,reviewDecision 2>/dev/null || echo '{}')"
  AI_REVIEWERS="$AI_REVIEWERS" python3 - "$checks" "$meta" <<'PY'
import sys, json, os, re
checks = json.loads(sys.argv[1])
meta = json.loads(sys.argv[2])
ai = re.compile(os.environ["AI_REVIEWERS"])
FAIL = {"FAILURE","ERROR","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE"}
PENDING = {"PENDING","IN_PROGRESS","QUEUED","EXPECTED","WAITING"}
PASS_REVIEW = {"SUCCESS","NEUTRAL","SKIPPED"}

reasons = []
ci_pending = False
perry_present = False
perry_terminal = False

for c in checks:
    name, state = c["name"], c["state"]
    if ai.search(name):
        if name == "perry/review":
            perry_present = True
            if state not in PENDING:
                perry_terminal = True
        if state not in PASS_REVIEW and state not in PENDING:
            print(f"FAIL_REVIEWER", file=sys.stderr)
            print(f"reviewer {name}={state}")
            sys.exit(0)
    else:
        if state in FAIL:
            print("FAIL_CI", file=sys.stderr)
            print(f"CI {name}={state}")
            sys.exit(0)
        if state in PENDING:
            ci_pending = True

if meta.get("reviewDecision") == "CHANGES_REQUESTED":
    print("FAIL_REVIEWER", file=sys.stderr)
    print("reviewDecision=CHANGES_REQUESTED")
    sys.exit(0)

# Not failing. Decide PASS vs PENDING.
if ci_pending:
    print("PENDING", file=sys.stderr); print("CI still running"); sys.exit(0)
if not (perry_present and perry_terminal):
    print("PENDING", file=sys.stderr); print("waiting for perry/review"); sys.exit(0)
if meta.get("mergeable") != "MERGEABLE":
    print("PENDING", file=sys.stderr); print(f"mergeable={meta.get('mergeable')}"); sys.exit(0)
print("PASS", file=sys.stderr); print("all green")
PY
}

echo "Gating PR #${PR} on ${REPO} (timeout ${TIMEOUT}s, interval ${INTERVAL}s)"
START=$(date +%s)
LAST_REASON=""

while :; do
  NOW=$(date +%s); ELAPSED=$((NOW - START))

  if held; then
    slack ":double_vertical_bar: ${GATE_LABEL} <${PR_URL}|PR #${PR}> has \`${BLOCK_LABEL}\` — gate paused, not merging. Remove the label to resume on the next run. <${RUN_URL:-$PR_URL}|run>"
    echo "PR #${PR} carries ${BLOCK_LABEL}; exiting without merging."
    exit 0
  fi

  REASON="$(verdict 2>/tmp/gate.state)" || true
  STATE="$(cat /tmp/gate.state)"
  [ "$REASON" != "$LAST_REASON" ] && { echo "[$ELAPSED s] $STATE — $REASON"; LAST_REASON="$REASON"; }

  case "$STATE" in
    FAIL_CI|FAIL_REVIEWER)
      slack ":x: ${GATE_LABEL} <${PR_URL}|PR #${PR}> blocked: ${REASON}. Left open for a human. <${RUN_URL:-$PR_URL}|run>"
      echo "::error::PR #${PR} blocked: ${REASON}"
      exit 1
      ;;
    PASS)
      # Confirm once more after a short settle window so a momentary "all green"
      # before a reviewer (re)posts cannot trip an early merge.
      sleep "$SETTLE"
      CONFIRM_REASON="$(verdict 2>/tmp/gate.state2)" || true
      CONFIRM_STATE="$(cat /tmp/gate.state2)"
      if [ "$CONFIRM_STATE" != "PASS" ]; then
        echo "Settle re-check changed verdict to ${CONFIRM_STATE} (${CONFIRM_REASON}); continuing to poll"
        LAST_REASON=""
        continue
      fi
      # Last-instant hold check: the settle sleep is a window in which a
      # human may have applied the hold label after the loop-top check.
      if held; then
        slack ":double_vertical_bar: ${GATE_LABEL} <${PR_URL}|PR #${PR}> has \`${BLOCK_LABEL}\` — gate paused just before merge. Remove the label to resume on the next run. <${RUN_URL:-$PR_URL}|run>"
        echo "PR #${PR} carries ${BLOCK_LABEL}; exiting without merging."
        exit 0
      fi
      # Head pin: never merge a head nobody vetted. Checked at the last
      # instant so commits pushed at any point during the poll are caught,
      # not just ones present at loop start. A moved head is not necessarily
      # hostile — changesets/action force-pushes the Version PR whenever
      # another PR lands on main — so when SCOPE_ALLOWLIST is provided,
      # re-vet the new head's full file list first and only refuse if it no
      # longer fits the allowlist; otherwise adopt the new head and resume
      # polling (its checks just restarted).
      if [ -n "${EXPECTED_HEAD:-}" ]; then
        CURRENT_HEAD="$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq '.headRefOid')"
        if [ "$CURRENT_HEAD" != "$EXPECTED_HEAD" ]; then
          REVETTED=false
          if [ -n "${SCOPE_ALLOWLIST:-}" ]; then
            if FILES="$(gh pr view "$PR" -R "$REPO" --json files --jq '.files[].path')" \
               && [ -n "$FILES" ] \
               && ! printf '%s\n' "$FILES" | grep -qvE "$SCOPE_ALLOWLIST"; then
              REVETTED=true
            fi
          fi
          if [ "$REVETTED" = "true" ]; then
            echo "PR #${PR} head moved ${EXPECTED_HEAD:0:7} → ${CURRENT_HEAD:0:7}; diff still within scope allowlist — adopting new head and re-polling."
            EXPECTED_HEAD="$CURRENT_HEAD"
            LAST_REASON=""
            continue
          fi
          slack ":no_entry: ${GATE_LABEL} <${PR_URL}|PR #${PR}> head moved during the gate (${EXPECTED_HEAD:0:7} → ${CURRENT_HEAD:0:7}) and the new diff fails the scope allowlist (or could not be read) — refusing to merge unvetted commits. Re-run the workflow to re-vet. <${RUN_URL:-$PR_URL}|run>"
          echo "::error::PR #${PR} head changed ${EXPECTED_HEAD} → ${CURRENT_HEAD}; not merging."
          exit 1
        fi
      fi
      if [ "${AUTO_MERGE:-false}" = "true" ]; then
        echo "PASS — squash-merging PR #${PR}"
        # Alert on merge failure too: under `set -e` a bare failing merge
        # would exit before any notification — fatal for the scheduled train,
        # where nobody is watching the run and the PR would sit unmerged
        # until the next scheduled attempt.
        if gh pr merge "$PR" -R "$REPO" --squash --delete-branch; then
          slack ":white_check_mark: ${GATE_LABEL} <${PR_URL}|PR #${PR}> passed Perry + CI and was auto-merged."
        else
          slack ":x: ${GATE_LABEL} <${PR_URL}|PR #${PR}>: checks passed but the merge itself failed (branch protection? conflict?). Left open for a human. <${RUN_URL:-$PR_URL}|run>"
          echo "::error::gh pr merge failed for PR #${PR}"
          exit 1
        fi
      else
        echo "PASS (report-only; AUTO_MERGE!=true) — not merging PR #${PR}"
        slack ":white_check_mark: ${GATE_LABEL} <${PR_URL}|PR #${PR}> is green and ready for merge."
      fi
      exit 0
      ;;
    PENDING)
      # If perry/review never even shows up, the PR was likely opened with a
      # token that doesn't trigger it — surface that rather than hang forever.
      if [ "$REASON" = "waiting for perry/review" ] && [ "$ELAPSED" -ge "$PERRY_TIMEOUT" ]; then
        slack ":warning: ${GATE_LABEL} <${PR_URL}|PR #${PR}>: perry/review never appeared after ${PERRY_TIMEOUT}s (token/app misconfig?). Not merging. <${RUN_URL:-$PR_URL}|run>"
        echo "::error::perry/review did not appear within ${PERRY_TIMEOUT}s"
        exit 1
      fi
      ;;
  esac

  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    slack ":warning: ${GATE_LABEL} <${PR_URL}|PR #${PR}> did not settle within ${TIMEOUT}s (last: ${REASON}). Not merging. <${RUN_URL:-$PR_URL}|run>"
    echo "::error::Gate timed out after ${TIMEOUT}s (last: ${REASON})"
    exit 1
  fi
  sleep "$INTERVAL"
done

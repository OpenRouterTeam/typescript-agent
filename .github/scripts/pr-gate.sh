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
#   REQUIRE_HEAD      optional — "true" to make an empty/unset EXPECTED_HEAD
#                     a hard error instead of "no pin configured". Set this
#                     wherever the pin is a security control, so a broken
#                     output wiring fails closed rather than silently
#                     disabling the guard.
#   SCOPE_SCRIPT      optional, with EXPECTED_HEAD — path to a script (run
#                     with PR/REPO in env) that exits 0 iff the PR's current
#                     diff is safe to merge unattended. When the head moved,
#                     the gate re-vets by re-running it: a moved head that
#                     still passes (e.g. changesets/action refreshed the
#                     Version PR mid-gate) adopts the new head and keeps
#                     polling instead of failing the run.
#   SLACK_BOT_TOKEN   optional — Slack bot token for chat.postMessage
#   SLACK_CHANNEL_ID  optional — Slack channel for alerts
#   RUN_URL           optional — link back to this workflow run
#
# Exit: 0 on PASS (merged or report-only). Non-zero on FAIL/TIMEOUT so the run
# surfaces red in the Actions UI.

set -euo pipefail

: "${PR:?PR is required}"
: "${REPO:?REPO is required}"

# Fail closed on missing pin where the pin is a security control: an empty
# EXPECTED_HEAD (e.g. broken step-output wiring in the calling workflow) must
# not silently downgrade to "no head verification".
if [ "${REQUIRE_HEAD:-}" = "true" ] && [ -z "${EXPECTED_HEAD:-}" ]; then
  echo "::error::REQUIRE_HEAD=true but EXPECTED_HEAD is empty — refusing to gate without a vetted head."
  exit 1
fi

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
# 0 = held, 1 = not held, 2 = labels unreadable after retries. Callers must
# treat 2 as "do not merge" (fail closed) but report it as a read failure and
# exit non-zero — a green run claiming a deliberate pause that nobody applied
# would hide the skipped release from the people meant to investigate.
held() {
  [ -n "${BLOCK_LABEL:-}" ] || return 1
  local labels attempt
  for attempt in 1 2 3; do
    if labels="$(gh pr view "$PR" -R "$REPO" --json labels --jq '.labels[].name')"; then
      printf '%s\n' "$labels" | grep -qxF "$BLOCK_LABEL" && return 0 || return 1
    fi
    sleep $((attempt * 5))
  done
  echo "::warning::could not read labels for PR #${PR} after 3 attempts"
  return 2
}

# held, exit as appropriate; no-op when not held. $1 names the checkpoint for
# the Slack message ("during the gate" / "just before merge").
check_hold() {
  local when="$1" rc=0
  held || rc=$?
  case "$rc" in
    0)
      slack ":double_vertical_bar: ${GATE_LABEL} <${PR_URL}|PR #${PR}> has \`${BLOCK_LABEL}\` — gate paused ${when}. Remove the label to resume on the next run. <${RUN_URL:-$PR_URL}|run>"
      echo "PR #${PR} carries ${BLOCK_LABEL}; exiting without merging."
      exit 0
      ;;
    2)
      slack ":warning: ${GATE_LABEL} <${PR_URL}|PR #${PR}>: could not read PR labels ${when} — refusing to merge (cannot rule out a \`${BLOCK_LABEL}\` hold). This is an API failure, not a deliberate pause. <${RUN_URL:-$PR_URL}|run>"
      echo "::error::labels unreadable for PR #${PR}; failing closed without merging."
      exit 1
      ;;
  esac
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
# perry/review's "never appeared" clock. Reset whenever a new head is adopted
# mid-gate: the fresh head's checks (perry included) start from scratch, so
# measuring them against the run's original start time would misreport a
# routine changesets/action refresh late in the poll as a token misconfig.
PERRY_START=$START
LAST_REASON=""

while :; do
  NOW=$(date +%s); ELAPSED=$((NOW - START)); PERRY_ELAPSED=$((NOW - PERRY_START))

  check_hold "during the gate"

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
      check_hold "just before merge"
      # Head pin: never merge a head nobody vetted. Checked at the last
      # instant so commits pushed at any point during the poll are caught,
      # not just ones present at loop start. A moved head is not necessarily
      # hostile — changesets/action force-pushes the Version PR whenever
      # another PR lands on main — so when SCOPE_SCRIPT is provided, re-vet
      # the new head by re-running it and only refuse if it fails; otherwise
      # adopt the new head and resume polling (its checks just restarted).
      if [ -n "${EXPECTED_HEAD:-}" ]; then
        CURRENT_HEAD="$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq '.headRefOid')"
        if [ "$CURRENT_HEAD" != "$EXPECTED_HEAD" ]; then
          # Adopt the SHA the scope script itself reports as vetted (it fails
          # internally if the head moves while it reads the diff) — never the
          # head we observed before the vet ran, which a flip-flop push during
          # the vet could otherwise swap for unvetted content.
          NEW_VETTED=""
          if [ -n "${SCOPE_SCRIPT:-}" ]; then
            NEW_VETTED="$(PR="$PR" REPO="$REPO" "$SCOPE_SCRIPT" | sed -n 's/^head_sha=//p')" || NEW_VETTED=""
          fi
          if [ -n "$NEW_VETTED" ]; then
            echo "PR #${PR} head moved ${EXPECTED_HEAD:0:7} → ${NEW_VETTED:0:7}; new diff passes the scope check — adopting vetted head and re-polling."
            EXPECTED_HEAD="$NEW_VETTED"
            PERRY_START=$(date +%s) # fresh head, fresh checks — restart perry's clock
            LAST_REASON=""
            continue
          fi
          slack ":no_entry: ${GATE_LABEL} <${PR_URL}|PR #${PR}> head moved during the gate (${EXPECTED_HEAD:0:7} → ${CURRENT_HEAD:0:7}) and the new diff fails the scope check (or could not be read) — refusing to merge unvetted commits. Re-run the workflow to re-vet. <${RUN_URL:-$PR_URL}|run>"
          echo "::error::PR #${PR} head changed ${EXPECTED_HEAD} → ${CURRENT_HEAD}; not merging."
          exit 1
        fi
      fi
      if [ "${AUTO_MERGE:-false}" = "true" ]; then
        echo "PASS — squash-merging PR #${PR}"
        # --match-head-commit makes the pin atomic: GitHub itself rejects the
        # merge if the head is no longer the vetted SHA, closing the residual
        # window between our pin check above and the merge API call.
        MATCH_ARGS=()
        [ -n "${EXPECTED_HEAD:-}" ] && MATCH_ARGS=(--match-head-commit "$EXPECTED_HEAD")
        # Alert on merge failure too: under `set -e` a bare failing merge
        # would exit before any notification — fatal for the scheduled train,
        # where nobody is watching the run and the PR would sit unmerged
        # until the next scheduled attempt.
        if gh pr merge "$PR" -R "$REPO" --squash --delete-branch "${MATCH_ARGS[@]}"; then
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
      if [ "$REASON" = "waiting for perry/review" ] && [ "$PERRY_ELAPSED" -ge "$PERRY_TIMEOUT" ]; then
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

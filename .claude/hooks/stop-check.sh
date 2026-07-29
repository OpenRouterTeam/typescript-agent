#!/usr/bin/env bash
#
# Stop-hook check runner. Usage: stop-check.sh <pnpm-script>
#
# Reads the Stop hook payload on stdin and skips the check when Claude Code
# marks the invocation re-entrant (`stop_hook_active: true`), which is what
# keeps a failing check from forcing the agent to keep going indefinitely.
#
# jq is not a prerequisite of this repo, so the guard must not depend on it:
# an earlier inline version was `jq -e ... && exit 0`, which exits 127 when jq
# is missing, short-circuits past the guard, and runs the check anyway — the
# loop protection silently disappeared for that contributor. Here jq is used
# when present and a grep fallback covers its absence.
#
# Exit codes: 0 allow the turn to end · 2 wake Claude with stderr attached
# (see `asyncRewake` in .claude/settings.json).
set -uo pipefail

script="${1:?usage: stop-check.sh <pnpm-script>}"
input=$(cat)

reentrant() {
  if command -v jq > /dev/null 2>&1; then
    [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2> /dev/null)" = "true" ]
    return
  fi
  # No jq: match the field directly. Tolerates arbitrary whitespace.
  printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'
}

if reentrant; then
  exit 0
fi

# Field absent entirely means the payload shape is not what we expect. Allow the
# turn to end rather than risk a loop we cannot detect.
if ! printf '%s' "$input" | grep -q 'stop_hook_active'; then
  exit 0
fi

pnpm run "$script" >&2 || exit 2

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
# Exit codes: 0 allow the turn to end · 2 block the turn and feed stderr back to
# the model. These hooks run SYNCHRONOUSLY on purpose — under `async`/
# `asyncRewake` every exit code other than 2 is treated as success and the
# completion notice is suppressed unless Claude Code runs with --verbose, so a
# backgrounded check cannot gate turn end at all. A warm turbo run is ~2s.
#
# Invoked in exec form (`args` is set in settings.json), so this file is spawned
# directly with no shell: it must stay executable, and `${CLAUDE_PROJECT_DIR}`
# in the command needs braces — a bare `$VAR` is passed through literally when
# there is no shell to expand it.
set -uo pipefail

# Belt-and-braces: `args` is a documented command-hook field, so $1 is set in
# exec form. But if it ever arrives empty the honest failure is a loud skip, not
# an abort — `${1:?}` would exit 1, and exit 1 is indistinguishable from success
# to a Stop hook, so the block would look healthy while silently doing nothing.
if [ "$#" -eq 0 ] || [ -z "${1:-}" ]; then
  echo "stop-check: no check name passed (expected argv[1]); skipping" >&2
  exit 0
fi
script="$1"
input=$(cat)

# Both fallbacks use bash's own `[[ =~ ]]` rather than a `grep` pipeline.
# `grep -q` exits on first match, which can kill the upstream `printf` with
# SIGPIPE (141); under `set -o pipefail` the pipeline then reports 141 even
# though grep matched, inverting the test. Here that would mean skipping the
# check on a payload that DID carry the field, or missing the re-entrancy guard
# — both silent. No pipe, no subshell, no inversion.
reentrant() {
  if command -v jq > /dev/null 2>&1; then
    [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2> /dev/null)" = "true" ]
    return
  fi
  # No jq: match the field directly. Tolerates arbitrary whitespace.
  [[ $input =~ \"stop_hook_active\"[[:space:]]*:[[:space:]]*true ]]
}

if reentrant; then
  exit 0
fi

# Field absent entirely means the payload shape is not what we expect. Allow the
# turn to end rather than risk a loop we cannot detect — but say so on stderr,
# because a silent skip here is indistinguishable from a passing check and the
# hook block would look healthy in /hooks while doing nothing.
if [[ $input != *stop_hook_active* ]]; then
  echo "stop-check: no stop_hook_active in payload; skipping $script" >&2
  exit 0
fi

# `pnpm run` resolves scripts against the SESSION's cwd, which in a monorepo is
# not always the repo root: from `packages/mcp/` it would either run that
# package's own `lint` (a partial gate reporting green) or die with `Missing
# script: lint` and block the turn. Anchor to the repo root instead. `|| exit 0`
# keeps the fail-open posture of the guards above — a cwd we cannot reach is a
# loud skip, never a spurious block.
cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}" || exit 0
pnpm run "$script" >&2 || exit 2

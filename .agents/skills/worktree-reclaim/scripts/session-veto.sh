#!/usr/bin/env bash
# Session veto for one worktree, usable as an external hook by tools that
# delete worktrees (for example `devrouter workspace reclaim --veto-command`).
#
# usage: session-veto.sh <worktree-path>
#
# Exits 0 when no Codex or Claude Code session used the path inside
# WORKTREE_RECLAIM_ACTIVE_WITHIN (default 24h). Exits 1 when one did, and 2
# when the evidence cannot be read, so a caller fails closed on any non-zero
# status. Reads session metadata only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-sessions.sh
. "$SCRIPT_DIR/lib-sessions.sh"

target="${1:-}"
[ -n "$target" ] || { echo "usage: session-veto.sh <worktree-path>" >&2; exit 2; }

window="${WORKTREE_RECLAIM_ACTIVE_WITHIN:-24h}"
window_secs=$(python3 - "$window" <<'PY'
import re, sys
m = re.fullmatch(r"(\d+)\s*([smhd]?)", sys.argv[1].strip())
if not m:
    sys.exit(2)
print(int(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)])
PY
) || { echo "bad WORKTREE_RECLAIM_ACTIVE_WITHIN: $window" >&2; exit 2; }

cache="$(mktemp "${TMPDIR:-/tmp}/worktree-reclaim-veto.XXXXXX")"
trap 'rm -f "$cache"' EXIT

if ! build_session_index "$cache" "$window_secs" recent; then
  echo "session evidence unavailable" >&2
  exit 2
fi

session="$(session_last_activity "$cache" "$target")"
[ -z "$session" ] && exit 0
IFS=$'\t' read -r provider age <<<"$session"
if ! [[ "$age" =~ ^[0-9]+$ ]]; then
  echo "unreadable session age" >&2
  exit 2
fi
if [ "$age" -le "$window_secs" ]; then
  echo "$provider session ${age}s ago (inside $window)" >&2
  exit 1
fi
exit 0

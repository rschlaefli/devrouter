#!/usr/bin/env bash
# Agent-session activity signal. Metadata-only: reads cwd/workdir fields and
# session file mtimes — never conversation content.
#
# build_session_index <cache-file> [window-seconds] [all-history]
#   Writes "realpath<TAB>provider<TAB>age_seconds" for the newest Codex or
#   Claude Code trace per working directory. By default, old Codex files
#   contribute only first-line session metadata and each Claude project keeps a
#   bounded fallback; in-window files receive a full structured-metadata scan.
#   all-history=1 scans every Codex and Claude session for cwd/workdir fields,
#   even when slow.
#
# session_last_activity <cache-file> <path>
#   Echoes "PROVIDER<TAB>AGE_SECONDS", or nothing when no trace names the path.
#   A failed index build is surfaced separately so callers can fail closed
#   (HOLD) instead of assuming "no session".

SESSION_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_session_index() {
  local cache="$1" window="${2:-86400}" all_history="${3:-0}"
  python3 "$SESSION_SCRIPT_DIR/session-index.py" "$cache" "$window" "$all_history"
}

session_last_activity() {
  local cache="$1" path="$2" key
  key=$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$path" 2>/dev/null)
  [ -z "$key" ] && return 0
  awk -F'\t' -v key="$key" '$1 == key {print $2 "\t" $3; exit}' "$cache" 2>/dev/null
}

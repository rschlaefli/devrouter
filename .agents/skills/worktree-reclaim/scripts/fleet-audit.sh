#!/usr/bin/env bash
# Fleet-wide, report-only worktree audit. Deletes nothing, ever.
# Usage:
#   fleet-audit.sh [repo-path ...] [--discover ROOT] [--active-within DUR]
#                  [--all-history] [--size] [--json|--manifest]
#
# Wraps the single-repo classifier with fleet scope and the agent-session
# signal from lib-sessions.sh:
#   SAFE-TO-PURGE  classifier RECLAIM + no session activity within the window
#   HOLD           classifier RECLAIM but a session touched it inside the
#                  window (or the session signal is unavailable — fail-closed);
#                  reported with reason code `active`
#   KEEP / PRUNE   unchanged from audit.sh; session age shown, never overrides
#
# Purge is deliberately two-step: this script proposes a content-addressed
# manifest, then apply-manifest.sh consumes that exact human-approved file and
# revalidates every target before any mutation. This audit never deletes.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-classify.sh
. "$SCRIPT_DIR/lib-classify.sh"
# shellcheck source=lib-sessions.sh
. "$SCRIPT_DIR/lib-sessions.sh"


repos=()
discover=""
active_within="24h"
all_history=0
want_size=0
want_json=0
want_manifest=0
while [ $# -gt 0 ]; do
  case "$1" in
    --discover) discover="${2:?--discover needs a root}"; shift 2 ;;
    --active-within) active_within="${2:?--active-within needs a duration}"; shift 2 ;;
    --all-history|--deep) all_history=1; shift ;;
    --size) want_size=1; shift ;;
    --json) want_json=1; shift ;;
    --manifest) want_manifest=1; shift ;;
    -h|--help)
      echo "usage: fleet-audit.sh [--discover ROOT] [--active-within DUR] [--all-history] [--size] [--json|--manifest] [repo-path ...]" >&2
      exit 0 ;;
    *) repos+=("$1"); shift ;;
  esac
done

[ "$want_json" -eq 1 ] && [ "$want_manifest" -eq 1 ] && {
  echo "choose only one output mode: --json or --manifest" >&2
  exit 2
}

dur_seconds() {
  python3 - "$1" <<'PY'
import re, sys
m = re.fullmatch(r"(\d+)\s*([smhd]?)", sys.argv[1].strip())
if not m:
    sys.exit(2)
print(int(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)])
PY
}

active_secs=$(dur_seconds "$active_within") || { echo "bad --active-within: $active_within (use e.g. 45m, 24h, 30d)" >&2; exit 2; }
audit_epoch="${WORKTREE_RECLAIM_NOW_EPOCH:-$(date +%s)}"

# Newline-delimited set of primary checkouts already covered (bash 3.2 has no
# associative arrays).
seen_repos=$'\n'
if [ -n "$discover" ]; then
  while IFS= read -r g; do
    [ -z "$g" ] && continue
    repo="${g%/.git}"
    [ -f "$repo/.git" ] && continue   # linked worktree of a covered main repo
    repos+=("$repo")
  done < <(find "$discover" \
    \( -type d \( -name node_modules -o -name .venv -o -name vendor -o -name trees -o -name .claude -o -name .codex \) -prune \) -o \
    \( -type d -name .git -print -prune \) 2>/dev/null)
fi

if [ "${#repos[@]}" -eq 0 ]; then
  echo "no repositories to audit (pass repo paths or --discover ROOT)" >&2
  exit 2
fi

cache="$(mktemp "${TMPDIR:-/tmp}/fleet-sessions.XXXXXX")"
rows="$(mktemp "${TMPDIR:-/tmp}/fleet-rows.XXXXXX")"
WORKTREE_RECLAIM_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/worktree-reclaim-run.XXXXXX")"
export WORKTREE_RECLAIM_RUN_DIR
trap 'rm -rf "$cache" "$rows" "$WORKTREE_RECLAIM_RUN_DIR"' EXIT

sessions_ok=1
history_label="$active_within"
[ "$all_history" -eq 1 ] && history_label="all history"
if ! build_session_index "$cache" "$active_secs" "$all_history"; then
  echo "WARNING: agent-session index unavailable; RECLAIM rows become HOLD (fail-closed)" >&2
  sessions_ok=0
  : > "$cache"
fi

human_age() {
  local s="$1"
  if [ "$s" -lt 90 ]; then echo "${s}s"
  elif [ "$s" -lt 5400 ]; then echo "$((s / 60))m"
  elif [ "$s" -lt 172800 ]; then echo "$((s / 3600))h"
  else echo "$((s / 86400))d"
  fi
}

n_safe=0; n_hold=0; n_keep=0; n_prune=0; safe_kb=0
for repo in "${repos[@]}"; do
  git -C "$repo" rev-parse --show-toplevel >/dev/null 2>&1 || { echo "skip (not a git repo): $repo" >&2; continue; }
  main_wt="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')"
  [ -z "$main_wt" ] && { echo "skip (no git common dir): $repo" >&2; continue; }
  case "$seen_repos" in *$'\n'"$main_wt"$'\n'*) continue ;; esac
  seen_repos="$seen_repos$main_wt"$'\n'
  cd "$main_wt" || continue
  # The manifest is machine-read from stdout, so its stash note goes to stderr.
  if [ "$want_manifest" -eq 1 ]; then
    { repo_stash_report; disposable_override_note .; } >&2
  elif [ "$want_json" -eq 0 ]; then
    repo_stash_report
    disposable_override_note .
  fi

  while IFS=$'\t' read -r path br; do
    [ -z "$path" ] && continue
    IFS=$'\t' read -r verdict codes reason < <(classify_worktree "$path" "$br")

    prov=""; age=""
    if [ "$sessions_ok" -eq 1 ]; then
      session="$(session_last_activity "$cache" "$path")"
      if [ -n "$session" ]; then
        IFS=$'\t' read -r prov age < <(printf '%s\n' "$session")
      fi
    fi

    fleet="$verdict"; extra=""
    case "$verdict" in
      RECLAIM)
        if [ "$sessions_ok" -eq 0 ]; then
          fleet="HOLD"; codes="active"; extra="session signal unavailable"
        elif [ -n "$age" ] && [[ "$age" =~ ^[0-9]+$ ]] && [ "$age" -le "$active_secs" ]; then
          fleet="HOLD"; codes="active"; extra="last $prov session $(human_age "$age") ago (inside $active_within)"
        elif [ -n "$age" ]; then
          fleet="SAFE-TO-PURGE"; extra="last $prov trace $(human_age "$age") ago (scan: $history_label)"
        else
          fleet="SAFE-TO-PURGE"; extra="no Codex/Claude trace found (scan: $history_label)"
        fi ;;
      KEEP|PRUNE)
        [ -n "$age" ] && extra="last $prov trace $(human_age "$age") ago (scan: $history_label)" ;;
    esac

    size_kb=""; head=""; common_dir=""; git_dir=""
    if [ "$want_size" -eq 1 ] && [ -d "$path" ]; then
      size_kb=$(du -sk "$path" 2>/dev/null | awk '{print $1}')
    fi
    if [ -d "$path" ]; then
      head=$(git -C "$path" rev-parse HEAD 2>/dev/null || true)
      common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
      git_dir=$(git -C "$path" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)
    fi

    case "$fleet" in
      SAFE-TO-PURGE) n_safe=$((n_safe + 1)); [ -n "$size_kb" ] && safe_kb=$((safe_kb + size_kb)) ;;
      HOLD) n_hold=$((n_hold + 1)) ;;
      KEEP) n_keep=$((n_keep + 1)) ;;
      PRUNE) n_prune=$((n_prune + 1)) ;;
    esac

    printf '%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\n' \
      "$main_wt" "$path" "${br#refs/heads/}" "$fleet" "$reason" "$extra" "$prov" "$age" "$size_kb" \
      "$head" "$br" "$common_dir" "$git_dir" "$codes" >> "$rows"
  done < <(list_worktrees)
done

if [ "$want_manifest" -eq 1 ]; then
  python3 "$SCRIPT_DIR/manifest.py" create \
    --rows "$rows" \
    --created-at-epoch "$audit_epoch" \
    --active-within "$active_within" \
    --active-within-seconds "$active_secs" \
    --all-history "$all_history"
  exit $?
fi

if [ "$want_json" -eq 1 ]; then
  python3 - "$rows" "$active_within" "$history_label" <<'PY'
import json, sys
cols = ["repo", "path", "branch", "verdict", "reason", "extra", "session_provider", "session_age_seconds", "size_kb"]
rows = []
with open(sys.argv[1]) as fh:
    for line in fh:
        fields = line.rstrip("\n").split("\x1f")
        row = dict(zip(cols, fields[:len(cols)]))
        row["codes"] = [] if fields[-1] in ("", "-") else fields[-1].split(",")
        for k in ("session_age_seconds", "size_kb"):
            row[k] = int(row[k]) if row.get(k, "").isdigit() else None
        rows.append(row)
print(json.dumps({
    "activeWithin": sys.argv[2],
    "history": sys.argv[3],
    "rows": rows,
}, indent=1))
PY
  exit 0
fi

first=1
while IFS=$'\x1f' read -r repo path branch fleet reason extra _prov _age size_kb _head _branch_ref _common_dir _git_dir codes; do
  if [ "$first" -eq 1 ]; then
    printf '%-14s %-34s %-10s %s\n' VERDICT BRANCH SIZE-KB "PATH — REASON"
    printf '%s\n' "--------------------------------------------------------------------------------------------------------"
    first=0
  fi
  disp="${path/#$HOME/~}"
  printf '%-14s %-34s %-10s %s — %s%s%s\n' "$fleet" "${branch:0:34}" "${size_kb:--}" "$disp" "$reason" "${extra:+; $extra}" "$([ "$codes" != - ] && printf ' [%s]' "$codes")"
done < "$rows"
[ "$first" -eq 0 ] && echo

echo "Totals: $n_safe safe-to-purge, $n_hold hold, $n_keep keep, $n_prune prune (active: $active_within; history: $history_label)"
if [ "$want_size" -eq 1 ] && [ "$safe_kb" -gt 0 ]; then echo "Reclaimable size (safe rows for this run): $((safe_kb / 1024)) MB"; fi
echo "HOLD rows age out: re-run later. Purge only via scripts/reclaim.sh <path> --yes per approved target."

# Orphaned DevPod registrations: workspace rows whose source checkout is gone.
# Report-only; neither this skill nor reclaim.sh deletes a runtime.
if command -v devpod >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  orphans=$(devpod list --output json 2>/dev/null \
    | jq -r '.[] | select(.source.localFolder != null and .source.localFolder != "") | [.id, .source.localFolder] | @tsv' 2>/dev/null \
    | while IFS=$'\t' read -r id src; do [ -d "$src" ] || printf '%s\t%s\n' "$id" "$src"; done)
  if [ -n "$orphans" ]; then
    echo
    echo "DevPod registrations with missing source paths (report-only):"
    printf '%s\n' "$orphans" | awk -F'\t' '{printf "  %s -> %s\n", $1, $2}'
  fi
fi

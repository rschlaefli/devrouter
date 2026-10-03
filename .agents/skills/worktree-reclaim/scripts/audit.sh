#!/usr/bin/env bash
# Read-only worktree audit. Deletes nothing, ever.
# Usage: audit.sh [repo-path] [--tsv]
#   --tsv prints VERDICT<TAB>path<TAB>branch<TAB>codes<TAB>reason per worktree.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${1:-.}" 2>/dev/null || { echo "not a directory: ${1:-.}" >&2; exit 1; }
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "not a git repo" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)" || exit 1

# shellcheck source=lib-classify.sh
. "$SCRIPT_DIR/lib-classify.sh"

tsv=0
for a in "$@"; do [ "$a" = "--tsv" ] && tsv=1; done

WORKTREE_RECLAIM_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/worktree-reclaim-run.XXXXXX")"
export WORKTREE_RECLAIM_RUN_DIR
trap 'rm -rf "$WORKTREE_RECLAIM_RUN_DIR"' EXIT

if [ "$tsv" -eq 0 ]; then
  repo_stash_report
  disposable_override_note .
  printf '%-46s %-38s %-8s %s\n' WORKTREE BRANCH VERDICT REASON
  printf '%s\n' "-----------------------------------------------------------------------------------------------------------------"
fi

n_reclaim=0
while IFS=$'\t' read -r path br; do
  [ -z "$path" ] && continue
  IFS=$'\t' read -r verdict codes reason < <(classify_worktree "$path" "$br")
  [ "$verdict" = "RECLAIM" ] && n_reclaim=$((n_reclaim+1))
  if [ "$tsv" -eq 1 ]; then
    printf '%s\t%s\t%s\t%s\t%s\n' "$verdict" "$path" "${br#refs/heads/}" "$codes" "$reason"
  else
    disp=$(printf '%s' "$path" | awk -F/ '{print $(NF-1)"/"$NF}')
    printf '%-46s %-38s %-8s %s\n' "$disp" "${br#refs/heads/}" "$verdict" "$reason$([ "$codes" != - ] && printf ' [%s]' "$codes")"
  fi
done < <(list_worktrees)

if [ "$tsv" -eq 0 ]; then
  echo
  echo "$n_reclaim reclaimable. Reclaim one:  scripts/reclaim.sh <worktree-path> --yes"
  echo "KEEP rows are never touched without your say-so."
fi

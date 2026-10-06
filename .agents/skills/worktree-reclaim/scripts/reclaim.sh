#!/usr/bin/env bash
# Reclaim ONE worktree and its branch. Dry-run by default; pass --yes to execute.
#
# Usage: reclaim.sh <worktree-path> [--yes] [--keep-branch] [identity guards]
#                   [--receipt FILE --manifest-sha256 SHA --candidate-id ID]
#
# This script never deletes a runtime. A tree bound to devrouter, DevPod or
# Devsy state classifies as KEEP (runtime-present), and devrouter tears it down.
#
# Safety model — three independent layers, because --yes performs destructive
# teardown after the user approves an exact reclaim target:
#   1. Re-classify HERE via the shared lib. Never trust a verdict read earlier:
#      the tree can go dirty, or a PR can reopen, between audit and reclaim.
#   2. `git worktree remove` runs WITHOUT --force, so git independently refuses
#      a dirty or untracked-carrying tree even if layer 1 somehow passed.
#   3. No `rm -rf`, ever. If a directory survives, say so and stop — a leftover
#      directory is a cheap annoyance; a wrongly deleted one is unrecoverable.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

path="${1:-}"; shift || true
[ -z "$path" ] && {
  echo "usage: reclaim.sh <worktree-path> [--yes] [--keep-branch] [--verify-only] [--expect-repo PATH --expect-branch REF --expect-head SHA --expect-common-dir PATH --expect-git-dir PATH] [--receipt FILE --manifest-sha256 SHA --candidate-id ID]" >&2
  exit 2
}

execute=0; keep_branch=0; verify_only=0
expected_repo=""; expected_branch=""; expected_head=""; expected_common_dir=""; expected_git_dir=""
receipt=""; manifest_sha=""; candidate_id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) execute=1; shift ;;
    --keep-branch) keep_branch=1; shift ;;
    --verify-only) verify_only=1; shift ;;
    --expect-repo) expected_repo="${2:?--expect-repo needs a path}"; shift 2 ;;
    --expect-branch) expected_branch="${2:?--expect-branch needs a ref}"; shift 2 ;;
    --expect-head) expected_head="${2:?--expect-head needs an object ID}"; shift 2 ;;
    --expect-common-dir) expected_common_dir="${2:?--expect-common-dir needs a path}"; shift 2 ;;
    --expect-git-dir) expected_git_dir="${2:?--expect-git-dir needs a path}"; shift 2 ;;
    --receipt) receipt="${2:?--receipt needs a path}"; shift 2 ;;
    --manifest-sha256) manifest_sha="${2:?--manifest-sha256 needs a digest}"; shift 2 ;;
    --candidate-id) candidate_id="${2:?--candidate-id needs an ID}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$execute" -eq 1 ] && [ "$verify_only" -eq 1 ] && {
  echo "--yes and --verify-only cannot be combined" >&2
  exit 2
}

path="$(cd "$path" 2>/dev/null && pwd -P || echo "$path")"
# shellcheck source=lib-classify.sh
. "$SCRIPT_DIR/lib-classify.sh"

worktree_root="$(git -C "$path" rev-parse --show-toplevel 2>/dev/null || true)"
[ "$worktree_root" = "$path" ] || {
  echo "REFUSING: target must be the exact root of a registered worktree: $path" >&2
  exit 1
}
common_dir="$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
main_wt="$(printf '%s\n' "$common_dir" | sed 's|/\.git$||')"
[ -z "$main_wt" ] && { echo "cannot resolve main checkout for $path" >&2; exit 1; }
main_wt="$(cd "$main_wt" 2>/dev/null && pwd -P || true)"
[ -z "$main_wt" ] && { echo "cannot resolve main checkout for $path" >&2; exit 1; }
[ "$path" != "$main_wt" ] || {
  echo "REFUSING: the primary checkout is never a reclaim target: $path" >&2
  exit 1
}
cd "$main_wt" || exit 1

branch_ref=$(git -C "$path" symbolic-ref --quiet HEAD 2>/dev/null || echo "(detached)")
branch="${branch_ref#refs/heads/}"
current_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || true)
git_dir=$(git -C "$path" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)

identity_mismatch() {
  local label="$1" expected="$2" actual="$3"
  [ -z "$expected" ] || [ "$expected" = "$actual" ] || {
    echo "REFUSING: $label changed since approval (expected '$expected'; got '$actual')." >&2
    exit 1
  }
}

identity_mismatch "repository" "$expected_repo" "$main_wt"
identity_mismatch "branch" "$expected_branch" "$branch_ref"
identity_mismatch "HEAD" "$expected_head" "$current_head"
identity_mismatch "Git common directory" "$expected_common_dir" "$common_dir"
identity_mismatch "worktree Git directory" "$expected_git_dir" "$git_dir"

# --- Layer 1: independent re-verification -------------------------------------
IFS=$'\t' read -r verdict codes reason < <(classify_worktree "$path" "$branch_ref")
echo "worktree : $path"
echo "branch   : $branch"
echo "verdict  : $verdict — $reason"
[ "$codes" != - ] && echo "codes    : $codes"
echo

if [ "$verdict" != "RECLAIM" ]; then
  echo "REFUSING: only RECLAIM is auto-removable. This is '$verdict'."
  echo "If you have decided this should go anyway, act on it deliberately by hand."
  exit 1
fi

if [ "$verify_only" -eq 1 ]; then
  echo "Identity and reclaim eligibility verified."
  exit 0
fi

# Snapshot the branch tip that the RECLAIM verdict was computed against. Teardown
# takes a few seconds; a parallel agent (or the user) could commit to this branch
# in that window. `git worktree remove` still succeeds on a clean-but-newly-
# committed tree, so without this snapshot `git branch -D` below would silently
# drop those fresh unpushed commits. Re-checked immediately before the delete.
verified_head="$current_head"

run() {
  if [ "$execute" -eq 1 ]; then
    echo "+ $*"; "$@"
  else
    echo "  (dry-run) $*"
  fi
}

# --- git worktree: no --force, so git re-checks dirtiness itself ---------------
echo "== git worktree remove"
if [ "$execute" -eq 1 ]; then
  live_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || true)
  live_branch_ref=$(git -C "$path" symbolic-ref --quiet HEAD 2>/dev/null || echo "(detached)")
  live_git_dir=$(git -C "$path" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)
  if [ "$live_head" != "$verified_head" ] || [ "$live_branch_ref" != "$branch_ref" ] || [ "$live_git_dir" != "$git_dir" ]; then
    echo "REFUSING: worktree identity changed since the verdict; leaving Git worktree and branch in place." >&2
    exit 1
  fi
fi
run git worktree remove "$path"

if [ "$execute" -eq 1 ] && [ -d "$path" ]; then
  echo
  echo "WARNING: $path still exists — git declined to remove it."
  echo "Left in place on purpose. Inspect it; this script will not rm -rf."
  exit 1
fi

# --- branch: -D is required because squash merges leave no ancestry ------------
# `git branch -d` refuses a squash-merged branch as 'not fully merged', so -d is
# useless here. -D is safe ONLY because layer 1 proved via the forge that the PR
# merged and that local holds no commits beyond the merged head.
if [ "$keep_branch" -eq 0 ] && [ "$branch" != "(detached)" ]; then
  # TOCTOU re-check: the branch ref still resolves after the worktree is gone.
  # If its tip moved since the verdict, someone committed during teardown and
  # those commits are unpushed — refuse the -D rather than destroy them.
  current_head=$(git rev-parse "refs/heads/$branch" 2>/dev/null || true)
  if [ "$execute" -eq 1 ] && [ -n "$verified_head" ] && [ "$current_head" != "$verified_head" ]; then
    echo "WARNING: $branch tip moved during teardown ($verified_head -> $current_head)."
    echo "New commits appeared after the verdict. Keeping the branch; delete it by hand once reviewed."
    exit 1
  fi
  echo "== git branch -D $branch"
  run git branch -D "$branch"
fi

# A receipt lets a re-run of the same approved manifest recognise this target as
# done once its directory is gone, instead of reporting it stale.
if [ "$execute" -eq 1 ] && [ -n "$receipt" ]; then
  python3 - "$receipt" "$manifest_sha" "$candidate_id" "$path" "$branch_ref" "$verified_head" "$keep_branch" <<'PY'
import json, os, sys, time
target, sha, cid, path, ref, head, keep_branch = sys.argv[1:]
steps = ["worktree-removed"] + ([] if keep_branch == "1" else ["branch-deleted"])
os.makedirs(os.path.dirname(target), exist_ok=True)
with open(target, "w", encoding="utf-8") as handle:
    json.dump({
        "branchRef": ref,
        "candidateId": cid,
        "completedAtEpoch": int(time.time()),
        "head": head,
        "kind": "worktree-reclaim-receipt",
        "manifestSha256": sha,
        "path": path,
        "schemaVersion": 1,
        "steps": steps,
        "tool": "worktree-reclaim-skill",
    }, handle, ensure_ascii=False, indent=2, sort_keys=True)
    handle.write("\n")
PY
fi

echo
if [ "$execute" -eq 1 ]; then
  echo "Reclaimed: $path"
else
  echo "Dry run only. Re-run with --yes to execute."
fi

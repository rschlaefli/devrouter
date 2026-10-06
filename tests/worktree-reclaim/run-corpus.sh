#!/usr/bin/env bash
# Runs every worktree-safety scenario through the skill's classifier under
# each forge mode and compares verdict and reason codes with expected.tsv.
# Uses temporary repositories, a temporary HOME and stub forge and runtime
# CLIs only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORPUS="$ROOT/tests/worktree-safety"
SCRIPTS="$ROOT/.agents/skills/worktree-reclaim/scripts"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/worktree-safety-corpus.XXXXXX")"
trap 'chmod -R u+rwX "$TEST_ROOT" 2>/dev/null || true; rm -rf "$TEST_ROOT"' EXIT

export HOME="$TEST_ROOT/home"
mkdir -p "$HOME"
export PATH="$CORPUS/stubs:$PATH"
export WORKTREE_RECLAIM_FORGE_RETRY_DELAY=0
unset WORKTREE_RECLAIM_FORGE WORKTREE_RECLAIM_GITLAB_HOSTS WORKTREE_RECLAIM_RUN_DIR

expected() {
  awk -F'\t' -v s="$1" -v f="$2" '
    /^#/ { next }
    $1 == s && $2 == f { exact = $3 "\t" $4 }
    $1 == s && $2 == "*" { any = $3 "\t" $4 }
    END { print (exact != "" ? exact : any) }
  ' "$CORPUS/expected.tsv"
}

failures=0; runs=0
scenarios=$(awk -F'\t' '!/^#/ && NF { print $1 }' "$CORPUS/expected.tsv" | sort -u)
for forge in github github-bulk gitlab; do
  case "$forge" in
    gitlab) origin="git@gitlab.example.com:group/repo.git" ;;
    *) origin="git@github.com:example/repo.git" ;;
  esac
  for scenario in $scenarios; do
    dir="$TEST_ROOT/$forge/$scenario"
    mkdir -p "$dir/tmp"
    target=$(CORPUS_ORIGIN="$origin" "$CORPUS/build-scenario.sh" "$scenario" "$dir")
    IFS=$'\t' read -r path ref <<<"$target"
    if [ "$forge" = github-bulk ]; then ttl=600; else ttl=0; fi
    actual=$(
      cd "$dir/repo"
      export CORPUS_DIR="$dir" TMPDIR="$dir/tmp" WORKTREE_RECLAIM_PR_CACHE_TTL="$ttl"
      export WORKTREE_RECLAIM_DEVROUTER_HOME="$dir/devrouter-home"
      # shellcheck source=../../.agents/skills/worktree-reclaim/scripts/lib-classify.sh
      . "$SCRIPTS/lib-classify.sh"
      # Read the verdict the way the skill's callers do: bash 3.2 hands a
      # temporary IFS to the process substitution.
      IFS=$'\t' read -r verdict codes _ < <(classify_worktree "$path" "$ref")
      printf '%s\t%s\n' "$verdict" "$codes"
    )
    want=$(expected "$scenario" "$forge")
    runs=$((runs + 1))
    if [ "$actual" != "$want" ]; then
      printf 'FAIL %-26s %-12s expected [%s] got [%s]\n' "$scenario" "$forge" "$want" "$actual" >&2
      failures=$((failures + 1))
    fi
  done
done

if [ "$failures" -gt 0 ]; then
  printf 'FAIL: %d of %d corpus runs disagree with expected.tsv\n' "$failures" "$runs" >&2
  exit 1
fi
printf 'PASS: %d corpus runs (%s)\n' "$runs" "github, github-bulk, gitlab"

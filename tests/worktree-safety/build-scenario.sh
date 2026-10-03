#!/usr/bin/env bash
# Builds one worktree-safety scenario in an empty directory.
#
# usage: build-scenario.sh <scenario> <dir>
#
# Creates <dir>/repo (primary checkout, origin URL from $CORPUS_ORIGIN) with a
# linked worktree <dir>/wt on branch feat/x, writes the forge and runtime
# fixtures the stubs read, and prints "path<TAB>branch-ref" for the target.
# Scenario names and their expected verdicts live in expected.tsv.
set -euo pipefail

scenario="$1"; dir="$2"
repo="$dir/repo"; wt="$dir/wt"; branch="feat/x"
: "${CORPUS_ORIGIN:?CORPUS_ORIGIN is required}"

git init -q -b main "$repo"
git -C "$repo" config user.email corpus@example.invalid
git -C "$repo" config user.name "Worktree Safety Corpus"
printf 'node_modules/\ndist/\n.next/\nuploads/\n*.local\n' > "$repo/.gitignore"
printf 'fixture\n' > "$repo/README.md"
git -C "$repo" add .gitignore README.md
git -C "$repo" commit -qm "test: seed fixture"
git -C "$repo" remote add origin "$CORPUS_ORIGIN"
git -C "$repo" worktree add -q -b "$branch" "$wt" main
printf 'feature\n' > "$wt/feature.txt"
git -C "$wt" add feature.txt
git -C "$wt" commit -qm "feat: add feature"
head=$(git -C "$wt" rev-parse HEAD)
git_dir=$(git -C "$wt" rev-parse --absolute-git-dir)
common_dir=$(git -C "$repo" rev-parse --absolute-git-dir)
wt_real=$(cd "$wt" && pwd -P)
target="$wt"; target_ref="refs/heads/$branch"

pr() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "${5:-false}" >> "$dir/prs.tsv"; }
merged() { pr "$branch" MERGED 10 "$head"; }

case "$scenario" in
  clean-merged) merged ;;
  primary) target="$repo"; target_ref="refs/heads/main" ;;
  detached) merged; git -C "$wt" checkout -q --detach ;;
  locked) merged; git -C "$repo" worktree lock --reason "agent at work" "$wt" ;;
  index-lock) merged; : > "$git_dir/index.lock" ;;
  operation-in-progress) merged; printf '%s\n' "$head" > "$git_dir/MERGE_HEAD" ;;
  submodule) merged; mkdir -p "$git_dir/modules/lib" ;;
  dirty) merged; printf 'changed\n' >> "$wt/README.md" ;;
  untracked) merged; printf 'draft\n' > "$wt/notes.txt" ;;
  ignored-state) merged; mkdir -p "$wt/uploads"; printf 'data\n' > "$wt/uploads/photo.png" ;;
  git-error) merged; chmod 000 "$git_dir/index" ;;
  runtime-devpod)
    merged
    printf '[{"id":"corpus-x","source":{"localFolder":"%s"}}]\n' "$wt_real" > "$dir/devpod.json" ;;
  runtime-devsy)
    merged
    printf '[{"id":"corpus-x","source":{"localFolder":"%s"}}]\n' "$wt_real" > "$dir/devsy.json" ;;
  runtime-route)
    merged
    mkdir -p "$dir/devrouter-home"
    printf '[{"name":"web","repoPath":"%s"}]\n' "$wt_real" > "$dir/devrouter-home/host-routes-state.json" ;;
  runtime-ledger)
    merged
    mkdir -p "$common_dir/devrouter/workspaces"
    printf '{"worktreePath":"%s"}\n' "$wt_real" > "$common_dir/devrouter/workspaces/x.json" ;;
  runtime-unlistable) merged; : > "$dir/devpod-down" ;;
  forge-unavailable) merged; : > "$dir/forge-down" ;;
  no-change) ;;
  change-open) pr "$branch" OPEN 10 "$head" ;;
  change-closed) pr "$branch" CLOSED 10 "$head" ;;
  head-beyond-merge)
    merged
    printf 'later\n' > "$wt/later.txt"
    git -C "$wt" add later.txt
    git -C "$wt" commit -qm "feat: add after merge" ;;
  merged-head-unknown) pr "$branch" MERGED 10 "" ;;
  squash-merge)
    merged
    git -C "$repo" merge -q --squash "$branch" >/dev/null
    git -C "$repo" commit -qm "feat: add feature (#10)" ;;
  behind-merged-head)
    printf 'review fix\n' > "$wt/fix.txt"
    git -C "$wt" add fix.txt
    git -C "$wt" commit -qm "fix: address review"
    pr "$branch" MERGED 10 "$(git -C "$wt" rev-parse HEAD)"
    git -C "$wt" reset -q --hard HEAD~1 ;;
  deleted-source-branch)
    merged
    git -C "$wt" config "branch.$branch.remote" origin
    git -C "$wt" config "branch.$branch.merge" "refs/heads/$branch" ;;
  stacked-base) merged; pr feat/base OPEN 9 "$head" ;;
  older-merged-newer-open) merged; pr "$branch" OPEN 11 "$head" ;;
  older-open-newer-merged) pr "$branch" CLOSED 9 "$head"; merged ;;
  fork-only) pr "$branch" MERGED 10 "$head" true ;;
  fork-newer) merged; pr "$branch" OPEN 11 "$head" true ;;
  disposable)
    merged
    mkdir -p "$wt/node_modules/pkg" "$wt/apps/web/.next" "$wt/dist"
    printf 'x\n' > "$wt/node_modules/pkg/index.js"
    printf 'x\n' > "$wt/apps/web/.next/build.json"
    printf 'x\n' > "$wt/dist/out.js"
    : > "$wt/empty.local" ;;
  override-legacy)
    merged
    mkdir -p "$wt/uploads"; printf 'data\n' > "$wt/uploads/photo.png"
    printf '*/uploads/\n' > "$common_dir/info/worktree-reclaim-disposable" ;;
  override-pattern)
    merged
    mkdir -p "$wt/uploads"; printf 'data\n' > "$wt/uploads/photo.png"
    printf '# local caches\n**/uploads\n' > "$common_dir/info/worktree-reclaim-disposable" ;;
  prune) merged; rm -rf "$wt" ;;
  *) echo "unknown scenario: $scenario" >&2; exit 2 ;;
esac

printf '%s\t%s\n' "$target" "$target_ref"

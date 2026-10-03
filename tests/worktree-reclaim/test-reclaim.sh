#!/usr/bin/env bash
# Deterministic tests for forge retries and caching, Git probe failures, the
# session index and worktree discovery. Per-code verdicts live in the corpus
# (run-corpus.sh). Creates only temporary repositories and never invokes
# reclaim.sh or any real forge.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.agents/skills/worktree-reclaim"
# shellcheck source=../scripts/lib-classify.sh
. "$SKILL_DIR/scripts/lib-classify.sh"
# shellcheck source=../scripts/lib-sessions.sh
. "$SKILL_DIR/scripts/lib-sessions.sh"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/worktree-reclaim-test.XXXXXX")"
trap 'chmod -R u+w "$TEST_ROOT" 2>/dev/null || true; rm -rf "$TEST_ROOT"' EXIT
export HOME="$TEST_ROOT/home" WORKTREE_RECLAIM_DEVROUTER_HOME="$TEST_ROOT/devrouter-home"
mkdir -p "$HOME"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local actual="$1" expected="$2"
  [[ "$actual" == *"$expected"* ]] || fail "expected [$actual] to contain [$expected]"
}

assert_empty() {
  [ -z "$1" ] || fail "expected empty output, got [$1]"
}

make_stub() {
  local path="$1"
  shift
  printf '%s\n' '#!/usr/bin/env bash' "$@" > "$path"
  chmod +x "$path"
}

STUBS="$TEST_ROOT/bin"
mkdir -p "$STUBS"
REAL_GIT=$(command -v git)
make_stub "$STUBS/gh" \
  'if [ -n "${GH_FAIL_ONCE:-}" ] && [ -f "$GH_FAIL_ONCE" ]; then rm -f "$GH_FAIL_ONCE"; exit 1; fi' \
  'printf "MERGED 42 %s\n" "$TEST_HEAD"'
# Runtime CLIs answer "nothing bound" so a host DevPod or Devsy never leaks in.
make_stub "$STUBS/devpod" "echo '[]'"
make_stub "$STUBS/devsy" "echo '[]'"
make_stub "$STUBS/glab" 'printf "[{\"state\":\"merged\",\"iid\":7,\"sha\":\"%s\",\"source_project_id\":1,\"target_project_id\":1}]\n" "$TEST_HEAD"'
make_stub "$STUBS/git" \
  'if [ "${FAIL_GIT_PROBE:-}" = operation ] && [ "$1" = -C ] && [ "$3" = rev-parse ] && [[ " $* " == *" --git-path "* ]]; then exit 1; fi' \
  'if [ "${FAIL_GIT_PROBE:-}" = lock ] && [[ " $* " == *" worktree list --porcelain "* ]]; then exit 1; fi' \
  'exec "$REAL_GIT" "$@"'
export REAL_GIT
export PATH="$STUBS:$PATH"
# Each case needs live stub answers, not a bulk PR listing cached by an earlier case.
export WORKTREE_RECLAIM_PR_CACHE_TTL=0

make_repo() {
  local repo="$1" remote="$2"
  git init -q "$repo"
  git -C "$repo" config user.email test@example.invalid
  git -C "$repo" config user.name "Worktree Reclaim Test"
  printf 'node_modules/\ndist/\nlocal-state/\n.husky/_/\n*.tsbuildinfo\n' > "$repo/.gitignore"
  printf 'fixture\n' > "$repo/README.md"
  git -C "$repo" add .gitignore README.md
  git -C "$repo" commit -qm "test: seed fixture"
  git -C "$repo" branch -M main
  git -C "$repo" remote add origin "$remote"
}

classify() {
  local repo="$1" worktree="$2" branch="$3"
  (
    cd "$repo"
    classify_worktree "$worktree" "refs/heads/$branch"
  )
}

GITHUB_REPO="$TEST_ROOT/github"
GITHUB_WT="$TEST_ROOT/github-worktree"
make_repo "$GITHUB_REPO" git@github.com:example/repo.git
git -C "$GITHUB_REPO" worktree add -qb feat/github "$GITHUB_WT" main
export TEST_HEAD
TEST_HEAD=$(git -C "$GITHUB_WT" rev-parse HEAD)

mkdir -p "$GITHUB_WT/node_modules/example"
printf 'generated\n' > "$GITHUB_WT/node_modules/example/index.js"
mkdir -p "$GITHUB_WT/.husky/_"
printf 'generated hook\n' > "$GITHUB_WT/.husky/_/pre-commit"
printf 'generated cache\n' > "$GITHUB_WT/fixture.tsbuildinfo"
result=$(classify "$GITHUB_REPO" "$GITHUB_WT" feat/github)
assert_contains "$result" $'RECLAIM\t-\tMERGED #42'

# One transient forge failure is retried instead of degrading to KEEP.
export GH_FAIL_ONCE="$TEST_ROOT/gh-fail-once" WORKTREE_RECLAIM_FORGE_RETRY_DELAY=0
touch "$GH_FAIL_ONCE"
result=$(classify "$GITHUB_REPO" "$GITHUB_WT" feat/github)
assert_contains "$result" $'RECLAIM\t-\tMERGED #42'
[ ! -e "$GH_FAIL_ONCE" ] || fail "forge stub was not called"
unset GH_FAIL_ONCE

# A bulk PR listing answers every branch it contains without per-branch calls.
make_stub "$STUBS/gh-bulk" \
  'printf "%s\n" "$*" >> "$GH_CALLS"' \
  'case " $* " in *" --head "*) printf "OPEN 99 %s\n" "$TEST_HEAD" ;; *) printf "feat/github\tMERGED\t42\t%s\nfeat/github\tCLOSED\t17\t%s\n" "$TEST_HEAD" "$TEST_HEAD" ;; esac'
mkdir -p "$TEST_ROOT/bulk-bin" "$TEST_ROOT/bulk-tmp"
mv "$STUBS/gh-bulk" "$TEST_ROOT/bulk-bin/gh"
export GH_CALLS="$TEST_ROOT/gh-calls.log"
: > "$GH_CALLS"
for _ in 1 2; do
  result=$(PATH="$TEST_ROOT/bulk-bin:$PATH" TMPDIR="$TEST_ROOT/bulk-tmp" WORKTREE_RECLAIM_PR_CACHE_TTL=600 \
    classify "$GITHUB_REPO" "$GITHUB_WT" feat/github)
  assert_contains "$result" $'RECLAIM\t-\tMERGED #42'
done
# A branch absent from the listing has no PR: KEEP, without a per-branch call.
git -C "$GITHUB_REPO" branch -q feat/unlisted main
result=$(PATH="$TEST_ROOT/bulk-bin:$PATH" TMPDIR="$TEST_ROOT/bulk-tmp" WORKTREE_RECLAIM_PR_CACHE_TTL=600 \
  classify "$GITHUB_REPO" "$GITHUB_WT" feat/unlisted)
assert_contains "$result" $'KEEP\tno-change\t'
[ "$(wc -l < "$GH_CALLS" | tr -d ' ')" = 1 ] || fail "expected one cached bulk listing, got: $(cat "$GH_CALLS")"
git -C "$GITHUB_REPO" branch -q -D feat/unlisted
unset GH_CALLS

# A failing Git probe is its own code, so a broken check never reads as clean.

result=$(
  (
    export FAIL_GIT_PROBE=operation
    classify "$GITHUB_REPO" "$GITHUB_WT" feat/github
  )
)
assert_contains "$result" $'KEEP\tgit-error\t'
assert_contains "$result" "git operation check failed"

result=$(
  (
    export FAIL_GIT_PROBE=lock
    classify "$GITHUB_REPO" "$GITHUB_WT" feat/github
  )
)
assert_contains "$result" $'KEEP\tgit-error\t'
assert_contains "$result" "worktree lock check failed"

GITLAB_REPO="$TEST_ROOT/gitlab"
GITLAB_WT="$TEST_ROOT/gitlab-worktree"
make_repo "$GITLAB_REPO" git@gitlab.example.com:group/repo.git
git -C "$GITLAB_REPO" worktree add -qb feat/gitlab "$GITLAB_WT" main
TEST_HEAD=$(git -C "$GITLAB_WT" rev-parse HEAD)
result=$(classify "$GITLAB_REPO" "$GITLAB_WT" feat/gitlab)
assert_contains "$result" $'RECLAIM\t-\tMERGED !7'

CODEX_STORE="$TEST_ROOT/codex"
CLAUDE_STORE="$TEST_ROOT/claude"
mkdir -p "$CODEX_STORE/2020/01/01" "$CLAUDE_STORE"
SESSION="$CODEX_STORE/2020/01/01/rollout.jsonl"
printf '{"type":"session_meta","payload":{"cwd":"%s"}}\n' "$GITHUB_REPO" > "$SESSION"
printf '{"type":"response_item","payload":{"arguments":"{\\\"workdir\\\":\\\"%s\\\"}"}}\n' "$GITHUB_WT" >> "$SESSION"
touch -t 202001010000 "$SESSION"

export WORKTREE_RECLAIM_CODEX_SESSIONS_DIR="$CODEX_STORE"
export WORKTREE_RECLAIM_CLAUDE_PROJECTS_DIR="$CLAUDE_STORE"
export WORKTREE_RECLAIM_NOW_EPOCH=2000000000

CACHE="$TEST_ROOT/sessions.tsv"
build_session_index "$CACHE" 60 0
assert_empty "$(session_last_activity "$CACHE" "$GITHUB_WT")"

build_session_index "$CACHE" 60 1
result=$(session_last_activity "$CACHE" "$GITHUB_WT")
assert_contains "$result" $'codex\t'

CLAUDE_PROJECT="$CLAUDE_STORE/worktree"
mkdir -p "$CLAUDE_PROJECT"
printf '{"cwd":"%s"}\n' "$GITLAB_WT" > "$CLAUDE_PROJECT/session.jsonl"
python3 - "$CLAUDE_PROJECT/session.jsonl" "$WORKTREE_RECLAIM_NOW_EPOCH" <<'PY'
import os
import sys

recent = int(sys.argv[2]) - 10
os.utime(sys.argv[1], (recent, recent))
PY
build_session_index "$CACHE" 60 0
result=$(session_last_activity "$CACHE" "$GITLAB_WT")
assert_contains "$result" $'claude\t'

CLAUDE_MIXED_WT="$TEST_ROOT/claude-mixed-worktree"
git -C "$GITLAB_REPO" worktree add -qb feat/claude-mixed "$CLAUDE_MIXED_WT" main
printf '{"cwd":"%s"}\n' "$CLAUDE_MIXED_WT" > "$CLAUDE_PROJECT/old-session.jsonl"
touch -t 202001010000 "$CLAUDE_PROJECT/old-session.jsonl"
build_session_index "$CACHE" 60 0
result=$(session_last_activity "$CACHE" "$GITLAB_WT")
assert_contains "$result" $'claude\t'
result=$(session_last_activity "$CACHE" "$CLAUDE_MIXED_WT")
assert_contains "$result" $'claude\t'

CLAUDE_DEEP_WT="$TEST_ROOT/claude-deep-worktree"
git -C "$GITLAB_REPO" worktree add -qb feat/claude-deep "$CLAUDE_DEEP_WT" main
CLAUDE_OLD_PROJECT="$CLAUDE_STORE/old-worktree"
mkdir -p "$CLAUDE_OLD_PROJECT"
printf '{"cwd":"%s"}\n' "$GITLAB_REPO" > "$CLAUDE_OLD_PROJECT/session.jsonl"
for _ in $(seq 1 100); do printf '{"type":"progress"}\n' >> "$CLAUDE_OLD_PROJECT/session.jsonl"; done
printf '{"workdir":"%s"}\n' "$CLAUDE_DEEP_WT" >> "$CLAUDE_OLD_PROJECT/session.jsonl"
touch -t 202001010000 "$CLAUDE_OLD_PROJECT/session.jsonl"
build_session_index "$CACHE" 60 0
assert_empty "$(session_last_activity "$CACHE" "$CLAUDE_DEEP_WT")"
build_session_index "$CACHE" 60 1
result=$(session_last_activity "$CACHE" "$CLAUDE_DEEP_WT")
assert_contains "$result" $'claude\t'

UNTRACED_WT="$TEST_ROOT/untraced-worktree"
git -C "$GITHUB_REPO" worktree add -qb feat/untraced "$UNTRACED_WT" main
listed=$(
  cd "$GITHUB_REPO"
  list_worktrees
)
UNTRACED_WT_CANON=$(cd "$UNTRACED_WT" && pwd -P)
assert_contains "$listed" "$UNTRACED_WT_CANON"
assert_empty "$(session_last_activity "$CACHE" "$UNTRACED_WT")"

FUTURE_SESSION="$CODEX_STORE/2020/01/01/future.jsonl"
printf '{"cwd":"%s"}\n' "$UNTRACED_WT" > "$FUTURE_SESSION"
python3 - "$FUTURE_SESSION" "$WORKTREE_RECLAIM_NOW_EPOCH" <<'PY'
import os
import sys

future = int(sys.argv[2]) + 3600
os.utime(sys.argv[1], (future, future))
PY
build_session_index "$CACHE" 60 0
result=$(session_last_activity "$CACHE" "$UNTRACED_WT")
assert_contains "$result" $'codex\t0'

ln -s "$TEST_ROOT/missing-session" "$CODEX_STORE/2020/01/01/unreadable.jsonl"
if build_session_index "$CACHE" 60 1 2>/dev/null; then
  fail "expected an incomplete session index to fail closed"
fi
rm "$CODEX_STORE/2020/01/01/unreadable.jsonl"

# Recent-only mode skips files outside the window entirely, which is what the
# per-target session veto needs.
build_session_index "$CACHE" 60 recent
assert_empty "$(session_last_activity "$CACHE" "$GITHUB_WT")"
assert_contains "$(session_last_activity "$CACHE" "$GITLAB_WT")" $'claude\t'

VETO="$SKILL_DIR/scripts/session-veto.sh"
if WORKTREE_RECLAIM_ACTIVE_WITHIN=60s "$VETO" "$GITLAB_WT" 2>/dev/null; then
  fail "expected the session veto to refuse an active worktree"
fi
WORKTREE_RECLAIM_ACTIVE_WITHIN=60s "$VETO" "$GITHUB_WT" || fail "expected the session veto to allow a stale worktree"
set +e
WORKTREE_RECLAIM_CLAUDE_PROJECTS_DIR="$TEST_ROOT/none" WORKTREE_RECLAIM_CODEX_SESSIONS_DIR="$TEST_ROOT/none" \
  "$VETO" "$GITHUB_WT" 2>/dev/null
status=$?
set -e
[ "$status" -eq 2 ] || fail "expected the session veto to fail closed with status 2, got $status"

printf 'PASS: forge retry and caching, Git-probe failures, session index modes, session veto, and untraced discovery\n'

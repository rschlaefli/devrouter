#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_root=$(mktemp -d "/tmp/devrouter-cleanup-smoke.XXXXXX")
work_root=$(cd "$work_root" && pwd -P)
trap 'rm -rf "$work_root"' EXIT

run_with_timeout() {
  local timeout=$1
  shift
  "$@" &
  local child=$!
  (
    sleep "$timeout"
    kill -TERM "$child" 2>/dev/null || true
  ) &
  local watchdog=$!
  local status=0
  wait "$child" || status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$status"
}

repo="$work_root/repo"
home="$work_root/home"
bin="$work_root/bin"
real_git=$(command -v git)
mkdir -p "$repo" "$home" "$bin"

git -C "$repo" init -q -b main
git -C "$repo" config user.email smoke@example.invalid
git -C "$repo" config user.name "Devrouter Smoke"
printf 'version: 1\napps: []\n' > "$repo/.devrouter.yml"
git -C "$repo" add .devrouter.yml
GIT_AUTHOR_DATE="2026-06-01T12:00:00Z" GIT_COMMITTER_DATE="2026-06-01T12:00:00Z" git -C "$repo" commit -q -m initial

git -C "$repo" branch feature
mkdir -p "$repo/trees"
git -C "$repo" worktree add -q "$repo/trees/feature" feature
printf 'feature\n' > "$repo/trees/feature/feature.txt"
git -C "$repo/trees/feature" add feature.txt
GIT_AUTHOR_DATE="2026-06-02T12:00:00Z" GIT_COMMITTER_DATE="2026-06-02T12:00:00Z" git -C "$repo/trees/feature" commit -q -m feature
main_sha=$(git -C "$repo" rev-parse main)
feature_sha=$(git -C "$repo/trees/feature" rev-parse HEAD)
git -C "$repo" remote add origin git@github.com:smoke/devrouter.git
git -C "$repo" update-ref refs/remotes/origin/main "$main_sha"
git -C "$repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main

common_dir=$(git -C "$repo" rev-parse --git-common-dir)
if [[ "$common_dir" != /* ]]; then
  common_dir="$repo/$common_dir"
fi
mkdir -p "$common_dir/devrouter/workspaces"
cat > "$common_dir/devrouter/workspaces/feature.json" <<EOF
{
  "version": 1,
  "workspace": "feature",
  "worktreePath": "$repo/trees/feature",
  "branch": "feature",
  "devpodId": "feature",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "updatedAt": "2026-06-01T12:00:00.000Z"
}
EOF
feature_git_dir=$(git -C "$repo/trees/feature" rev-parse --path-format=absolute --git-dir)
printf 'feature\n' > "$feature_git_dir/devrouter-workspace"

route_state="$home/.config/devrouter/host-routes-state.json"
mkdir -p "$(dirname "$route_state")"
printf '[]\n' > "$route_state"
provider_fixture="$home/provider-fixture.json"
printf '[{"id":"feature","source":{"localFolder":"%s"},"lastUsed":"2026-06-01T12:00:00.000Z"}]\n' "$repo/trees/feature" > "$provider_fixture"
status_fixture="$home/status-fixture.json"
printf '{"id":"feature","context":"default","provider":"docker","state":"NotFound"}\n' > "$status_fixture"
forge_fixture="$home/forge-fixture.json"
printf '[{"repository":{"nameWithOwner":"smoke/devrouter"},"headRepository":{"nameWithOwner":"smoke/devrouter"},"headRefName":"feature","headRefOid":"%s","baseRefName":"main","baseRefOid":"%s","state":"MERGED","mergedAt":"2026-06-03T12:00:00Z","mergeCommit":{"oid":"%s"}}]\n' "$feature_sha" "$main_sha" "$main_sha" > "$forge_fixture"

cat > "$bin/devpod" <<'EOF'
#!/usr/bin/env bash
printf 'devpod %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
case "$*" in
  "list --output json --skip-pro") cat "${DEVROUTER_SMOKE_PROVIDER_FIXTURE:?}" ;;
  "status feature --output json --timeout 5s") cat "${DEVROUTER_SMOKE_STATUS_FIXTURE:?}" ;;
  *) exit 97 ;;
esac
EOF
cat > "$bin/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
cat "${DEVROUTER_SMOKE_FORGE_FIXTURE:?}"
EOF
cat > "$bin/glab" <<'EOF'
#!/usr/bin/env bash
printf 'glab %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
exit 97
EOF
cat > "$bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
case "$*" in
  "-C ${DEVROUTER_SMOKE_REPO:?} worktree list --porcelain"|\
  "-C ${DEVROUTER_SMOKE_REPO:?} rev-parse --git-common-dir"|\
  "-C ${DEVROUTER_SMOKE_FEATURE_PATH:?} rev-parse --verify HEAD"|\
  "-C ${DEVROUTER_SMOKE_FEATURE_PATH:?} show -s --format=%cI HEAD"|\
  "-C ${DEVROUTER_SMOKE_FEATURE_PATH:?} status --porcelain=v1 --untracked-files=normal"|\
  "-C ${DEVROUTER_SMOKE_REPO:?} config --get remote.origin.url"|\
  "-C ${DEVROUTER_SMOKE_REPO:?} symbolic-ref --quiet --short refs/remotes/origin/HEAD"|\
  "-C ${DEVROUTER_SMOKE_REPO:?} rev-parse --verify refs/remotes/origin/main")
    exec "${DEVROUTER_SMOKE_REAL_GIT:?}" "$@"
    ;;
  "-C ${DEVROUTER_SMOKE_REPO:?} ls-remote --symref origin HEAD")
    printf 'ref: refs/heads/main\tHEAD\n%s\tHEAD\n' "${DEVROUTER_SMOKE_MAIN_SHA:?}"
    ;;
  "-C ${DEVROUTER_SMOKE_REPO:?} ls-remote origin refs/heads/main")
    printf '%s\trefs/heads/main\n' "${DEVROUTER_SMOKE_MAIN_SHA:?}"
    ;;
  "-C ${DEVROUTER_SMOKE_REPO:?} ls-remote origin refs/heads/feature")
    printf '%s\trefs/heads/feature\n' "${DEVROUTER_SMOKE_FEATURE_SHA:?}"
    ;;
  *) exit 97 ;;
esac
EOF
chmod +x "$bin/devpod" "$bin/gh" "$bin/glab" "$bin/git"

hash_state() {
  printf '%s\n' \
    "$common_dir/devrouter/workspaces/feature.json" \
    "$feature_git_dir/devrouter-workspace" \
    "$feature_git_dir/HEAD" \
    "$feature_git_dir/index" \
    "$repo/.git/HEAD" \
    "$repo/.git/index" \
    "$repo/.git/refs/heads/main" \
    "$repo/.git/refs/heads/feature" \
    "$repo/.git/refs/remotes/origin/main" \
    "$route_state" \
    "$provider_fixture" \
    "$status_fixture" \
    "$forge_fixture" | LC_ALL=C sort -u | while IFS= read -r file; do
    shasum "$file"
  done
}

calls="$work_root/calls.log"
export DEVROUTER_SMOKE_CALLS="$calls"
export DEVROUTER_SMOKE_PROVIDER_FIXTURE="$provider_fixture"
export DEVROUTER_SMOKE_STATUS_FIXTURE="$status_fixture"
export DEVROUTER_SMOKE_FORGE_FIXTURE="$forge_fixture"
export DEVROUTER_SMOKE_REPO="$repo"
export DEVROUTER_SMOKE_FEATURE_PATH="$repo/trees/feature"
export DEVROUTER_SMOKE_MAIN_SHA="$main_sha"
export DEVROUTER_SMOKE_FEATURE_SHA="$feature_sha"
export DEVROUTER_SMOKE_REAL_GIT="$real_git"
export HOME="$home"
export PATH="$bin:$PATH"

before=$(hash_state)
run_with_timeout 15 node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --inactive-for 30d --json > "$work_root/no-check.json"
after=$(hash_state)
test "$before" = "$after"
grep -Fxq 'devpod list --output json --skip-pro' "$calls"
grep -Fxq 'devpod status feature --output json --timeout 5s' "$calls"
test "$(grep -Ec '^(gh|glab) |^git .* ls-remote ' "$calls" || true)" = "0"
test "$(grep -Ec '^devpod (delete|stop|up) ' "$calls" || true)" = "0"
node - "$calls" "$repo" <<'NODE'
const fs = require("node:fs");
const [callsPath, repo] = process.argv.slice(2);
const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n");
const allowed = [
  `git -C ${repo} rev-parse --git-common-dir`,
  `git -C ${repo} worktree list --porcelain`,
  `git -C ${repo} rev-parse --git-common-dir`,
  "devpod list --output json --skip-pro",
  `git -C ${repo}/trees/feature rev-parse --verify HEAD`,
  `git -C ${repo}/trees/feature show -s --format=%cI HEAD`,
  `git -C ${repo}/trees/feature status --porcelain=v1 --untracked-files=normal`,
  "devpod status feature --output json --timeout 5s",
].sort();
if (JSON.stringify(calls.sort()) !== JSON.stringify(allowed)) process.exit(1);
NODE
node -e 'const r=require(process.argv[1]); const w=r.workspaces[0]; if(r.checkMerged || r.inactiveFor !== "30d" || r.workspaces.length !== 1 || w.provider !== "owned" || w.runtime !== "not-found" || w.integration !== "not-verified" || w.suggestions.length !== 1 || !w.suggestions[0].command.includes("--keep-worktree")) process.exit(1)' "$work_root/no-check.json"

: > "$calls"
before=$(hash_state)
run_with_timeout 15 node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --inactive-for 30d --check-merged --json > "$work_root/check.json"
after=$(hash_state)
test "$before" = "$after"
grep -q '^devpod ' "$calls"
test "$(grep -Ec '^glab |^devpod (delete|stop|up) ' "$calls" || true)" = "0"
node - "$calls" "$repo" <<'NODE'
const fs = require("node:fs");
const [callsPath, repo] = process.argv.slice(2);
const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n");
const allowed = [
  `git -C ${repo} rev-parse --git-common-dir`,
  `git -C ${repo} worktree list --porcelain`,
  `git -C ${repo} rev-parse --git-common-dir`,
  "devpod list --output json --skip-pro",
  `git -C ${repo}/trees/feature rev-parse --verify HEAD`,
  `git -C ${repo}/trees/feature show -s --format=%cI HEAD`,
  `git -C ${repo}/trees/feature status --porcelain=v1 --untracked-files=normal`,
  "devpod status feature --output json --timeout 5s",
  `git -C ${repo} config --get remote.origin.url`,
  `git -C ${repo} symbolic-ref --quiet --short refs/remotes/origin/HEAD`,
  `git -C ${repo} ls-remote --symref origin HEAD`,
  `git -C ${repo} rev-parse --verify refs/remotes/origin/main`,
  `git -C ${repo} ls-remote origin refs/heads/main`,
  `git -C ${repo} ls-remote origin refs/heads/feature`,
  "gh pr list --repo smoke/devrouter --state all --head feature --json headRefName,headRefOid,baseRefName,baseRefOid,state,mergedAt,repository,headRepository,mergeCommit",
].sort();
if (JSON.stringify(calls.sort()) !== JSON.stringify(allowed)) process.exit(1);
NODE
node -e 'const r=require(process.argv[1]); const w=r.workspaces[0]; if(!r.checkMerged || r.workspaces.length !== 1 || w.provider !== "owned" || w.runtime !== "not-found" || w.integration !== "merged-exact" || w.suggestions.length !== 1 || w.suggestions[0].command.includes("--keep-worktree")) process.exit(1)' "$work_root/check.json"

if node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --help | grep -q -- '--yes'; then
  echo "cleanup unexpectedly exposes --yes" >&2
  exit 1
fi

printf 'workspace cleanup report-only smoke passed\n'

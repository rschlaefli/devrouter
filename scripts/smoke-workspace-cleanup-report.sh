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
# Only ever answers read-only queries: any other verb exits 97, so a mutating
# docker call would fail the run rather than silently touching the daemon.
cat > "$bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
if [ -n "${DEVROUTER_SMOKE_DOCKER_ABSENT:-}" ]; then
  printf 'Cannot connect to the Docker daemon\n' >&2
  exit 1
fi
case "$1" in
  ps) cat "${DEVROUTER_SMOKE_DOCKER_IDS:?}" ;;
  inspect)
    case "$*" in
      # The sized fixture holds only the attributed container, so a report that
      # asked the daemon to size anything else would come back unparseable.
      *--size*) cat "${DEVROUTER_SMOKE_DOCKER_SIZED:?}" ;;
      *) cat "${DEVROUTER_SMOKE_DOCKER_PLAIN:?}" ;;
    esac
    ;;
  *) exit 97 ;;
esac
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
  "-C ${DEVROUTER_SMOKE_BETA_PATH:-/nonexistent} rev-parse --verify HEAD"|\
  "-C ${DEVROUTER_SMOKE_BETA_PATH:-/nonexistent} show -s --format=%cI HEAD"|\
  "-C ${DEVROUTER_SMOKE_BETA_PATH:-/nonexistent} status --porcelain=v1 --untracked-files=normal"|\
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
chmod +x "$bin/devpod" "$bin/gh" "$bin/glab" "$bin/git" "$bin/docker"

# The second workspace only exists for the sizing scenarios, so these paths are
# absent for the first two runs. `hash_state` records that absence rather than
# skipping them, which also proves no run creates them behind our back.
beta="$repo/trees/beta"
beta_git_dir="$work_root/pending-beta-git-dir"
docker_ids="$home/docker-ids.txt"
docker_plain="$home/docker-plain.jsonl"
docker_sized="$home/docker-sized.jsonl"

hash_state() {
  printf '%s\n' \
    "$common_dir/devrouter/workspaces/feature.json" \
    "$common_dir/devrouter/workspaces/beta.json" \
    "$feature_git_dir/devrouter-workspace" \
    "$feature_git_dir/HEAD" \
    "$feature_git_dir/index" \
    "$beta_git_dir/devrouter-workspace" \
    "$beta_git_dir/HEAD" \
    "$beta_git_dir/index" \
    "$repo/.git/HEAD" \
    "$repo/.git/index" \
    "$repo/.git/refs/heads/main" \
    "$repo/.git/refs/heads/feature" \
    "$repo/.git/refs/heads/beta" \
    "$repo/.git/refs/remotes/origin/main" \
    "$route_state" \
    "$provider_fixture" \
    "$status_fixture" \
    "$forge_fixture" \
    "$docker_ids" \
    "$docker_plain" \
    "$docker_sized" | LC_ALL=C sort -u | while IFS= read -r file; do
    if [ -e "$file" ]; then
      shasum "$file"
    else
      printf 'absent  %s\n' "$file"
    fi
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

# Sizing scenarios. The second workspace is created only now, because both
# exact-call allowlists above assume a single managed workspace. `git` on PATH
# is the recording stub from here on, so setup uses the captured real binary.
"$real_git" -C "$repo" branch beta
"$real_git" -C "$repo" worktree add -q "$beta" beta
# Enough bytes that `du -sk` rounding cannot swamp the comparison below.
dd if=/dev/zero of="$beta/payload.bin" bs=1024 count=512 2>/dev/null
mkdir -p "$beta/nested"
dd if=/dev/zero of="$beta/nested/payload.bin" bs=1024 count=256 2>/dev/null
dd if=/dev/zero of="$repo/trees/feature/payload.bin" bs=1024 count=384 2>/dev/null
beta_git_dir=$("$real_git" -C "$beta" rev-parse --path-format=absolute --git-dir)
printf 'beta\n' > "$beta_git_dir/devrouter-workspace"
cat > "$common_dir/devrouter/workspaces/beta.json" <<EOF
{
  "version": 1,
  "workspace": "beta",
  "worktreePath": "$beta",
  "branch": "beta",
  "devpodId": "beta",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "updatedAt": "2026-06-01T12:00:00.000Z"
}
EOF
printf '[{"id":"feature","source":{"localFolder":"%s"},"lastUsed":"2026-06-01T12:00:00.000Z"},{"id":"beta","source":{"localFolder":"%s"},"lastUsed":"2026-06-01T12:00:00.000Z"}]\n' \
  "$repo/trees/feature" "$beta" > "$provider_fixture"
beta_status_fixture="$home/beta-status-fixture.json"
printf '{"id":"beta","context":"default","provider":"docker","state":"NotFound"}\n' > "$beta_status_fixture"
export DEVROUTER_SMOKE_BETA_STATUS_FIXTURE="$beta_status_fixture"
export DEVROUTER_SMOKE_BETA_PATH="$beta"

# Only `beta` has a container. `unrelated-1` shares nothing with either
# workspace and must never reach the sizing pass; `feature` has no container at
# all, which is a measured zero rather than an unknown.
printf 'beta-app-1\nunrelated-1\n' > "$docker_ids"
{
  printf '{"id":"beta-app-1","state":{"Running":true,"Health":null},"labels":{"com.docker.compose.project.working_dir":"%s/.devcontainer","com.docker.compose.project.config_files":null},"mounts":[{"Type":"bind","Source":"%s","Destination":"/workspaces/app"}],"networks":{}}\n' "$beta" "$beta"
  printf '{"id":"unrelated-1","state":{"Running":true,"Health":null},"labels":{"com.docker.compose.project.working_dir":"/elsewhere/.devcontainer","com.docker.compose.project.config_files":null},"mounts":[],"networks":{}}\n'
} > "$docker_plain"
printf '{"id":"beta-app-1","state":{"Running":true,"Health":null},"labels":{"com.docker.compose.project.working_dir":"%s/.devcontainer","com.docker.compose.project.config_files":null},"mounts":[{"Type":"bind","Source":"%s","Destination":"/workspaces/app"}],"networks":{},"sizeRw":1048576,"sizeRootFs":105906176}\n' \
  "$beta" "$beta" > "$docker_sized"
export DEVROUTER_SMOKE_DOCKER_IDS="$docker_ids"
export DEVROUTER_SMOKE_DOCKER_PLAIN="$docker_plain"
export DEVROUTER_SMOKE_DOCKER_SIZED="$docker_sized"

: > "$calls"
before=$(hash_state)
run_with_timeout 60 node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --inactive-for 30d --measure-size --json > "$work_root/size.json"
after=$(hash_state)
test "$before" = "$after"
test "$(grep -Fxc 'docker ps -a --format {{.ID}}' "$calls" || true)" = "1"
test "$(grep -Ec '^docker inspect --size ' "$calls" || true)" = "1"
test "$(grep -Ec '^docker inspect --format ' "$calls" || true)" = "1"
# Two-phase narrowing: the expensive sized pass names only the attributed id.
grep -E '^docker inspect --size ' "$calls" | grep -q 'beta-app-1'
if grep -E '^docker inspect --size ' "$calls" | grep -q 'unrelated-1'; then
  echo "sized inspect reached an unattributed container" >&2
  exit 1
fi
test "$(grep -Ec '^docker (rm|stop|kill|prune|system|volume|container|image|builder) ' "$calls" || true)" = "0"
node -e '
const r = require(process.argv[1]);
if (r.measureSize !== true || r.workspaces.length !== 2) process.exit(1);
const beta = r.workspaces.find((w) => w.workspace === "beta");
const feature = r.workspaces.find((w) => w.workspace === "feature");
const measured = (size) => size.status === "measured" && Number.isInteger(size.bytes);
if (!measured(beta.consumption.worktree) || beta.consumption.worktree.bytes <= 0) process.exit(1);
// Attributed container: writable bytes are reclaimable, the image layers under
// them are not, and the total adds only the reclaimable halves.
if (JSON.stringify(beta.consumption.containerWritable) !== JSON.stringify({ status: "measured", bytes: 1048576 })) process.exit(1);
if (JSON.stringify(beta.consumption.imageShared) !== JSON.stringify({ status: "measured", bytes: 104857600 })) process.exit(1);
if (beta.consumption.reclaimable.bytes !== beta.consumption.worktree.bytes + 1048576) process.exit(1);
// No container is a measured zero, never an unknown.
if (!measured(feature.consumption.worktree) || feature.consumption.worktree.bytes <= 0) process.exit(1);
if (feature.consumption.containerWritable.bytes !== 0 || feature.consumption.imageShared.bytes !== 0) process.exit(1);
if (feature.consumption.reclaimable.bytes !== feature.consumption.worktree.bytes) process.exit(1);
' "$work_root/size.json"

# Independent proof that the walker measures real disk: compare each worktree
# figure against `du -sk`, which counts allocated blocks the same way.
assert_matches_du() {
  local label=$1 path=$2
  local reported du_bytes
  reported=$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.workspaces.find((w)=>w.workspace===process.argv[2]).consumption.worktree.bytes))' "$work_root/size.json" "$label")
  du_bytes=$(( $(du -sk "$path" | awk '{print $1}') * 1024 ))
  awk -v a="$reported" -v b="$du_bytes" -v l="$label" 'BEGIN {
    if (b == 0) { printf "du reported zero bytes for %s\n", l > "/dev/stderr"; exit 1 }
    d = a > b ? a - b : b - a
    if (d / b > 0.05) { printf "%s: collector %d bytes vs du %d bytes\n", l, a, b > "/dev/stderr"; exit 1 }
  }'
}
assert_matches_du beta "$beta"
assert_matches_du feature "$repo/trees/feature"

# Docker unreachable: container figures degrade, worktree bytes survive.
: > "$calls"
before=$(hash_state)
DEVROUTER_SMOKE_DOCKER_ABSENT=1 run_with_timeout 60 node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --inactive-for 30d --measure-size --json > "$work_root/size-nodocker.json"
after=$(hash_state)
test "$before" = "$after"
node -e '
const r = require(process.argv[1]);
if (r.measureSize !== true || r.workspaces.length !== 2) process.exit(1);
for (const w of r.workspaces) {
  const c = w.consumption;
  // A read-only report still owes the figures it can produce.
  if (c.worktree.status !== "measured" || c.worktree.bytes <= 0) process.exit(1);
  if (c.containerWritable.status !== "unknown" || !c.containerWritable.reason) process.exit(1);
  if (c.imageShared.status !== "unknown") process.exit(1);
  // Never a measured total built on an unknown component.
  if (c.reclaimable.status !== "unknown") process.exit(1);
}
' "$work_root/size-nodocker.json"

if node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --help | grep -q -- '--yes'; then
  echo "cleanup unexpectedly exposes --yes" >&2
  exit 1
fi

printf 'workspace cleanup report-only smoke passed\n'

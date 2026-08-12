#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_root=$(mktemp -d "${TMPDIR:-/tmp}/devrouter-cleanup-smoke.XXXXXX")
trap 'rm -rf "$work_root"' EXIT

repo="$work_root/repo"
home="$work_root/home"
bin="$work_root/bin"
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

cat > "$bin/devpod" <<'EOF'
#!/usr/bin/env bash
printf 'devpod %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
cat "${DEVROUTER_SMOKE_PROVIDER_FIXTURE:?}"
EOF
cat > "$bin/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
printf '[]\n'
EOF
cat > "$bin/glab" <<'EOF'
#!/usr/bin/env bash
printf 'glab %s\n' "$*" >> "${DEVROUTER_SMOKE_CALLS:?}"
printf '[]\n'
EOF
chmod +x "$bin/devpod" "$bin/gh" "$bin/glab"

hash_state() {
  {
    find "$repo/.git" "$repo/trees/feature" -type f -print
    printf '%s\n' "$route_state" "$provider_fixture"
  } | LC_ALL=C sort -u | while IFS= read -r file; do
    shasum "$file"
  done
}

calls="$work_root/calls.log"
export DEVROUTER_SMOKE_CALLS="$calls"
export DEVROUTER_SMOKE_PROVIDER_FIXTURE="$provider_fixture"
export HOME="$home"
export PATH="$bin:$PATH"

before=$(hash_state)
node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --inactive-for 30d --json > "$work_root/no-check.json"
after=$(hash_state)
test "$before" = "$after"
test ! -s "$calls"
node -e 'const r=require(process.argv[1]); if(r.checkMerged || r.inactiveFor !== "30d" || r.workspaces.length !== 1 || r.workspaces[0].provider !== "unknown" || r.workspaces[0].suggestions.length !== 0) process.exit(1)' "$work_root/no-check.json"

: > "$calls"
before=$(hash_state)
node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --inactive-for 30d --check-merged --json > "$work_root/check.json"
after=$(hash_state)
test "$before" = "$after"
grep -q '^devpod ' "$calls"
test "$(grep -Ec '^(gh|glab) ' "$calls" || true)" = "0"
node -e 'const r=require(process.argv[1]); if(!r.checkMerged || r.workspaces.length !== 1 || r.workspaces[0].integration !== "unknown") process.exit(1)' "$work_root/check.json"

if node "$repo_root/dist/devrouter.js" workspace cleanup --repo "$repo" --help | grep -q -- '--yes'; then
  echo "cleanup unexpectedly exposes --yes" >&2
  exit 1
fi

printf 'workspace cleanup report-only smoke passed\n'

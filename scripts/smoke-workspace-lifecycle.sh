#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT/examples/devcontainer"
RUN_ID="${DEVROUTER_LIFECYCLE_SMOKE_ID:-$PPID-$$}"
WS_LIFECYCLE="lifecycle-$RUN_ID"
WS_GC="gc-$RUN_ID"
REPO="$(mktemp -d "${TMPDIR:-/tmp}/devrouter-lifecycle-smoke.XXXXXX")"
WT_LIFECYCLE="$REPO/trees/$WS_LIFECYCLE"
WT_GC="$REPO/trees/$WS_GC"

run_dev() {
  node "$ROOT/dist/devrouter.js" "$@"
}

skip_unless_available() {
  for command in docker devpod git node; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "Workspace lifecycle smoke skipped: '$command' is unavailable."
      exit 0
    fi
  done
  if ! docker info >/dev/null 2>&1; then
    echo "Workspace lifecycle smoke skipped: Docker is unavailable."
    exit 0
  fi
}

cleanup() {
  set +e
  run_dev workspace stop "$WS_LIFECYCLE" --repo "$REPO" >/dev/null 2>&1
  rm -f "$WT_LIFECYCLE/uncommitted-smoke-file"
  run_dev workspace down "$WS_LIFECYCLE" --repo "$REPO" >/dev/null 2>&1
  run_dev workspace down "$WS_GC" --repo "$REPO" >/dev/null 2>&1
  run_dev workspace gc --repo "$REPO" --yes >/dev/null 2>&1
  devpod delete "$WS_LIFECYCLE" --ignore-not-found >/dev/null 2>&1
  devpod delete "$WS_GC" --ignore-not-found >/dev/null 2>&1
  rm -rf "$REPO"
}

assert_workspace() {
  local json="$1"
  local workspace="$2"
  local expected_owner="$3"
  local expected_routes="$4"
  node -e '
    const rows = JSON.parse(process.argv[1]);
    const row = rows.find((entry) => entry.workspace === process.argv[2]);
    if (!row || row.ownerStatus !== process.argv[3] || row.routeCount !== Number(process.argv[4])) {
      console.error(JSON.stringify({ expected: process.argv.slice(2), row }, null, 2));
      process.exit(1);
    }
  ' "$json" "$workspace" "$expected_owner" "$expected_routes"
}

skip_unless_available
trap cleanup EXIT

if [ ! -f "$ROOT/dist/devrouter.js" ]; then
  echo "Workspace lifecycle smoke requires a build; run 'pnpm build' first." >&2
  exit 1
fi

cp -R "$FIXTURE/." "$REPO/"
rm -f "$REPO/run.sh" "$REPO/README.md"
printf '\ntrees/\n' >>"$REPO/.gitignore"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=smoke@devrouter.local -c user.name=devrouter-smoke commit -qm "test fixture"

run_dev setup --repo "$REPO" --yes --json >/dev/null

echo "--- managed lifecycle: up -> stop -> ensure -> dirty rejection -> down ---"
run_dev workspace up "$WS_LIFECYCLE" --repo "$REPO"
assert_workspace "$(run_dev workspace ls --repo "$REPO" --json)" "$WS_LIFECYCLE" present 2

run_dev workspace stop "$WS_LIFECYCLE" --repo "$REPO"
assert_workspace "$(run_dev workspace ls --repo "$REPO" --json)" "$WS_LIFECYCLE" present 0

run_dev workspace ensure "$WT_LIFECYCLE"
touch "$WT_LIFECYCLE/uncommitted-smoke-file"
if run_dev workspace down "$WS_LIFECYCLE" --repo "$REPO" >/dev/null 2>&1; then
  echo "Dirty workspace down unexpectedly succeeded." >&2
  exit 1
fi
assert_workspace "$(run_dev workspace ls --repo "$REPO" --json)" "$WS_LIFECYCLE" present 2
rm "$WT_LIFECYCLE/uncommitted-smoke-file"
run_dev workspace down "$WS_LIFECYCLE" --repo "$REPO"

echo "--- out-of-band removal: dry-run GC -> apply GC ---"
run_dev workspace up "$WS_GC" --repo "$REPO"
git -C "$REPO" worktree remove "$WT_GC"

GC_DRY="$(run_dev workspace gc --repo "$REPO" --json)"
node -e '
  const report = JSON.parse(process.argv[1]);
  const candidate = report.candidates.find((entry) => entry.workspace === process.argv[2]);
  if (report.mode !== "dry-run" || !candidate?.eligible || candidate.ownerStatus !== "missing") {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
' "$GC_DRY" "$WS_GC"

GC_APPLY="$(run_dev workspace gc --repo "$REPO" --yes --json)"
node -e '
  const report = JSON.parse(process.argv[1]);
  if (report.mode !== "apply" || report.summary.cleaned !== 1 || report.summary.errors !== 0) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
' "$GC_APPLY"

echo "Workspace lifecycle smoke passed."

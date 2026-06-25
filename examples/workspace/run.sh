#!/usr/bin/env bash
# Showcase devrouter workspace isolation end-to-end: ONE repo, TWO parallel git
# worktrees, each reachable at its own namespaced *.localhost with zero collisions.
#
#   primary checkout  -> https://wsdemo.localhost         -> wsdemo-app
#   worktree `feat-a` -> https://wsdemo.feat-a.localhost  -> feat-a-app
#
# Usage:
#   ./run.sh          bring everything up and print the proof
#   ./run.sh down     tear everything down
#
# This materializes the example as a standalone git repo under $WSDEMO_REPO so
# `dev workspace` can worktree it (the committed copy lives in a subdir of the
# devrouter repo). Requires Docker + a built devrouter (`dev` on PATH or dist/).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SRC/../.." && pwd)"
DEV() { if command -v dev >/dev/null 2>&1; then command dev "$@"; else node "$ROOT/dist/dev.js" "$@"; fi; }

REPO="${WSDEMO_REPO:-/tmp/devrouter-wsdemo}"
WT="$REPO-feat-a"
COMPOSE_MAIN=(docker compose -f "$REPO/docker-compose.yml" -p wsdemo)
COMPOSE_FEAT=(docker compose -f "$WT/docker-compose.yml" -p wsfeata)

cleanup() {
  set +e
  echo "--- teardown ---"
  DEV workspace down feat-a --repo "$REPO" >/dev/null 2>&1
  DEV app rm app --repo "$REPO" --keep-config >/dev/null 2>&1
  WORKSPACE=wsdemo "${COMPOSE_MAIN[@]}" down >/dev/null 2>&1
  WORKSPACE=feat-a "${COMPOSE_FEAT[@]}" down >/dev/null 2>&1
  rm -rf "$REPO" "$WT"
}

if [ "${1:-}" = "down" ]; then cleanup; echo "clean."; exit 0; fi
trap cleanup EXIT

wait_ok() { # $1=host
  for _ in $(seq 1 40); do
    curl -fsk -o /dev/null "https://$1" && return 0
    sleep 0.5
  done
  return 1
}

# 0. Materialize the example as a standalone git repo.
rm -rf "$REPO" "$WT"
mkdir -p "$REPO"
cp "$SRC/.devrouter.yml" "$SRC/docker-compose.yml" "$SRC/server.js" "$REPO/"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=demo@devrouter.local -c user.name=devrouter-demo commit -qm "wsdemo example"

DEV up >/dev/null
DEV tls install >/dev/null 2>&1 || true

# 1. Primary checkout -> wsdemo.localhost -> wsdemo-app
echo "--- primary checkout: wsdemo.localhost ---"
WORKSPACE=wsdemo "${COMPOSE_MAIN[@]}" up -d
DEV app run app --repo "$REPO" --yes

# 2. Parallel worktree `feat-a` -> wsdemo.feat-a.localhost -> feat-a-app
echo "--- dev workspace up feat-a (worktree + namespaced route) ---"
DEV workspace up feat-a --no-devpod --repo "$REPO"
WORKSPACE=feat-a "${COMPOSE_FEAT[@]}" up -d

echo "--- waiting for both upstreams ---"
wait_ok wsdemo.localhost        || { echo "primary not ready"; exit 1; }
wait_ok wsdemo.feat-a.localhost || { echo "feat-a not ready"; exit 1; }

echo
echo "=== PROOF: one repo, two worktrees, two namespaced hosts ==="
printf 'wsdemo.localhost         -> %s' "$(curl -sk https://wsdemo.localhost)"
printf 'wsdemo.feat-a.localhost  -> %s' "$(curl -sk https://wsdemo.feat-a.localhost)"
echo
echo "--- dev workspace ls ---"
DEV workspace ls --repo "$REPO"
echo
echo "Up. Run './run.sh down' to tear down."
trap - EXIT   # leave it running so you can poke at it; teardown is explicit

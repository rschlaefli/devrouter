#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SRC/../.." && pwd)"
DEV() { if [ -x "$ROOT/dist/devrouter.js" ]; then node "$ROOT/dist/devrouter.js" "$@"; else command devrouter "$@"; fi; }

WORKSPACE_NAME="devcontainer-demo"
DEVPOD_ID="${DEVROUTER_EXAMPLE_DEVPOD_ID:-devrouter-devcontainer-demo}"
APP_HOST="devcontainer-demo.localhost"
DB_HOST="db.devcontainer-demo.localhost"
unset DEVROUTER_WORKSPACE || true

cleanup() {
  set +e
  echo "--- teardown ---"
  DEV app rm app --repo "$SRC" --keep-config >/dev/null 2>&1
  DEV app rm db --repo "$SRC" --keep-config >/dev/null 2>&1
  devpod delete "$DEVPOD_ID" --force --ignore-not-found >/dev/null 2>&1
}

if [ "${1:-}" = "down" ]; then
  cleanup
  echo "clean."
  exit 0
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

wait_verify_live() {
  local out="$1"
  for _ in $(seq 1 60); do
    if DEV repo devcontainer verify --repo "$SRC" --live --yes --json >"$out"; then
      return 0
    fi
    sleep 1
  done
  cat "$out" >&2
  return 1
}

require docker
require devpod
require curl
require node

if [ ! -x "$ROOT/dist/devrouter.js" ] && ! command -v devrouter >/dev/null 2>&1; then
  echo "devrouter CLI not found. Run pnpm build or install devrouter first." >&2
  exit 1
fi

VERIFY_STATIC="$(mktemp)"
VERIFY_LIVE="$(mktemp)"
PSQL_OUT="$(mktemp)"
PSQL_ERR="$(mktemp)"
finish() {
  local status=$?
  rm -f "$VERIFY_STATIC" "$VERIFY_LIVE" "$PSQL_OUT" "$PSQL_ERR"
  if [ "$status" -ne 0 ]; then
    cleanup
  fi
}
trap finish EXIT

echo "--- dev setup ---"
DEV setup --repo "$SRC" --yes --json >/dev/null

echo "--- static verify ---"
DEV repo devcontainer verify --repo "$SRC" --json >"$VERIFY_STATIC"
node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (r.summary.error) { console.error(JSON.stringify(r,null,2)); process.exit(1); }' "$VERIFY_STATIC"

echo "--- devpod up ---"
WORKSPACE="$WORKSPACE_NAME" devpod up "$SRC" \
  --id "$DEVPOD_ID" \
  --provider docker \
  --ide none \
  --open-ide=false \
  --recreate

echo "--- live verify ---"
wait_verify_live "$VERIFY_LIVE"
node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({summary:r.summary, liveRoutes:r.evidence.liveRoutes}, null, 2));' "$VERIFY_LIVE"

echo "--- curl app ---"
APP_RESPONSE="$(curl -fsk "https://$APP_HOST")"
printf '%s\n' "$APP_RESPONSE"
node -e 'const r=JSON.parse(process.argv[1]); if (r.ok !== true || r.workspace !== "devcontainer-demo" || r.port !== 3000) { console.error(JSON.stringify(r)); process.exit(1); }' "$APP_RESPONSE"

if command -v psql >/dev/null 2>&1; then
  echo "--- psql direct-SSL ---"
  run_psql_direct() {
    local db_name="$1"
    PGPASSWORD=prisma psql "host=$DB_HOST hostaddr=127.0.0.1 port=5432 user=prisma dbname=$db_name sslmode=require sslnegotiation=direct" -tAc "select 1" >>"$PSQL_OUT" 2>>"$PSQL_ERR"
  }
  wait_psql_direct() {
    for _ in $(seq 1 30); do
      : >"$PSQL_OUT"
      : >"$PSQL_ERR"
      if run_psql_direct prisma && run_psql_direct shadow; then
        cat "$PSQL_OUT"
        return 0
      fi
      if grep -qi "sslnegotiation" "$PSQL_ERR"; then
        return 2
      fi
      sleep 1
    done
    return 1
  }
  if wait_psql_direct; then
    :
  else
    psql_status=$?
    if [ "$psql_status" -eq 2 ]; then
      PSQL_VERSION="$(psql --version || true)"
      node -e 'console.log(JSON.stringify({warning:"psql does not support sslnegotiation=direct; skipped direct-SSL postgres smoke", psqlVersion:process.argv[1]}))' "$PSQL_VERSION"
    else
      cat "$PSQL_ERR" >&2
      exit 1
    fi
  fi
else
  echo '{"warning":"psql not found; skipped direct-SSL postgres smoke"}'
fi

echo
echo "Up. Run './run.sh down' or 'pnpm devcontainer:smoke down' to tear down."
trap - EXIT
rm -f "$VERIFY_STATIC" "$VERIFY_LIVE" "$PSQL_OUT" "$PSQL_ERR"

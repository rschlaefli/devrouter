#!/usr/bin/env bash
set -euo pipefail

TEMPLATE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$TEMPLATE/../.." && pwd)"
SMOKE_REPO="${DEVROUTER_DEVCONTAINER_SMOKE_REPO:-${TMPDIR:-/tmp}/devrouter-devcontainer-smoke}"

if [ "$(git -C "$TEMPLATE" rev-parse --show-toplevel 2>/dev/null || true)" != "$TEMPLATE" ]; then
  if [ "${1:-}" = "down" ]; then
    if [ -f "$SMOKE_REPO/.devrouter-smoke-owned" ]; then
      DEVROUTER_CLI_ROOT="$ROOT" "$SMOKE_REPO/run.sh" down
      rm -rf "$SMOKE_REPO"
    fi
    exit 0
  fi
  if [ -e "$SMOKE_REPO" ] && [ ! -f "$SMOKE_REPO/.devrouter-smoke-owned" ]; then
    echo "refusing non-owned smoke path: $SMOKE_REPO" >&2
    exit 1
  fi
  rm -rf "$SMOKE_REPO"
  mkdir -p "$SMOKE_REPO"
  cp -R "$TEMPLATE/." "$SMOKE_REPO/"
  touch "$SMOKE_REPO/.devrouter-smoke-owned"
  git -C "$SMOKE_REPO" init -q
  git -C "$SMOKE_REPO" add -A
  git -C "$SMOKE_REPO" -c user.email=smoke@devrouter.local -c user.name=devrouter-smoke commit -qm "test fixture"
  export DEVROUTER_CLI_ROOT="$ROOT"
  exec "$SMOKE_REPO/run.sh" "$@"
fi

SRC="$TEMPLATE"
CLI_ROOT="${DEVROUTER_CLI_ROOT:-$ROOT}"
DEV() { if [ -x "$CLI_ROOT/dist/devrouter.js" ]; then node "$CLI_ROOT/dist/devrouter.js" "$@"; else command devrouter "$@"; fi; }

APP_HOST="devcontainer-demo.localhost"
DB_HOST="db.devcontainer-demo.localhost"
unset DEVROUTER_WORKSPACE || true

exact_devpod_id() {
  devpod list --output json | node -e 'const fs=require("fs"); const path=require("path"); const repo=fs.realpathSync(process.argv[1]); const rows=JSON.parse(fs.readFileSync(0,"utf8")); const matches=rows.filter((row)=>path.resolve(row.source.localFolder)===repo); if(matches.length>1) process.exit(2); if(matches[0]) process.stdout.write(matches[0].id);' "$SRC"
}

cleanup() {
  set +e
  echo "--- teardown ---"
  DEV stop "$SRC" >/dev/null 2>&1
  local devpod_id
  devpod_id="$(exact_devpod_id || true)"
  if [ -n "$devpod_id" ]; then
    devpod delete "$devpod_id" --force --ignore-not-found >/dev/null 2>&1
  fi
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

require docker
require devpod
require curl
require git
require node
require mkcert

if [ ! -x "$CLI_ROOT/dist/devrouter.js" ] && ! command -v devrouter >/dev/null 2>&1; then
  echo "devrouter CLI not found. Run pnpm build or install devrouter first." >&2
  exit 1
fi

VERIFY_STATIC="$(mktemp)"
ENSURE_OUT="$(mktemp)"
PSQL_OUT="$(mktemp)"
PSQL_ERR="$(mktemp)"
finish() {
  local status=$?
  rm -f "$VERIFY_STATIC" "$ENSURE_OUT" "$PSQL_OUT" "$PSQL_ERR"
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

echo "--- ensure environment ---"
DEV ensure "$SRC" --json >"$ENSURE_OUT"
node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(r.kind!=="primary" || !r.devpodId || r.urls.length!==2) process.exit(1); console.log(JSON.stringify(r,null,2));' "$ENSURE_OUT"

echo "--- exact DevPod exec ---"
DEV exec "$SRC" -- node -e 'if(process.cwd()!=="/workspaces/devcontainer-demo") process.exit(1); console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(1)}));' 'literal argument'

echo "--- curl app ---"
APP_RESPONSE="$(curl -fsS --cacert "$(mkcert -CAROOT)/rootCA.pem" "https://$APP_HOST")"
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
rm -f "$VERIFY_STATIC" "$ENSURE_OUT" "$PSQL_OUT" "$PSQL_ERR"

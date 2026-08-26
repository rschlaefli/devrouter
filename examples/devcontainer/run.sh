#!/usr/bin/env bash
set -euo pipefail

TEMPLATE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$TEMPLATE/../.." && pwd)"
SMOKE_REPO="${DEVROUTER_DEVCONTAINER_SMOKE_REPO:-${TMPDIR:-/tmp}/devrouter-devcontainer-smoke}"
SMOKE_TOKEN="${DEVROUTER_SMOKE_TOKEN:-devcontainer-demo}"

smoke_owner() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

smoke_mode() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

assert_owned_smoke_repo() {
  if [ ! -d "$SMOKE_REPO" ] || [ -L "$SMOKE_REPO" ]; then
    echo "refusing non-directory or symlink smoke path: $SMOKE_REPO" >&2
    exit 1
  fi
  if [ "$(smoke_owner "$SMOKE_REPO")" != "$(id -u)" ] || [ "$(smoke_mode "$SMOKE_REPO")" != "700" ]; then
    echo "refusing smoke path without current-user 0700 ownership: $SMOKE_REPO" >&2
    exit 1
  fi
  if [ ! -f "$SMOKE_REPO/.devrouter-smoke-owned" ] || [ -L "$SMOKE_REPO/.devrouter-smoke-owned" ]; then
    echo "refusing unmarked smoke path: $SMOKE_REPO" >&2
    exit 1
  fi
}

if [ -n "${DEVROUTER_SMOKE_FIXTURE:-}" ]; then
  SMOKE_REPO="$DEVROUTER_SMOKE_FIXTURE"
  assert_owned_smoke_repo
  SRC="$(cd "$SMOKE_REPO" && pwd -P)"
elif [ "$(git -C "$TEMPLATE" rev-parse --show-toplevel 2>/dev/null || true)" != "$TEMPLATE" ]; then
  if [ "${1:-}" = "down" ]; then
    if [ -e "$SMOKE_REPO" ] || [ -L "$SMOKE_REPO" ]; then
      assert_owned_smoke_repo
      DEVROUTER_CLI_ROOT="$ROOT" DEVROUTER_SMOKE_FIXTURE="$SMOKE_REPO" "$TEMPLATE/run.sh" down
      rm -rf "$SMOKE_REPO"
    fi
    exit 0
  fi
  if [ -e "$SMOKE_REPO" ] || [ -L "$SMOKE_REPO" ]; then
    assert_owned_smoke_repo
    rm -rf "$SMOKE_REPO"
  fi
  mkdir -p "$SMOKE_REPO"
  chmod 700 "$SMOKE_REPO"
  touch "$SMOKE_REPO/.devrouter-smoke-owned"
  assert_owned_smoke_repo
  cp -R "$TEMPLATE/." "$SMOKE_REPO/"
  export DEVROUTER_SMOKE_TOKEN="devrouter-smoke"
  node - "$SMOKE_REPO" "$DEVROUTER_SMOKE_TOKEN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [repoPath, token] = process.argv.slice(2);
const routerPath = path.join(repoPath, '.devrouter.yml');
const router = fs.readFileSync(routerPath, 'utf8').replaceAll('devcontainer-demo', token);
fs.writeFileSync(routerPath, router);

const envPath = path.join(repoPath, '.devcontainer/devcontainer.env');
const env = fs.readFileSync(envPath, 'utf8').replace(/^WORKSPACE=.*$/m, `WORKSPACE=${token}`);
fs.writeFileSync(envPath, env);

for (const name of ['docker-compose.yml', 'docker-compose.default.yml']) {
  const composePath = path.join(repoPath, '.devcontainer', name);
  const compose = fs
    .readFileSync(composePath, 'utf8')
    .replaceAll(':-devcontainer-demo}', `:-${token}}`);
  fs.writeFileSync(composePath, compose);
}
NODE
  git -C "$SMOKE_REPO" init -q
  git -C "$SMOKE_REPO" add -A
  git -C "$SMOKE_REPO" -c user.email=smoke@devrouter.local -c user.name=devrouter-smoke commit -qm "test fixture"
  export DEVROUTER_CLI_ROOT="$ROOT"
  export DEVROUTER_SMOKE_FIXTURE="$SMOKE_REPO"
  exec "$TEMPLATE/run.sh" "$@"
else
  SRC="$TEMPLATE"
fi

CLI_ROOT="${DEVROUTER_CLI_ROOT:-$ROOT}"
DEV() { if [ -f "$CLI_ROOT/dist/devrouter.js" ]; then node "$CLI_ROOT/dist/devrouter.js" "$@"; else command devrouter "$@"; fi; }

APP_HOST="${SMOKE_TOKEN}.localhost"
DB_HOST="db.${SMOKE_TOKEN}.localhost"
unset DEVROUTER_WORKSPACE || true

cleanup() {
  set +e
  echo "--- teardown ---"
  DEV stop "$SRC" >/dev/null 2>&1
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

if [ ! -f "$CLI_ROOT/dist/devrouter.js" ] && ! command -v devrouter >/dev/null 2>&1; then
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

echo "--- runtime-only helper delivery ---"
DEV exec "$SRC" -- sh -c 'test ! -e /usr/local/bin/devrouter-process'
DEV exec "$SRC" -- sh -c 'test -x /tmp/devrouter/bin/devrouter-process'

echo "--- exact DevPod exec ---"
DEV exec "$SRC" -- node -e 'if(process.cwd()!=="/workspaces/devcontainer-demo") process.exit(1); console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(1)}));' 'literal argument'

echo "--- curl app ---"
if ! APP_RESPONSE="$(curl -fsS --cacert "$(mkcert -CAROOT)/rootCA.pem" "https://$APP_HOST" 2>/dev/null)"; then
  echo '{"warning":"curl SecureTransport rejected the shared certificate; used the Node TLS verifier"}'
  APP_RESPONSE="$(node - "$APP_HOST" "$(mkcert -CAROOT)/rootCA.pem" <<'NODE'
const fs = require('node:fs');
const https = require('node:https');

const [host, caPath] = process.argv.slice(2);
const request = https.get(
  `https://${host}/`,
  { ca: fs.readFileSync(caPath) },
  (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
    });
    response.on('end', () => {
      if (response.statusCode !== 200) {
        console.error(`HTTPS request returned status ${response.statusCode ?? 'unknown'}`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(body);
    });
  },
);
request.setTimeout(10000, () => request.destroy(new Error('HTTPS request timed out')));
request.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE
  )"
fi
printf '%s\n' "$APP_RESPONSE"
node -e 'const r=JSON.parse(process.argv[1]); if (r.ok !== true || r.workspace !== process.argv[2] || r.port !== 3000) { console.error(JSON.stringify(r)); process.exit(1); }' "$APP_RESPONSE" "$SMOKE_TOKEN"

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

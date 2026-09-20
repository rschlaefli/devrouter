#!/usr/bin/env bash
# Qualify a non-Node consumer against the canonical devrouter consumer contract.
#
# The fixture is a synthetic repository whose only application is a Python HTTP
# service built on the standard library. Nothing in the contract is Node-shaped:
# one .devrouter.yml declares a routed host application and a routed Postgres
# dependency, Traefik serves the route over trusted TLS, the dependency
# environment reaches the consumer process, and the route is freed
# non-destructively afterwards. The fixture owns its own Compose project and
# releases that project's container and synthetic volume when it finishes.
#
# Evidence is read from artifacts the fixture itself produced: the routed HTTPS
# response, the environment the consumer process reports, the live route list and
# Docker's own container state. Each round also records the ready consumer's peak
# resident memory, the memory its containers hold at readiness and the exact
# dependency container it ran against, so reuse is visible across rounds. The
# measurements are printed, never asserted, so a slow or heavy host stays visible
# without failing the qualification.
#
# Rounds: DR_NON_NODE_ROUNDS cold and warm starts (default 3 each). The roadmap's
# default qualification is twenty routine repetitions; this fixture is recorded
# at three because every round starts a real Postgres and a real host process
# (roughly fifteen seconds), and its assertion set is deterministic.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${DR_NON_NODE_DIST:-$ROOT/dist/devrouter.js}"
PYTHON="${DR_NON_NODE_PYTHON:-$(command -v python3 || true)}"
ROUNDS="${DR_NON_NODE_ROUNDS:-3}"
HOST="non-node-app.localhost"
COMPOSE_PROJECT="devrouter-non-node-fixture"

skip() { printf '%s\n' "$1"; exit 0; }

[ -f "$DIST" ] || skip "Non-Node consumer qualification skipped: build dist/devrouter.js first (pnpm build)."
[ -n "$PYTHON" ] || skip "Non-Node consumer qualification skipped: python3 is unavailable."
command -v docker >/dev/null 2>&1 || skip "Non-Node consumer qualification skipped: docker is unavailable."
docker info >/dev/null 2>&1 || skip "Non-Node consumer qualification skipped: the Docker daemon is not reachable."
command -v curl >/dev/null 2>&1 || skip "Non-Node consumer qualification skipped: curl is unavailable."
CA="$(mkcert -CAROOT 2>/dev/null || true)/rootCA.pem"
[ -f "$CA" ] || skip "Non-Node consumer qualification skipped: the mkcert root CA is unavailable (run devrouter tls install)."

WORK="${DR_NON_NODE_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/devrouter-non-node.XXXXXX")}"
# The fixture directory name is the Compose project name Docker derives for the
# dependency, and the fixture drives that same dependency with its own Compose
# calls, so the name must match devrouter's own invocation exactly.
FIXTURE="$WORK/devrouter-non-node-fixture"
API_PID=""
STARTED_ROUTER="false"
FAILED=0

run_dev() { node "$DIST" "$@"; }
now_ms() { "$PYTHON" -c 'import time; print(int(time.time() * 1000))'; }

compose() { docker compose -f "$FIXTURE/docker-compose.yml" "$@"; }
stop_db() { compose stop >/dev/null 2>&1 || true; }
stop_app() {
  if [ -n "$API_PID" ]; then kill "$API_PID" >/dev/null 2>&1 || true; wait "$API_PID" >/dev/null 2>&1 || true; API_PID=""; fi
  run_dev app rm api --repo "$FIXTURE" --keep-config >/dev/null 2>&1 || true
}

# The URL the consumer's own app publishes, read from the live route list so the
# probe uses exactly what the router serves instead of a guessed address.
route_url() {
  run_dev ls --json 2>/dev/null | "$PYTHON" -c '
import json, sys
host = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for route in data.get("routes", []):
    if host in route.get("hosts", []):
        for url in route.get("urls", []):
            print(url)
            raise SystemExit(0)
' "$1"
}

cleanup() {
  set +e
  stop_app
  stop_db
  # The fixture owns exactly this Compose project, so releasing its own
  # container and its synthetic volume is the last step of its own lifecycle.
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [ "$STARTED_ROUTER" = "true" ]; then run_dev down >/dev/null 2>&1 || true; fi
  if [ "$FAILED" = "0" ] && [ -z "${DR_NON_NODE_WORK:-}" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

mkdir -p "$FIXTURE/app"
cat > "$FIXTURE/.devrouter.yml" <<'CONFIG_EOF'
version: 1
project:
  name: devrouter-non-node-fixture

apps:
  - name: db
    host: non-node-db.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: docker
    docker:
      service: db
      internalPort: 5432
      composeFiles:
        - docker-compose.yml

  - name: api
    host: non-node-app.localhost
    protocol: http
    runtime: host
    dependencies:
      - app: db
        envMap:
          DATABASE_URL: DB_URL
    hostRun:
      command: python3 app/server.py
      cwd: .
      portTimeout: 60
      strategy:
        type: auto
        denyPorts:
          - 80
          - 443
          - 5432
        allowPortRange: 1024-65535
CONFIG_EOF

cat > "$FIXTURE/docker-compose.yml" <<'COMPOSE_EOF'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: prisma
      POSTGRES_PASSWORD: prisma
      POSTGRES_DB: prisma
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U prisma -d prisma"]
      interval: 5s
      timeout: 3s
      retries: 20
COMPOSE_EOF

cat > "$FIXTURE/app/server.py" <<'SERVER_EOF'
"""A non-Node consumer of the devrouter contract.

Only the standard library is used, so the fixture proves the contract without a
Node toolchain, a package manager or a build step. /healthz answers the route and
/ reports the dependency environment exactly as devrouter injected it into this
process.
"""

import json
import os
import resource
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "0"))
INSTANCE = os.environ.get("APP_INSTANCE", "unknown")
DEPENDENCY_VARS = ("DB_HOST", "DB_PORT", "DB_URL", "DB_SHADOW_URL", "DATABASE_URL")


def resident_kb():
    # ru_maxrss is bytes on macOS and kilobytes elsewhere, so the unit is
    # normalized before it is reported as a measurement.
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak // 1024 if sys.platform == "darwin" else peak


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self.respond(200, {"ok": True, "instance": INSTANCE, "port": PORT})
            return
        self.respond(
            200,
            {
                "ok": True,
                "app": "devrouter-non-node-fixture",
                "instance": INSTANCE,
                "port": PORT,
                "python": sys.version.split()[0],
                "rssKb": resident_kb(),
                "dependencyEnv": {name: os.environ.get(name, "") for name in DEPENDENCY_VARS},
            },
        )

    def log_message(self, fmt, *args):
        sys.stderr.write("[devrouter-non-node] " + fmt % args + "\n")


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
SERVER_EOF

# Onboarding must work for a repository without Node metadata: the inspector may
# warn about the missing manifest, but the devrouter contract stays valid.
run_dev repo inspect --repo "$FIXTURE" --json | "$PYTHON" -c '
import json, sys
report = json.load(sys.stdin)
apps = sorted(app["name"] for app in report["devrouter"]["apps"])
assert report["devrouter"]["valid"] is True, "the fixture config was not valid"
assert apps == ["api", "db"], "the fixture apps were " + str(apps)
errors = [issue for issue in report.get("issues", []) if issue.get("level") == "error"]
assert not errors, "repo inspect reported errors: " + json.dumps(errors)
' >/dev/null

router_running="$(run_dev status --json 2>/dev/null | "$PYTHON" -c '
import json, sys
try:
    print(json.load(sys.stdin).get("routerRunning"))
except Exception:
    print("unknown")
' || echo unknown)"
if [ "$router_running" != "True" ]; then
  run_dev up
  STARTED_ROUTER="true"
fi

cold_ms=()
warm_ms=()
results=()

run_round() {
  local label="$1" mode="$2"
  if [ "$mode" = "cold" ]; then stop_db; fi
  # Whether this round starts from a running dependency is the preparation-reuse
  # measurement: a warm round that inherits the dependency must not rebuild it.
  local reused="false"
  if [ -n "$(compose ps -q 2>/dev/null || true)" ]; then reused="true"; fi
  : > "$WORK/app-$label.log"
  local started url ready waited
  started="$(now_ms)"
  ( cd "$FIXTURE" && run_dev app run api --repo "$FIXTURE" --yes >> "$WORK/app-$label.log" 2>&1 ) &
  API_PID=$!
  url=""
  ready=""
  for _ in $(seq 1 240); do
    if [ -z "$url" ]; then url="$(route_url "$HOST")"; fi
    if [ -n "$url" ] && curl -fsS --max-time 3 --cacert "$CA" "$url/healthz" >/dev/null 2>&1; then
      ready="$(( $(now_ms) - started ))"
      break
    fi
    sleep 0.25
  done
  if [ -z "$ready" ]; then
    echo "the routed application never became ready; see $WORK/app-$label.log" >&2
    cat "$WORK/app-$label.log" >&2 || true
    FAILED=1
    return 1
  fi
  waited="$ready"
  curl -fsS --max-time 5 --cacert "$CA" "$url/" > "$WORK/body-$label.json"

  "$PYTHON" - "$WORK/body-$label.json" "$url" <<'BODY_CHECK'
import json, sys

body = json.load(open(sys.argv[1]))
url = sys.argv[2]
assert url.startswith("https://"), "the route was not published over TLS: " + url
assert body["app"] == "devrouter-non-node-fixture", "unexpected application identity: " + json.dumps(body)
assert body["python"].startswith("3."), "the consumer did not report a Python runtime: " + body["python"]
env = body["dependencyEnv"]
assert env["DB_HOST"], "DB_HOST was not injected"
assert env["DB_PORT"].isdigit(), "DB_PORT was not injected: " + env["DB_PORT"]
assert env["DB_URL"].startswith("postgres://"), "DB_URL was not injected: " + env["DB_URL"]
assert env["DATABASE_URL"] == env["DB_URL"], "the envMap alias did not reach the consumer process"
BODY_CHECK

  # Measured footprint of the ready consumer: the application's own peak
  # resident memory and the memory the fixture's containers hold at readiness.
  # Both are recorded, never asserted, so a heavy host stays visible.
  local rss_kb container_mem ids db_id
  rss_kb="$("$PYTHON" -c 'import json, sys; print(json.load(open(sys.argv[1]))["rssKb"])' "$WORK/body-$label.json")"
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" 2>/dev/null | tr '\n' ' ')"
  db_id="$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter "label=com.docker.compose.service=db" 2>/dev/null | head -1)"
  if [ -n "${ids// /}" ]; then
    container_mem="$(docker stats --no-stream --format '{{.Name}}={{.MemUsage}}' $ids 2>/dev/null | tr '\n' ';' || true)"
  else
    container_mem="none"
  fi

  stop_app
  if [ "$mode" = "cold" ]; then cold_ms+=("$waited"); else warm_ms+=("$waited"); fi
  results+=("{\"round\":\"$label\",\"mode\":\"$mode\",\"url\":\"$url\",\"readyMs\":$waited,\"dependencyReused\":$reused,\"rssKb\":$rss_kb,\"dbContainer\":\"${db_id:0:12}\",\"containers\":\"$container_mem\"}")
  echo "round $label ($mode) ready in ${waited}ms (rss ${rss_kb}kB; containers ${container_mem})"
}

for index in $(seq 1 "$ROUNDS"); do
  run_round "cold-$index" cold || true
  run_round "warm-$index" warm || true
done

stop_app
stop_db

if [ -n "$(route_url "$HOST")" ]; then
  echo "the route survived teardown: $HOST" >&2
  FAILED=1
fi

leftover="$(compose ps -q 2>/dev/null || true)"
if [ -n "$leftover" ]; then
  echo "fixture containers survived teardown: $leftover" >&2
  FAILED=1
fi

DR_RESULTS="$(printf '%s\n' "${results[@]}")" DR_COLD="$(IFS=,; echo "${cold_ms[*]:-}")" DR_WARM="$(IFS=,; echo "${warm_ms[*]:-}")" DR_HOST="$HOST" DR_FAILED="$FAILED" "$PYTHON" -c '
import json, os, statistics

def series(value):
    return [int(item) for item in value.split(",") if item]

def summary(values):
    if not values:
        return None
    return {
        "count": len(values),
        "minMs": min(values),
        "medianMs": int(statistics.median(values)),
        "maxMs": max(values),
    }

records = [json.loads(line) for line in os.environ["DR_RESULTS"].splitlines() if line]
resident = [record["rssKb"] for record in records if record.get("rssKb")]
print(json.dumps({
    "fixture": "non-node-consumer",
    "runtime": "python",
    "route": os.environ["DR_HOST"],
    "rounds": records,
    "measurements": {
        "coldStart": summary(series(os.environ["DR_COLD"])),
        "warmStart": summary(series(os.environ["DR_WARM"])),
        "peakRssKb": max(resident) if resident else None,
    },
    "failed": os.environ["DR_FAILED"] == "1",
}))
'

exit "$FAILED"

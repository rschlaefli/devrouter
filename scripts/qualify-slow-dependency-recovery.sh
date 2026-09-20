#!/usr/bin/env bash
# Qualify the slow and failing dependency lifecycle (roadmap Q06).
#
# The fixture is a synthetic repository whose routed host application depends on
# one Docker dependency. The fixture controls that dependency's readiness, so the
# four provider outcomes Q06 names can be produced on demand against the built
# CLI:
#
#   slow       the dependency becomes healthy only after DR_Q06_SLOW_SECONDS
#   never      the dependency never becomes healthy on a cold start
#   unchanged  the same unhealthy dependency is already running
#   stopped    the dependency has exited and is started again
#
# The asserted contract is Q06's: a start waits for a slow dependency instead of
# failing early, a dependency that never becomes healthy produces a bounded,
# actionable failure rather than an open-ended block, and no outcome recreates or
# restarts the dependency. Elapsed time, container identity and the reported
# provider verdict are printed as evidence; the identity, RestartCount and
# boundedness facts are asserted.
#
# The dependency is a one-file busybox container whose healthcheck observes a
# file the container itself creates after DR_Q06_SLOW_SECONDS. That keeps the
# fixture deterministic and fast while still exercising the provider contract the
# real Compose healthchecks use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${DR_Q06_DIST:-$ROOT/dist/devrouter.js}"
PYTHON="${DR_Q06_PYTHON:-$(command -v python3 || true)}"
SLOW_SECONDS="${DR_Q06_SLOW_SECONDS:-40}"
CAP_SECONDS="${DR_Q06_CAP_SECONDS:-90}"
HOST="q06-app.localhost"
COMPOSE_PROJECT="devrouter-q06-fixture"

skip() { printf '%s\n' "$1"; exit 0; }
note_failure() { printf 'FAIL: %s\n' "$1" >&2; FAILED=1; }

[ -f "$DIST" ] || skip "Slow-dependency qualification skipped: build dist/devrouter.js first (pnpm build)."
[ -n "$PYTHON" ] || skip "Slow-dependency qualification skipped: python3 is unavailable."
command -v docker >/dev/null 2>&1 || skip "Slow-dependency qualification skipped: docker is unavailable."
docker info >/dev/null 2>&1 || skip "Slow-dependency qualification skipped: the Docker daemon is not reachable."
command -v curl >/dev/null 2>&1 || skip "Slow-dependency qualification skipped: curl is unavailable."
CA="$(mkcert -CAROOT 2>/dev/null || true)/rootCA.pem"
[ -f "$CA" ] || skip "Slow-dependency qualification skipped: the mkcert root CA is unavailable (run devrouter tls install)."

WORK="${DR_Q06_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/devrouter-q06.XXXXXX")}"
# Docker derives the Compose project name from the fixture directory name, and
# the fixture drives that same project with its own Compose calls, so both names
# must match exactly.
FIXTURE="$WORK/$COMPOSE_PROJECT"
APP_PID=""
FAILED=0
printf 'fixture working directory: %s\n' "$WORK"

run_dev() { node "$DIST" "$@"; }
now_ms() { "$PYTHON" -c 'import time; print(int(time.time() * 1000))'; }
compose() { docker compose -f "$FIXTURE/docker-compose.yml" "$@"; }

dep_name() {
  docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=slowdb" --format '{{.Names}}' 2>/dev/null | head -1
}

dep_state() {
  local name
  name="$(dep_name)"
  if [ -z "$name" ]; then printf 'absent'; return; fi
  docker inspect -f 'id={{slice .Id 0 12}} status={{.State.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$name" 2>/dev/null
}

dep_field() {
  local name field
  name="$(dep_name)"
  [ -n "$name" ] || { printf ''; return; }
  field="$1"
  docker inspect -f "$field" "$name" 2>/dev/null
}

# The URL the route publishes, read from the live route list rather than guessed.
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
' "$HOST"
}

stop_app() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
    APP_PID=""
  fi
  # The host application is a child of the CLI process, so the fixture stops it
  # by its own command line before releasing the route.
  pkill -f "python3 app/server.py" >/dev/null 2>&1 || true
  run_dev app rm web --repo "$FIXTURE" --keep-config >/dev/null 2>&1 || true
}

cleanup() {
  set +e
  stop_app
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [ "$FAILED" = "0" ] && [ -z "${DR_Q06_WORK:-}" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

write_fixture() {
  local mode="$1"
  mkdir -p "$FIXTURE/app"
  cat > "$FIXTURE/.devrouter.yml" <<'CONFIG_EOF'
version: 1
project:
  name: devrouter-q06-fixture

apps:
  - name: slowdb
    kind: dependency
    runtime: docker
    docker:
      service: slowdb
      composeFiles:
        - docker-compose.yml

  - name: web
    host: q06-app.localhost
    protocol: http
    runtime: host
    dependencies:
      - app: slowdb
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

  cat > "$FIXTURE/app/server.py" <<'SERVER_EOF'
"""A dependency-facing consumer used only by this qualification fixture."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "0"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        body = json.dumps({"ok": True, "port": PORT}).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
SERVER_EOF

  if [ "$mode" = "slow" ]; then
    cat > "$FIXTURE/docker-compose.yml" <<COMPOSE_EOF
services:
  slowdb:
    image: busybox:1.36
    command: ["sh", "-c", "sleep $SLOW_SECONDS; touch /tmp/ready; sleep infinity"]
    healthcheck:
      test: ["CMD-SHELL", "test -f /tmp/ready"]
      interval: 1s
      timeout: 2s
      retries: 120
COMPOSE_EOF
  else
    cat > "$FIXTURE/docker-compose.yml" <<'COMPOSE_EOF'
services:
  slowdb:
    image: busybox:1.36
    command: ["sh", "-c", "sleep infinity"]
    healthcheck:
      test: ["CMD-SHELL", "exit 1"]
      interval: 2s
      timeout: 2s
      retries: 3
COMPOSE_EOF
  fi
}

# Starts the fixture's host application in the background and classifies the
# outcome as started, failed or cap. The classification reads the CLI's own
# output: a published route means the operation completed, an exit line means it
# terminated by itself, and neither before the cap means it blocked.
start_round() {
  local label="$1"
  local log="$WORK/app-$label.log"
  : > "$log"
  ROUND_START="$(now_ms)"
  # The subshell records the CLI's own exit and stays alive to write it even
  # though the CLI fails; without the reset the parent's set -e would abort it.
  ( set +e; cd "$FIXTURE"; run_dev app run web --repo "$FIXTURE" --yes >>"$log" 2>&1; echo "exit=$?" >>"$log" ) &
  APP_PID=$!
  local deadline=$(( ROUND_START + CAP_SECONDS * 1000 ))
  ROUND_OUTCOME="cap"
  ROUND_URL=""
  while [ "$(now_ms)" -lt "$deadline" ]; do
    if grep -q '^Route https://' "$log" 2>/dev/null; then
      ROUND_OUTCOME="started"
      # Read the published route while the application is still attached to it.
      ROUND_URL="$(route_url)"
      break
    fi
    if grep -q '^exit=' "$log" 2>/dev/null; then ROUND_OUTCOME="failed"; break; fi
    sleep 0.5
  done
  ROUND_ELAPSED=$(( $(now_ms) - ROUND_START ))
  ROUND_LOG="$log"
  stop_app
}

record=()
# Round evidence is recorded as pipe-delimited fields and converted once at the
# end, so no shell quoting can corrupt the report.
record_round() { record+=("$1|$2|$3|${4:-0}|${5:-none}|${6:-}"); }

# --- round: slow ------------------------------------------------------------
write_fixture slow
compose down --volumes --remove-orphans >/dev/null 2>&1 || true
start_round slow
slow_url="$ROUND_URL"
slow_id="$(dep_field '{{slice .Id 0 12}}')"
slow_restarts="$(dep_field '{{.RestartCount}}')"
if [ "$ROUND_OUTCOME" != "started" ]; then
  note_failure "slow dependency: expected a successful start, saw $ROUND_OUTCOME"
  cat "$ROUND_LOG" >&2 || true
elif [ "$ROUND_ELAPSED" -lt $(( SLOW_SECONDS * 1000 )) ]; then
  note_failure "slow dependency: start finished after ${ROUND_ELAPSED}ms, before the dependency could be ready"
fi
if [ -n "$slow_url" ]; then
  curl -fsS --max-time 5 --cacert "$CA" "$slow_url" >/dev/null 2>&1 ||
    note_failure "slow dependency: the published route did not answer"
else
  note_failure "slow dependency: no route was published"
fi
[ "$slow_restarts" = "0" ] || note_failure "slow dependency: RestartCount reached $slow_restarts"
printf 'round slow: outcome=%s waitedMs=%s dependency=%s route=%s\n' \
  "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$(dep_state)" "${slow_url:-none}"
record_round slow "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$slow_restarts" "$slow_id"

# --- round: never -----------------------------------------------------------
write_fixture never
compose down --volumes --remove-orphans >/dev/null 2>&1 || true
start_round never
never_url="$ROUND_URL"
never_id="$(dep_field '{{slice .Id 0 12}}')"
never_restarts="$(dep_field '{{.RestartCount}}')"
if [ "$ROUND_OUTCOME" != "failed" ]; then
  note_failure "never-ready dependency: expected a bounded failure, saw $ROUND_OUTCOME"
elif ! grep -q 'unhealthy' "$ROUND_LOG"; then
  note_failure "never-ready dependency: the failure did not name the unhealthy container"
fi
[ -n "$never_url" ] && note_failure "never-ready dependency: a route was published for a failed start"
[ "$never_restarts" = "0" ] || note_failure "never-ready dependency: RestartCount reached $never_restarts"
printf 'round never: outcome=%s elapsedMs=%s dependency=%s verdict=%s\n' \
  "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$(dep_state)" "$(grep -o 'is unhealthy' "$ROUND_LOG" | head -1)"
record_round never "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$never_restarts" "$never_id" "$(grep -o 'is unhealthy' "$ROUND_LOG" | head -1)"

# --- round: unchanged -------------------------------------------------------
unchanged_before="$(dep_state)"
start_round unchanged
unchanged_after="$(dep_state)"
if [ "$ROUND_OUTCOME" = "cap" ]; then
  note_failure "unchanged unhealthy dependency: the start neither completed nor failed within ${CAP_SECONDS}s"
fi
[ "$unchanged_before" = "$unchanged_after" ] ||
  note_failure "unchanged unhealthy dependency: the container was recreated ($unchanged_before -> $unchanged_after)"
printf 'round unchanged: outcome=%s elapsedMs=%s dependency=%s\n' \
  "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$unchanged_after"
record_round unchanged "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$(dep_field '{{.RestartCount}}')" "$(dep_field '{{slice .Id 0 12}}')"

# --- round: stopped ---------------------------------------------------------
stopped_name="$(dep_name)"
stopped_id_before="$(dep_field '{{slice .Id 0 12}}')"
stopped_started_before="$(dep_field '{{.State.StartedAt}}')"
docker stop "$stopped_name" >/dev/null 2>&1 || true
start_round stopped
stopped_id_after="$(dep_field '{{slice .Id 0 12}}')"
stopped_started_after="$(dep_field '{{.State.StartedAt}}')"
[ "$stopped_id_before" = "$stopped_id_after" ] ||
  note_failure "stopped dependency: the container was recreated ($stopped_id_before -> $stopped_id_after)"
[ "$stopped_started_before" != "$stopped_started_after" ] ||
  note_failure "stopped dependency: the exited dependency was not started again"
[ "$(dep_field '{{.RestartCount}}')" = "0" ] ||
  note_failure "stopped dependency: RestartCount reached $(dep_field '{{.RestartCount}}')"
if [ "$ROUND_OUTCOME" = "cap" ]; then
  note_failure "stopped dependency: the start neither completed nor failed within ${CAP_SECONDS}s"
fi
printf 'round stopped: outcome=%s elapsedMs=%s dependency=%s\n' \
  "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$(dep_state)"
record_round stopped "$ROUND_OUTCOME" "$ROUND_ELAPSED" "$(dep_field '{{.RestartCount}}')" "$(dep_field '{{slice .Id 0 12}}')"

stop_app
compose down --volumes --remove-orphans >/dev/null 2>&1 || true
if [ -n "$(route_url)" ]; then
  note_failure "the route survived teardown: $HOST"
fi

if [ -n "${DR_Q06_RESULTS_FILE:-}" ]; then
  printf '%s\n' "${record[@]}" > "$DR_Q06_RESULTS_FILE"
fi

DR_RESULTS="$(printf '%s\n' "${record[@]}")" DR_SLOW="$SLOW_SECONDS" DR_CAP="$CAP_SECONDS" DR_FAILED="$FAILED" "$PYTHON" -c '
import json, os

records = []
for line in os.environ["DR_RESULTS"].splitlines():
    if not line:
        continue
    label, outcome, elapsed, restarts, identity, note = (line.split("|") + [""] * 6)[:6]
    records.append({
        "round": label,
        "outcome": outcome,
        "elapsedMs": int(elapsed),
        "dependencyRestarts": int(restarts or 0),
        "dependencyId": identity,
        "note": note,
    })
print(json.dumps({
    "fixture": "slow-dependency-recovery",
    "slowSeconds": int(os.environ["DR_SLOW"]),
    "capSeconds": int(os.environ["DR_CAP"]),
    "rounds": records,
    "failed": os.environ["DR_FAILED"] == "1",
}))
'

exit "$FAILED"

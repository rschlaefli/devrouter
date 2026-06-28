#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROUTING_DIR="$ROOT_DIR/examples/routing"
LOG_DIR="${TMPDIR:-/tmp}"
HOST_LOG="$LOG_DIR/devrouter-routing-host.log"

STARTED_ROUTER="false"
HOST_RUN_PID=""

run_dev() {
  if command -v dev >/dev/null 2>&1; then
    dev "$@"
    return
  fi

  node "$ROOT_DIR/dist/dev.js" "$@"
}

cleanup() {
  set +e
  if [ -n "$HOST_RUN_PID" ]; then
    kill "$HOST_RUN_PID" >/dev/null 2>&1 || true
    wait "$HOST_RUN_PID" >/dev/null 2>&1 || true
  fi

  if command -v pnpm >/dev/null 2>&1; then
    pnpm exec tsx -e "import { removeHostRouteByName } from './src/core/host-routes'; try { removeHostRouteByName('web-host', process.argv[1]); } catch {}" "$ROUTING_DIR" >/dev/null 2>&1 || true
  fi

  docker compose -f "$ROUTING_DIR/docker-compose.yml" down -v >/dev/null 2>&1 || true

  if [ "$STARTED_ROUTER" = "true" ]; then
    run_dev down >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

status_json="$(run_dev status --json)"
router_running="$(node -e "const data = JSON.parse(process.argv[1]); process.stdout.write(String(data.routerRunning));" "$status_json")"
if [ "$router_running" != "true" ]; then
  run_dev up
  STARTED_ROUTER="true"
fi

run_dev tls install >/dev/null

run_dev app run web-docker --repo "$ROUTING_DIR" --yes
run_dev app run web-host --repo "$ROUTING_DIR" --yes >"$HOST_LOG" 2>&1 &
HOST_RUN_PID=$!

READY="false"
for _ in $(seq 1 60); do
  routes_json="$(run_dev ls --json || true)"
  if [ -n "$routes_json" ] && node -e "const data = JSON.parse(process.argv[1]); const hosts = new Set(data.routes.flatMap((route) => route.hosts)); process.exit(hosts.has('routing-host.localhost') && hosts.has('routing-docker.localhost') && hosts.has('routing-db.localhost') ? 0 : 1);" "$routes_json"; then
    READY="true"
    break
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  echo "Routing example routes did not become ready in time." >&2
  echo "Host log:" >&2
  cat "$HOST_LOG" >&2 || true
  exit 1
fi

routes_json="$(run_dev ls --json)"
host_url="$(node -e "const data = JSON.parse(process.argv[1]); const route = data.routes.find((entry) => entry.hosts.includes('routing-host.localhost')); if (!route || !route.urls[0]) process.exit(1); process.stdout.write(route.urls[0]);" "$routes_json")"
docker_url="$(node -e "const data = JSON.parse(process.argv[1]); const route = data.routes.find((entry) => entry.hosts.includes('routing-docker.localhost')); if (!route || !route.urls[0]) process.exit(1); process.stdout.write(route.urls[0]);" "$routes_json")"

curl -ksSf "$host_url/healthz" >/dev/null
curl -ksSf "$docker_url/healthz" >/dev/null

echo "Routing smoke test passed."
echo "  Host app:   $host_url"
echo "  Docker app: $docker_url"
echo "  DB route:   postgres://routing-db.localhost:5432 (tls required)"

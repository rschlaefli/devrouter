#!/usr/bin/env bash
# Qualify container-local runtime death (roadmap Q07/Q08 evidence, RF09 live cell).
#
# The fixture is a synthetic repository whose single routed Docker application is
# memory-limited, so the kernel or daemon can end it without any host pressure.
# Two deaths are produced on demand against the built CLI:
#
#   sigkill  the container is killed with SIGKILL: exit 137, OOMKilled false
#   oom      the container allocates past its cgroup limit and the kernel's OOM
#            killer ends it: exit 137, OOMKilled true
#
# Devrouter documents that it neither detects nor prevents OOM, so the asserted
# contract is the honest half of Q07/Q08. A death must not be reported as a
# healthy environment, must not be silently recreated or replaced, must keep the
# container and its published route as inspectable evidence, and must be
# recoverable through the ordinary paths: restarting the same container through
# its own Compose project, and releasing the route with
# `devrouter app rm <app> --keep-config`. No devrouter output may claim an OOM
# classification, because the product has no OOM classifier.
#
# Exit codes: 0 every assertion held, 1 an assertion failed, 3 a prerequisite was
# unavailable and no cell ran. A skip is not a pass, so a caller that records
# acceptance must reject 3 instead of reading it as success.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${DR_KR_DIST:-$ROOT/dist/devrouter.js}"
NODE="${DR_KR_NODE:-$(command -v node || true)}"
HOST="killed-runtime.localhost"
COMPOSE_PROJECT="devrouter-killed-runtime-fixture"
APP="web"
WORK="${DR_KR_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/devrouter-killed-runtime.XXXXXX")}"
FIXTURE="$WORK/$COMPOSE_PROJECT"
FAILED=0
CELLS_RUN=0

skip() { printf '%s\n' "$1"; exit 3; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILED=1; }
check() { [ "$2" = "$3" ] || fail "$1: got '$2', expected '$3'"; }

[ -f "$DIST" ] || skip "Killed-runtime qualification skipped: build dist/devrouter.js first (pnpm build)."
[ -n "$NODE" ] || skip "Killed-runtime qualification skipped: node is unavailable."
command -v docker >/dev/null 2>&1 || skip "Killed-runtime qualification skipped: docker is unavailable."
docker info >/dev/null 2>&1 || skip "Killed-runtime qualification skipped: the Docker daemon is not reachable."
command -v curl >/dev/null 2>&1 || skip "Killed-runtime qualification skipped: curl is unavailable."
CA="$(mkcert -CAROOT 2>/dev/null || true)/rootCA.pem"
[ -f "$CA" ] || skip "Killed-runtime qualification skipped: the mkcert root CA is unavailable (run devrouter tls install)."

printf 'fixture working directory: %s\n' "$WORK"

run_dev() { "$NODE" "$DIST" "$@"; }

compose_files() {
  # The running container carries the exact file set devrouter composed, so the
  # fixture never guesses the generated overlay path.
  local id
  id="$(container_id)"
  [ -n "$id" ] || { printf ''; return; }
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id" 2>/dev/null
}

compose() {
  local files
  files="$(compose_files)"
  [ -n "$files" ] || { printf 'no fixture container is present\n' >&2; return 1; }
  local args=()
  local file
  local IFS=','
  for file in $files; do args+=("-f" "$file"); done
  docker compose "${args[@]}" "$@"
}

container_id() {
  docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=$APP" 2>/dev/null | head -1
}

container_state() {
  local id
  id="$(container_id)"
  [ -n "$id" ] || { printf 'absent'; return; }
  docker inspect -f 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' "$id" 2>/dev/null
}

route_url() {
  run_dev ls --json 2>/dev/null | "$NODE" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      for (const route of data.routes ?? [])
        if ((route.hosts ?? []).includes(process.argv[1]))
          for (const url of route.urls ?? []) { console.log(url); return; }
    });
  ' "$HOST"
}

route_serves() {
  local url
  url="$(route_url)"
  [ -n "$url" ] || return 1
  curl -fsS --max-time 5 --cacert "$CA" "$url" >/dev/null 2>&1
}

wait_for() {
  local seconds="$1" description="$2"
  shift 2
  local deadline=$((SECONDS + seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  printf 'timed out after %ss waiting for %s\n' "$seconds" "$description" >&2
  return 1
}

container_running() { [ "$(container_state)" = "status=running exit=0 oom=false restarts=0" ]; }
container_exited() { case "$(container_state)" in status=exited*) return 0;; *) return 1;; esac; }
route_absent() { [ -z "$(route_url)" ]; }

devrouter_output() {
  # Every product statement about this fixture, collected for the
  # no-OOM-claim assertion. \`ls\` is filtered to the fixture's own route so
  # unrelated machine routes cannot satisfy or fail the check.
  run_dev status --repo "$FIXTURE" --json 2>&1 || true
  run_dev doctor --repo "$FIXTURE" 2>&1 || true
  run_dev ls --json 2>&1 | "$NODE" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      for (const route of data.routes ?? [])
        if ((route.hosts ?? []).includes(process.argv[1])) console.log(JSON.stringify(route));
    });
  ' "$HOST" || true
}

oom_claims() {
  # Devrouter documents that it neither detects nor prevents OOM, so no product
  # statement may classify this death as an OOM kill.
  printf '%s' "$1" | grep -Eci 'oom ?kill|oomkilled|out of memory' || true
}

cleanup() {
  set +e
  run_dev app rm "$APP" --repo "$FIXTURE" --keep-config >/dev/null 2>&1
  compose down --volumes --remove-orphans >/dev/null 2>&1
  if [ "$FAILED" = "0" ] && [ -z "${DR_KR_WORK:-}" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

write_fixture() {
  mkdir -p "$FIXTURE"
  cat > "$FIXTURE/.devrouter.yml" <<'CONFIG_EOF'
version: 1
project:
  name: devrouter-killed-runtime-fixture

apps:
  - name: web
    host: killed-runtime.localhost
    protocol: http
    runtime: docker
    docker:
      service: web
      internalPort: 8080
      composeFiles:
        - docker-compose.yml
CONFIG_EOF
  cat > "$FIXTURE/docker-compose.yml" <<'COMPOSE_EOF'
services:
  web:
    image: busybox:1.36
    mem_limit: 64m
    environment:
      DR_KR_HOG: "${DR_KR_HOG:-0}"
    command:
      - sh
      - -c
      - |
        if [ "$${DR_KR_HOG:-0}" = "1" ]; then
          fill=$$(yes 0123456789abcdef | head -c 200m)
          echo "allocated $${#fill} bytes"
        fi
        mkdir -p /srv
        echo ok > /srv/index.html
        exec httpd -f -p 8080 -h /srv
COMPOSE_EOF
  git -C "$FIXTURE" init -q 2>/dev/null || true
}

write_fixture

echo "--- cell 1: SIGKILL (exit 137 without an OOM classification)"
run_dev app run "$APP" --repo "$FIXTURE" >/dev/null 2>&1 || true
wait_for 60 "the published route to serve" route_serves || fail "the route never served before the kill"
id_before="$(container_id)"
check "the container is running before the kill" "$(container_state)" "status=running exit=0 oom=false restarts=0"
docker kill --signal KILL "$id_before" >/dev/null
wait_for 15 "the killed container to exit" container_exited || fail "the killed container never reached exited"
check "the SIGKILL exit" "$(container_state)" "status=exited exit=137 oom=false restarts=0"
check "the killed container is retained, not replaced" "$(container_id)" "$id_before"

status_output="$(devrouter_output)"
check "no devrouter statement classifies the death as an OOM kill" "$(oom_claims "$status_output")" "0"
sigkill_state="$(container_state)"
printf 'sigkill cell state: %s\n' "$sigkill_state"
if [ -n "$(route_url)" ]; then
  echo "route retained after the kill: $(route_url)"
else
  fail "the published route disappeared after the kill instead of remaining inspectable"
fi
if route_serves; then fail "a dead container still served the route"; fi

echo "--- cell 1 recovery: the same container restarts and the route serves again"
compose up -d "$APP" >/dev/null
wait_for 60 "the recovered route to serve" route_serves || fail "the route did not recover"
check "recovery reused the same container" "$(container_id)" "$id_before"
CELLS_RUN=$((CELLS_RUN + 1))

echo "--- cell 2: OOM kill (exit 137 with OOMKilled true)"
DR_KR_HOG=1 compose up -d --force-recreate "$APP" >/dev/null
wait_for 30 "the kernel to end the allocating container" container_exited || fail "the allocating container was never killed"
oom_state="$(container_state)"
printf 'oom cell state: %s\n' "$oom_state"
check "the OOM exit" "$oom_state" "status=exited exit=137 oom=true restarts=0"
oom_id="$(container_id)"
sleep 5
check "no silent recreation followed the OOM kill" "$(container_id)" "$oom_id"
status_output="$(devrouter_output)"
check "no devrouter statement classifies the death as an OOM kill" "$(oom_claims "$status_output")" "0"
if [ -n "$(route_url)" ]; then
  echo "route retained after the OOM kill: $(route_url)"
else
  fail "the published route disappeared after the OOM kill instead of remaining inspectable"
fi
CELLS_RUN=$((CELLS_RUN + 1))

echo "--- cell 2 recovery: the ordinary paths restart and release"
compose up -d "$APP" >/dev/null
wait_for 60 "the recovered route to serve after the OOM kill" route_serves || fail "the route did not recover after the OOM kill"
run_dev app rm "$APP" --repo "$FIXTURE" --keep-config >/dev/null
compose down --volumes --remove-orphans >/dev/null
# A routed Docker application publishes its route through the container's own
# labels, so the route leaves with the container; app rm is the idempotent
# host-state half of the same release.
wait_for 30 "the released route to disappear" route_absent ||
  fail "the route survived the container's removal"

printf '{"schema":"devrouter.killed-runtime.v1","cells":%s,"sigkill":"%s","oom":"%s","revision":"%s","distSha256":"%s"}\n' \
  "$CELLS_RUN" "$sigkill_state" "$oom_state" \
  "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)" \
  "$("$NODE" -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$DIST" 2>/dev/null || true)"
if [ "$FAILED" != "0" ]; then printf 'killed-runtime qualification FAILED\n' >&2; exit 1; fi
printf 'killed-runtime qualification passed\n'

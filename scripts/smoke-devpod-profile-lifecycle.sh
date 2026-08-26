#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="${PPID}-$$"
WORKSPACE_A="devpod-profile-${RUN_ID}-a"
WORKSPACE_B="devpod-profile-${RUN_ID}-b"

new_temp_dir() {
  local base="${TMPDIR:-/tmp}"
  base="${base%/}"
  mktemp -d "$base/$1.XXXXXX"
}

REPO_A="$(cd "$(new_temp_dir devrouter-devpod-profile-a)" && pwd -P)"
REPO_B="$(cd "$(new_temp_dir devrouter-devpod-profile-b)" && pwd -P)"

cleanup() {
  local status=$?
  set +e

  for workspace in "$WORKSPACE_A" "$WORKSPACE_B"; do
    devpod stop "$workspace" --provider docker --silent >/dev/null 2>&1 || true
  done

  for repo in "$REPO_A" "$REPO_B"; do
    if [ -d "$repo" ]; then
      rm -rf "$repo"
    fi
  done

  exit "$status"
}
trap cleanup EXIT

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "DevPod profile smoke requires '$1'." >&2
    exit 1
  fi
}

require docker
require devpod
require node

DEVPOD_VERSION="$(devpod version 2>/dev/null | tr -d '\r')"
if [ "$DEVPOD_VERSION" != "v0.6.15" ]; then
  echo "Expected DevPod v0.6.15 for this characterization, found '$DEVPOD_VERSION'." >&2
  exit 1
fi

prepare_fixture() {
  local repo="$1"
  cp -R "$ROOT/examples/devcontainer/." "$repo/"

  node - "$repo/.devcontainer/docker-compose.yml" \
    "$repo/.devcontainer/post-create.sh" \
    "$repo/.devcontainer/devcontainer.json" \
    "$repo/.devcontainer/devcontainer.profile.json" <<'NODE'
const fs = require('node:fs');

const [composePath, postCreatePath, sourceConfigPath, profilePath] = process.argv.slice(2);
let compose = fs.readFileSync(composePath, 'utf8');
if (!compose.includes('\nnetworks:\n')) {
  throw new Error('fixture compose file has no networks section');
}
compose = compose.replace(
  '\nnetworks:\n',
  '\n  optional:\n    image: node:24-bookworm-slim\n    command: sleep infinity\n\nnetworks:\n',
);
fs.writeFileSync(composePath, compose);

let postCreate = fs.readFileSync(postCreatePath, 'utf8');
postCreate += `
count_file="/workspaces/devcontainer-demo/post-create-count"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file")"
fi
printf '%s\\n' "$((count + 1))" > "$count_file"
`;
fs.writeFileSync(postCreatePath, postCreate);

const config = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8'));
config.runServices = ['app', 'postgres'];
fs.writeFileSync(profilePath, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

set_profile_services() {
  local profile_path="$1"
  shift
  node - "$profile_path" "$@" <<'NODE'
const fs = require('node:fs');

const [profilePath, ...services] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
config.runServices = services;
fs.writeFileSync(profilePath, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

run_devpod_up() {
  local repo="$1"
  local workspace="$2"
  devpod up "$repo" \
    --id "$workspace" \
    --provider docker \
    --open-ide=false \
    --configure-ssh=false \
    --devcontainer-path .devcontainer/devcontainer.profile.json \
    >/dev/null
}

run_devpod_stop() {
  devpod stop "$1" --provider docker --silent >/dev/null
}

service_id() {
  local repo="$1"
  local service="$2"
  docker ps -aq \
    --filter "label=com.docker.compose.project.working_dir=$repo/.devcontainer" \
    --filter "label=com.docker.compose.service=$service" | head -n 1
}

wait_for_service() {
  local repo="$1"
  local service="$2"
  local id
  local state
  for _ in $(seq 1 60); do
    id="$(service_id "$repo" "$service")"
    if [ -n "$id" ]; then
      state="$(docker inspect "$id" --format '{{.State.Status}}')"
      if [ "$state" = "running" ]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "Timed out waiting for service '$service' in the exact fixture." >&2
  exit 1
}

assert_service_running() {
  local repo="$1"
  local service="$2"
  local id
  local state
  id="$(service_id "$repo" "$service")"
  if [ -z "$id" ]; then
    echo "Expected service '$service' to be running for the exact fixture." >&2
    exit 1
  fi
  state="$(docker inspect "$id" --format '{{.State.Status}}')"
  if [ "$state" != "running" ]; then
    echo "Expected service '$service' to be running for the exact fixture." >&2
    exit 1
  fi
}

assert_service_absent() {
  local repo="$1"
  local service="$2"
  if [ -n "$(service_id "$repo" "$service")" ]; then
    echo "Expected service '$service' to be absent for the exact fixture." >&2
    exit 1
  fi
}

compose_project() {
  local repo="$1"
  local id
  id="$(service_id "$repo" app)"
  if [ -z "$id" ]; then
    echo "Could not resolve the exact app container for the fixture." >&2
    exit 1
  fi
  docker inspect "$id" --format '{{index .Config.Labels "com.docker.compose.project"}}'
}

volume_snapshot() {
  docker volume ls --filter "label=com.docker.compose.project=$1" --format '{{.Name}}' | sort
}

workspace_state() {
  devpod status "$1" --output json --container-status=true 2>/dev/null \
    | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const r = JSON.parse(s); process.stdout.write(r.state); });'
}

prepare_fixture "$REPO_A"
prepare_fixture "$REPO_B"

run_devpod_up "$REPO_A" "$WORKSPACE_A"
run_devpod_up "$REPO_B" "$WORKSPACE_B"
wait_for_service "$REPO_A" app
wait_for_service "$REPO_A" postgres
wait_for_service "$REPO_B" app
wait_for_service "$REPO_B" postgres

APP_A="$(service_id "$REPO_A" app)"
APP_B="$(service_id "$REPO_B" app)"
PROJECT_A="$(compose_project "$REPO_A")"
PROJECT_B="$(compose_project "$REPO_B")"
VOLUMES_A="$(volume_snapshot "$PROJECT_A")"
VOLUMES_B="$(volume_snapshot "$PROJECT_B")"

assert_service_running "$REPO_A" app
assert_service_running "$REPO_A" postgres
assert_service_absent "$REPO_A" optional
assert_service_running "$REPO_B" app
assert_service_running "$REPO_B" postgres
assert_service_absent "$REPO_B" optional
[ "$(cat "$REPO_A/post-create-count")" = "1" ]
[ "$(cat "$REPO_B/post-create-count")" = "1" ]

set_profile_services "$REPO_A/.devcontainer/devcontainer.profile.json" app postgres optional
run_devpod_up "$REPO_A" "$WORKSPACE_A"
# DevPod 0.6.15 does not add a service to an already-running Compose project.
wait_for_service "$REPO_A" app
assert_service_absent "$REPO_A" optional
if [ "$(service_id "$REPO_A" app)" != "$APP_A" ]; then
  echo "Running warm profile update recreated the primary app container." >&2
  exit 1
fi

run_devpod_stop "$WORKSPACE_A"
run_devpod_up "$REPO_A" "$WORKSPACE_A"

wait_for_service "$REPO_A" app
wait_for_service "$REPO_A" postgres
assert_service_running "$REPO_A" optional
if [ "$(service_id "$REPO_A" app)" != "$APP_A" ]; then
  echo "Stopped warm profile update recreated the primary app container." >&2
  exit 1
fi
if [ "$(cat "$REPO_A/post-create-count")" != "1" ]; then
  echo "Stopped warm profile update reran postCreate." >&2
  exit 1
fi
if [ "$(volume_snapshot "$PROJECT_A")" != "$VOLUMES_A" ]; then
  echo "Stopped warm profile update changed the owned volume set." >&2
  exit 1
fi

# The second exact fixture is the foreign-workspace control and must remain untouched.
if [ "$(service_id "$REPO_B" app)" != "$APP_B" ] || [ -n "$(service_id "$REPO_B" optional)" ]; then
  echo "Profile reconciliation touched the foreign fixture." >&2
  exit 1
fi
if [ "$(cat "$REPO_B/post-create-count")" != "1" ] || [ "$(volume_snapshot "$PROJECT_B")" != "$VOLUMES_B" ]; then
  echo "Profile reconciliation changed the foreign fixture state." >&2
  exit 1
fi

run_devpod_stop "$WORKSPACE_A"
run_devpod_stop "$WORKSPACE_B"
if [ "$(workspace_state "$WORKSPACE_A")" != "Stopped" ] || [ "$(workspace_state "$WORKSPACE_B")" != "Stopped" ]; then
  echo "The exact characterization workspaces did not stop." >&2
  exit 1
fi
if [ -n "$(docker ps --filter "label=com.docker.compose.project=$PROJECT_A" -q)" ] ||
  [ -n "$(docker ps --filter "label=com.docker.compose.project=$PROJECT_B" -q)" ]; then
  echo "The exact characterization left running containers." >&2
  exit 1
fi

echo "DevPod profile lifecycle characterization passed for $DEVPOD_VERSION."
echo "Cold selective startup omitted the optional service; stopped warm addition retained the app, volumes, and postCreate count."
echo "Both exact workspaces are stopped; their named volumes were retained."

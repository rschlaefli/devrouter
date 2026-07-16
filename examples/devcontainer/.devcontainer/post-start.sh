#!/usr/bin/env bash
# devrouter:managed devcontainer
set -euo pipefail

export CI=true
export npm_config_verify_deps_before_run=false
set -a
# shellcheck source=/dev/null
. .devcontainer/devcontainer.env
set +a

: "${DEVROUTER_PROCESS_HELPER:?Run devrouter ensure to start this managed application process.}"

"$DEVROUTER_PROCESS_HELPER" ensure \
  --name app \
  --match 'node server.js' \
  --log /tmp/devrouter-devcontainer-example.log \
  -- node server.js

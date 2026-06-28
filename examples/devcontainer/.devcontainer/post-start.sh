#!/usr/bin/env bash
set -euo pipefail

set -a
. .devcontainer/devcontainer.env
set +a

if pgrep -f "node server.js" >/dev/null 2>&1; then
  exit 0
fi

nohup node server.js >/tmp/devrouter-devcontainer-example.log 2>&1 </dev/null &

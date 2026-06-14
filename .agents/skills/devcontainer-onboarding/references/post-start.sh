#!/usr/bin/env bash
# Runs on every container start. Launches the dev server in the background so the
# app is reachable without a manual step.
set -euo pipefail
cd /workspaces/{{APP}}

# See post-create.sh: DevPod truncates env_file values at '='. Re-source the
# canonical env file so the dev server gets correct URLs. (GOTCHAS #1)
set -a
. /workspaces/{{APP}}/.devcontainer/devcontainer.env
set +a

if pgrep -f "turbo run dev" >/dev/null 2>&1; then
  echo "[post-start] Dev server already running."
  exit 0
fi

echo "[post-start] Starting dev server in the background (logs: /tmp/dev.log)..."
# Fully detach: new session (setsid) AND redirect the WHOLE command's fds.
# Redirecting only the inner process leaves the wrapper holding DevPod's agent
# pipe open, which hangs `devpod up`. (GOTCHAS #2)
setsid bash -c 'pnpm dev' >/tmp/dev.log 2>&1 </dev/null &
disown 2>/dev/null || true

cat <<'EOF'
[post-start] App  -> http://localhost:{{APP_PORT}}  (first compile may take ~30s)
[post-start] OIDC -> http://localhost:{{OIDC_PORT}}/default
[post-start] Logs -> tail -f /tmp/dev.log
EOF

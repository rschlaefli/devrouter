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

# No-TTY pnpm hardening (see post-create.sh): keep `pnpm dev` from aborting on a
# node_modules purge or hanging on an implicit verify-deps install. (GOTCHAS #18)
export CI=true
export npm_config_verify_deps_before_run=false

# Double-start guard. Adapt the pattern to the repo's dev command — match what
# actually shows in `ps` (e.g. "turbo run dev", "next dev", "pnpm -F <pkg> dev").
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
[post-start] App    -> https://{{APP}}.localhost      (via devrouter; first compile ~30s)
[post-start] OIDC   -> https://oidc.{{APP}}.localhost/default
[post-start] Routes -> on the host: for a in app oidc db redis; do dev app run "$a"; done
[post-start] Logs   -> tail -f /tmp/dev.log
EOF

#!/usr/bin/env bash
# devrouter:managed devcontainer
set -euo pipefail
cd "/workspaces/{{APP}}"

# See post-create.sh: DevPod truncates env_file values at '='. Re-source the
# canonical env file so the dev server gets correct URLs. (GOTCHAS #1)
set -a
# shellcheck source=/dev/null
. "/workspaces/{{APP}}/.devcontainer/devcontainer.env"
set +a

# No-TTY pnpm hardening (see post-create.sh): keep `pnpm dev` from aborting on a
# node_modules purge or hanging on an implicit verify-deps install. (GOTCHAS #18)
export CI=true
export npm_config_verify_deps_before_run=false

: "${DEVROUTER_PROCESS_HELPER:?Run devrouter ensure to start this managed application process.}"

# Adapt --match and the command to the repo's actual dev process. The helper
# owns locking, identity checks, process-group replacement, detachment, and logs.
"$DEVROUTER_PROCESS_HELPER" ensure \
  --name app \
  --match 'turbo run dev' \
  --log /tmp/dev.log \
  -- bash -lc 'pnpm dev'

cat <<'EOF'
[post-start] App    -> https://{{APP}}.localhost      (via devrouter; first compile ~30s)
[post-start] OIDC   -> https://oidc.{{APP}}.localhost/default
[post-start] Routes -> on the host: devrouter ensure .
[post-start] Logs   -> tail -f /tmp/dev.log
EOF

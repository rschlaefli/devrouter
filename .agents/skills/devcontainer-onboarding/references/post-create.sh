#!/usr/bin/env bash
# Runs once when the dev container is created. Installs deps and prepares the DB.
# Replace the pnpm/Prisma commands with the repo's equivalents for other stacks.
set -euo pipefail
cd /workspaces/{{APP}}

# DevPod truncates env_file values at '=' (a URL ...?schema=public arrives as
# ...?schema), which makes Prisma emit an empty search_path. Re-source the
# canonical env file so values with '=' are intact. (GOTCHAS #1)
set -a
. /workspaces/{{APP}}/.devcontainer/devcontainer.env
set +a

echo "[post-create] Installing dependencies (pnpm)..."
# Dev container tolerates lockfile drift so a fresh clone always installs.
# CI/Docker keep --frozen-lockfile for reproducibility.
pnpm install --no-frozen-lockfile

echo "[post-create] Generating Prisma client..."
pnpm -F {{PKG}} prisma:generate

# A brand-new Postgres volume has a short warmup where the engine emits an empty
# search_path (42601) even though pg_isready is healthy. Retry. (GOTCHAS #12)
echo "[post-create] Pushing schema (retrying through DB warmup)..."
push_ok=0
for attempt in $(seq 1 12); do
  if pnpm -F {{PKG}} prisma:push; then push_ok=1; break; fi
  echo "[post-create] push attempt ${attempt} failed; retrying in 5s..."
  sleep 5
done
if [ "$push_ok" != 1 ]; then
  echo "[post-create] ERROR: prisma push never succeeded" >&2
  exit 1
fi

echo "[post-create] Seeding reference data..."
for attempt in $(seq 1 5); do
  if pnpm -F {{PKG}} prisma:seed; then break; fi
  echo "[post-create] seed attempt ${attempt} failed; retrying in 5s..."
  sleep 5
done

echo "[post-create] Done."

# Gotchas — read before scaffolding

Hard-won from onboarding a Next + Prisma + Postgres + Redis + Auth0 app. Ordered roughly by how much time each one costs when missed.

1. **DevPod lifecycle hooks truncate `env_file` values at `=`.** A URL `...?schema=public` arrives in the hook as `...?schema`, so Prisma emits an empty `search_path` (Postgres `42601`, zero-length delimited identifier). **Fix:** re-source the canonical env file inside each hook — `set -a; . .devcontainer/devcontainer.env; set +a`. Shell assignment preserves inner `=`. Single biggest trap.

2. **Fully detach the background dev server in `post-start`.** Redirect the *whole* command's fds, not just the inner process: `setsid bash -c '<dev cmd>' >/tmp/dev.log 2>&1 </dev/null &`. If the wrapper keeps DevPod's agent pipe open, `devpod up` hangs (~30 min) then fails.

3. **OIDC issuer must be identical from app server and host browser.** Run the OIDC mock as a sidecar with `network_mode: service:app`, so `http://localhost:<oidc_port>/...` resolves the same whether the app server fetches token/jwks or the browser hits authorize. Avoids the classic docker OIDC issuer mismatch with zero `/etc/hosts` edits.

4. **mock-oauth2-server: match `grant_type`, not `scope`.** The auth-code token request carries no `scope`, so a `requestParam: scope` mapping never fires and the id_token lacks `sub` (NextAuth: `missing required JWT property sub`). Use `requestParam: grant_type, match: "*"` with constant claims (`sub`, `email`) for a stable one-click admin. Keep `interactiveLogin: false`.

5. **Use a stable `sub` across restarts.** The app's Account table is usually unique on `(provider, providerAccountId=sub)`. A constant `sub` (e.g. `dev-admin`) keeps the same user/account row across container restarts.

6. **Named volumes for `node_modules`** (root + each workspace package) so Linux-native binaries (Prisma engines, esbuild, sharp) aren't clobbered by the host's macOS `node_modules` over the bind mount. Bind-mount the repo `:cached`; shadow `node_modules` with named volumes.

7. **glibc base, not Alpine, for the dev image.** `node:<LTS>-bookworm-slim` gives painless Prisma/esbuild/sharp native binaries. (The *prod* image can stay Alpine; the dev container favors fewer surprises.)

8. **Install pnpm with `npm i -g pnpm@<ver>`, not corepack.** `corepack prepare` can fail signature verification on pinned Node (`Cannot find matching keyid`). Mirror the prod Dockerfile.

9. **Pin the pnpm store off the bind mount** — `pnpm config set store-dir $PNPM_HOME/.pnpm-store` — so a `.pnpm-store/` doesn't leak into the repo and doesn't fight the host store.

10. **`init: true`** on the app service (tini as PID 1) to reap the dev server's zombie children and forward signals.

11. **Publish on `127.0.0.1` via compose `ports:`**, not (only) DevPod `forwardPorts`, so the host browser reaches app + aux ports without an active IDE/forward session on the local docker provider. (Remote providers still need `forwardPorts`.) Never publish ports devrouter owns (80/443/5432) or its dashboard port (`127.0.0.1:8080`) — pick a non-colliding host port for an OIDC/admin sidecar.

12. **Fresh-Postgres warmup** — even after `pg_isready` reports healthy, the first `prisma db push` on a brand-new volume can transiently fail (empty `search_path`). Retry the push several times; a warm DB succeeds first try.

13. **Self-contained compose** — keep one `.devcontainer/docker-compose.yml`; do **not** extend the root compose. A single compose project directory avoids relative-path ambiguity for bind mounts and init scripts.

14. **`devpod up --recreate` does NOT recreate a `network_mode: service:app` sidecar.** After changing a sidecar's port/config, an in-place `--recreate` leaves it on the old config in the shared netns (nothing listens on the new port). A fresh `devpod up` (no existing containers) is fine. To force it in place: `docker compose -p <project> -f .devcontainer/docker-compose.yml -f <devpod-override> up -d --force-recreate --no-deps <sidecar>` (get project + override file from `docker inspect <sidecar> --format '{{index .Config.Labels "com.docker.compose.project"}}'` and the `...project.config_files` label).

## Container-tolerant install vs frozen CI

The container can use `pnpm install --no-frozen-lockfile` (a fresh clone always installs even with minor lockfile drift); **keep CI/Docker `--frozen-lockfile`** for reproducibility. If the prod Dockerfile uses `--frozen-lockfile`, make sure the committed lockfile is actually in sync (a drifted lockfile breaks the prod image even though the dev container forgives it).

## pnpm 11 note (if pinning a current pnpm)

pnpm 11 reads **no** settings from the package.json `pnpm` field and **only** auth/registry settings from `.npmrc`. Move install settings (`nodeLinker`, `excludeLinksFromLockfile`, overrides, …) to `pnpm-workspace.yaml` (camelCase), and use `allowBuilds:` (a map) instead of `onlyBuiltDependencies:` (a list). Otherwise `--frozen-lockfile` fails with `ERR_PNPM_IGNORED_BUILDS` or `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.

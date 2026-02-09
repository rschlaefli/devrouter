# AGENTS.md

Guidance for agentic coders working in this repository.

## Setup docs

- [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md)
- [`docs/REPO_ONBOARDING.md`](./docs/REPO_ONBOARDING.md)
- [`demo/README.md`](./demo/README.md)
- [`docs/PLAN.md`](./docs/PLAN.md)

## Documentation sync requirement

Keep these docs up to date with any behavior, command, schema, or onboarding workflow changes:

1. `README.md`
2. `AGENTS.md`
3. `docs/GETTING_STARTED.md`
4. `docs/REPO_ONBOARDING.md`
5. `docs/PLAN.md`
6. `demo/README.md`

## Current product model

`devrouter` now uses one per-repo config file:

- `.devrouter.yml`

Supported routing:

- HTTP host-run apps
- HTTP docker apps
- TCP PostgreSQL docker apps on shared `:5432` (TLS/SNI)

## Supported command surface

- `dev init`
- `dev up`, `dev down`, `dev status`, `dev doctor` (alias: `dev verify`), `dev ls`, `dev open`, `dev logs`, `dev tls install`
- `dev repo init`
- `dev app add`, `dev app ls`, `dev app run`, `dev app exec`, `dev app rm`

## Repository map

- `src/cli.ts`: command registration (lazy-loaded handlers)
- `src/core/ai-prompt.ts`: canonical AI onboarding prompt template + command intents
- `src/core/doctor.ts`: diagnostic report engine for global + repo checks
- `src/core/status.ts`: status collection + readiness insights
- `src/core/repo-config.ts`: `.devrouter.yml` schema + strict validation
- `src/core/app-run.ts`: runtime orchestration, `startAppDependencies()` helper, `runConfiguredApp()`, `execWithAppEnv()`
- `src/core/docker-run.ts`: cached compose overlay generation, compose up, `queryMappedPort()`
- `src/commands/app-exec.ts`: `dev app exec` command handler
- `src/core/routes.ts`: discover HTTP + TCP routes from labels
- `src/core/router.ts`: shared Traefik stack/files under `~/.config/devrouter`
- `src/core/host-routes.ts`: host process route state + dynamic file rendering
- `src/core/paths.ts`: path traversal guard (`assertPathWithinRepo`) for repo-scoped file references
- `src/core/tls.ts`: mkcert integration and TLS enablement
- `src/commands/logs.ts`: `dev logs` command handler (Traefik log access)
- `src/core/output.ts`: human table + JSON output
- `src/types.ts`: shared types
- `demo/.devrouter.yml`: complete sample config for host+docker+postgres routing
- `scripts/smoke-demo.sh`: end-to-end demo smoke script

## Non-negotiable constraints

1. Router/global artifacts must remain under `~/.config/devrouter`.
2. `.devrouter.yml` is the only supported repo config for new flows.
3. No global repo registry.
4. Keep `.localhost` as hostname convention.
5. Keep Traefik ownership of `80/443/5432`.
6. Postgres TCP hostname multiplexing remains TLS-required.

## Security constraints

1. `.devrouter.yml` paths (`composeFiles`, `hostRun.cwd`) must not escape repo root — enforced by `assertPathWithinRepo` in `src/core/paths.ts`.
2. Hostnames must match `VALID_HOSTNAME_RE` (lowercase alphanumeric + hyphens + `.localhost` suffix). No underscores.
3. Dependency graphs are validated for cycles at resolution time (`resolveAppDependencies`).
4. `shell:true` in host-run spawn is intentional (same trust model as npm scripts / docker-compose). Command length capped at 4096 chars.

## Architecture patterns

- **Command pattern**: thin `src/commands/*.ts` handler imports a core function from `src/core/*.ts`. Keep handlers minimal.
- **Dep lifecycle**: `startAppDependencies()` in `app-run.ts` is the reusable helper for starting deps, resolving env vars, and returning a `stopDeps()` cleanup. Any new command needing resolved dep env should call this.
- **Port mapping**: `queryMappedPort()` in `docker-run.ts` calls `docker compose port` to discover random host ports. `prepareDockerOverlay()` accepts `publishTcpPorts` to auto-publish `0:<internalPort>` for TCP deps.
- **Env injection**: TCP deps get `<UPPER_NAME>_HOST`/`_PORT`. Postgres deps additionally get `DATABASE_URL` and `SHADOW_DATABASE_URL` with fixed `prisma:prisma` credentials.

## Validation checklist

1. `pnpm typecheck`
2. `pnpm build`
3. `dev doctor --repo ./demo`
4. `pnpm demo:smoke` for full route showcase/regression smoke
5. Update docs for any behavior/surface changes

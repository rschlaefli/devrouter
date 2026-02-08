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

- `dev up`, `dev down`, `dev status`, `dev ls`, `dev open`, `dev tls install`
- `dev repo init`
- `dev app add`, `dev app ls`, `dev app run`, `dev app rm`

## Repository map

- `src/cli.ts`: command registration (lazy-loaded handlers)
- `src/core/repo-config.ts`: `.devrouter.yml` schema + strict validation
- `src/core/app-run.ts`: runtime orchestration + dependency prompt logic
- `src/core/docker-run.ts`: cached compose overlay generation + compose up
- `src/core/routes.ts`: discover HTTP + TCP routes from labels
- `src/core/router.ts`: shared Traefik stack/files under `~/.config/devrouter`
- `src/core/host-routes.ts`: host process route state + dynamic file rendering
- `src/core/tls.ts`: mkcert integration and TLS enablement
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

## Validation checklist

1. `pnpm typecheck`
2. `pnpm build`
3. `pnpm demo:smoke` for full route showcase/regression smoke
4. Update docs for any behavior/surface changes

# AGENTS.md

Guidance for agentic coders working in this repository.

## Setup docs

- [`GETTING_STARTED.md`](./GETTING_STARTED.md)
- [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)

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

Legacy cutover commands intentionally fail with migration guidance:

- `dev add`
- `dev host ...`

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
3. Smoke-test changed command paths
4. Update docs for any behavior/surface changes

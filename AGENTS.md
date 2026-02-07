# AGENTS.md

Guidance for agentic coders working in this repository.

## Environment setup

For prerequisites, local install flow, localhost domain details, and first-run commands, use:

- [`GETTING_STARTED.md`](./GETTING_STARTED.md)
- [`REPO_ONBOARDING.md`](./REPO_ONBOARDING.md)

## Mission

Keep `devrouter` simple, local-first, and understandable.

Primary goal:

- One shared Traefik router on `80/443`
- Multiple Compose projects reachable by `*.localhost`
- Minimal onboarding and minimal moving parts

## Product boundaries (MVP)

Current supported commands:

- `dev up`
- `dev down`
- `dev status [--json]`
- `dev ls [--json]`
- `dev open <name>`
- `dev add --service ... --port ...`
- `dev tls install`
- `dev host run --name <route> [--repo <path>]`
- `dev host attach --name <route> [--repo <path>]`
- `dev host ls [--json]`
- `dev host rm --name <route> [--repo <path>]`

Out of scope for MVP (defer unless explicitly requested):

- database helper command (`dev db`)
- DNS installer command (`dev dns`)
- Kubernetes/cluster features
- heavy abstraction layers

## Design principles

1. Optimize for readability over cleverness.
2. Keep command handlers thin; put logic in `src/core/*`.
3. Prefer deterministic, idempotent operations.
4. Treat Docker labels as source of truth.
5. Avoid hidden side effects and silent mutation.

## Repository map

- `src/cli.ts`: CLI wiring
- `src/commands/*`: command entry points
- `src/core/router.ts`: router file generation + compose lifecycle
- `src/core/docker.ts`: Docker client/context/network helpers
- `src/core/routes.ts`: label parsing + route discovery
- `src/core/add-app.ts`: compose override file generation
- `src/core/tls.ts`: mkcert + TLS activation
- `src/core/host-config.ts`: parse/validate `devrouter.host.yml`
- `src/core/host-routes.ts`: host-route state + Traefik host route rendering
- `src/core/host-process.ts`: run/attach process monitoring + port detection
- `src/core/output.ts`: table/JSON output formatting
- `src/types.ts`: shared model types

## Non-negotiable constraints

1. Router artifacts must remain under `~/.config/devrouter`.
2. App repos remain independent; no central registry file.
3. `dev add` should continue generating `docker-compose.devrouter.yml`.
4. Host mode config file is `<repo>/devrouter.host.yml` (no central registry).
5. `dev up` must fail clearly when `80/443` are occupied.
6. Keep `.localhost` as default hostname strategy.

## Implementation conventions

1. Use TypeScript with strict typing.
2. Keep dependencies minimal.
3. Use small pure helpers for parsing/formatting.
4. Keep output concise and scriptable (`--json` where applicable).
5. Use actionable error messages with remediation steps.

## Safety and mutation policy

1. Do not edit system DNS/resolver files in MVP.
2. Do not auto-stop foreign containers/processes.
3. Do not publish app/DB ports automatically.
4. Do not introduce destructive Docker/Git operations without explicit request.

## Change checklist (before finishing)

1. `pnpm typecheck`
2. `pnpm build`
3. Smoke check relevant commands touched
4. Verify docs updated if behavior changed
5. Keep module boundaries intact

## Acceptance baseline

At minimum, a healthy change should preserve:

1. `dev status` works
2. `dev ls` discovers both docker and host-managed routes
3. `dev add` produces valid compose override
4. `dev host run` updates route target when app port changes
5. `dev tls install` updates certs/config correctly without clobbering host routes

## Roadmap pointer

Future expansions are tracked in `PLAN.md`. Keep new work aligned to that plan unless priorities change.

# PLAN.md

Roadmap and execution status for `devrouter` with unified `.devrouter.yml` and stable CLI surface.

## Progress log

Completed milestones from recent commits:

- `d0ea24a`: Initial MVP CLI and documentation baseline.
- `482483a`: Startup latency improvements (`dev --help` fast path via lazy loading).
- `ee08403`: Host-run app support and host route state handling.
- `5be481d`: Unified `.devrouter.yml`, `repo/app` commands, and TCP/Postgres routing on shared `:5432`.
- `unreleased`: Added AI-native `dev init` command that prints the canonical onboarding prompt and stable command intents.
- `unreleased`: Added `dev doctor` (`dev verify`) diagnostics and richer `dev status` readiness insights.
- `unreleased`: Added full in-repo demo workspace (`demo/`) with host app + docker app + postgres + reusable smoke script (`pnpm demo:smoke`).
- `unreleased`: M1 security hardening — path traversal guard, hostname regex validation, dependency cycle detection, shell:true trust model documented + command length cap.
- `unreleased`: TCP port injection for host app deps — `DATABASE_URL`, `SHADOW_DATABASE_URL`, `_HOST`/`_PORT` env vars auto-injected. `queryMappedPort()` + `publishTcpPorts` overlay in `docker-run.ts`.
- `unreleased`: `dev app exec <name> -- <command>` — one-shot commands with resolved dep env vars. Refactored `startAppDependencies()` helper shared by `run` and `exec`.

## Current baseline

Delivered and active:

- Unified per-repo config: `.devrouter.yml`
- Command groups: `dev repo ...` and `dev app ...`
- HTTP routing for host-run and Docker-run apps
- TCP/Postgres Docker routing on `:5432` with TLS/SNI
- Shared router ownership of `80/443/5432`
- Bundled demo repo (`demo/.devrouter.yml`) for onboarding rehearsal and smoke validation
- TCP port injection for host app TCP deps (`DATABASE_URL`, `SHADOW_DATABASE_URL`, `_HOST`/`_PORT`)
- `dev app exec` for one-shot commands with resolved dep env

## Onboarding readiness sprint

Goal: stabilize behavior and docs before broader repository onboarding.

Workstream checklist:

- [x] Host-run failure path cleanup: ensure timed-out startup does not leave child process running.
- [x] Dependency policy enforcement: fail fast when host-runtime dependencies are declared (Docker dependencies only in v1 auto-start flow).
- [x] Host-route TLS rendering consistency with current TLS state.
- [x] Documentation polish for first onboarding path and current limitations.
- [x] Add full demo app/config for onboarding rehearsal and smoke tests.
- [ ] Add automated tests for the above behavioral guarantees.

## Post-onboarding milestones

## Milestone 1: Hardening and tests

Acceptance criteria:

- Schema tests cover valid/invalid `.devrouter.yml` combinations and strict unknown-field rejection.
- Integration tests cover `dev app run` host mode, docker mode, dependency prompt behavior, and route listing for HTTP + TCP.
- Smoke tests validate both Docker Desktop and OrbStack local contexts.
- `dev --help` remains sub-second in normal local runs.

## Milestone 2: Protocol and runtime expansion

Acceptance criteria:

- Add MySQL TCP routing support with explicit TLS/SNI requirements.
- Evaluate and decide on Redis TCP support (implemented or rejected with rationale).
- Define host runtime TCP strategy (supported scope or explicit non-support).
- Add `dev db` helper for connection snippets.

## Milestone 3: UX and packaging

Acceptance criteria:

- Add repo bootstrap helper from discovered compose/service metadata to `.devrouter.yml`.
- Add `dev app doctor` diagnostics for common misconfigurations.
- Publish clear install/distribution strategy (local install, global package path, release process).

## Milestone 4: CI and release gating

Acceptance criteria:

- CI gates include `pnpm typecheck`, `pnpm build`, and test suite.
- Command smoke tests run in CI for key flows.
- Documentation checks ensure command references stay synchronized.

## Known risks

- Postgres multiplexing on one shared `:5432` depends on TLS/SNI-capable clients.
- Host-process detection relies on local `ps`/`lsof`; behavior may differ across environments.

## Decision log

- `.devrouter.yml` is the single source of truth for per-repo routing config.
- Stable CLI surface includes `up/down/status/ls/open/tls`, `repo init`, and `app add/ls/run/exec/rm`.
- `dev app exec` auto-stops deps after command exit.
- `startAppDependencies()` is the shared dep-lifecycle helper used by both `run` and `exec`.
- TLS remains mandatory for multiplexed Postgres hostname routing on shared `:5432`.
- `80/443/5432` stay reserved for Traefik.

## Future extensions

Potential additions building on the current `exec` + dep env infrastructure:

- `--keep-deps` flag for `dev app exec` — skip stopping deps after command exit (useful for running multiple commands in sequence)
- `--env-file <path>` for `dev app exec` — dump resolved env to a file instead of running a command
- `dev app env <name>` — print resolved dep env vars to stdout without running a command
- `preStart` hooks in `.devrouter.yml` — `hostRun.hooks.preStart: string[]`, sequential shell commands that run after env resolution but before the app/command starts; integration point for secret managers (Infisical, Doppler)
- Configurable DATABASE_URL template — allow overriding fixed `prisma:prisma` credentials per app

## Non-goals (for now)

- Kubernetes support.
- Centralized global repository registry.
- Automatic system DNS mutation without explicit user opt-in.

# PLAN.md

Roadmap and execution status for `devrouter` with unified `.devrouter.yml` and stable CLI surface.

## Progress log

Completed milestones from recent commits:

- `d0ea24a`: Initial MVP CLI and documentation baseline.
- `482483a`: Startup latency improvements (`dev --help` fast path via lazy loading).
- `ee08403`: Host-run app support and host route state handling.
- `5be481d`: Unified `.devrouter.yml`, `repo/app` commands, and TCP/Postgres routing on shared `:5432`.
- `6e81c99` (v0.0.3): Doctor/status diagnostics, demo workspace, M1 security hardening, dep lifecycle (health wait, auto-stop), TCP port injection for host app deps, `dev app exec` with shared `startAppDependencies()`.
- `6fb9569` (v0.0.4): Agent discoverability — `dev repo agents` writes AGENTS.md section + distributes `.factory/skills/devrouter/SKILL.md`. Skill content embedded in CLI bundle.
- `97c3325` (v0.0.5): Vitest setup + 35 unit tests for `paths.ts` and `repo-config.ts`. CI updated with `pnpm test` gate.
- `0.0.6` (2026-02-14): onboarding UX consistency pass — `dev init` non-mutating by default with explicit write flags, prompt/schema alignment (`version: 1` skeleton + workflow clarifications), route app identity + `dev open` app-name fallback, doctor postgres-credential advisory, non-destructive Docker disk-space guidance, changelog-first adaptation policy, and demo alignment with postgres defaults.
- `0.0.7` (2026-02-14): argv-safe `dev app exec` (`shell: false` default), explicit `--shell` mode, repeatable `--env-map TARGET=SOURCE`, secret-manager interop onboarding in `dev init`, and new exec-focused unit tests.
- `0.0.8` (2026-02-15): optional Linear workflow bootstrap via `--with-linear` on `dev init` / `dev repo agents`, distributed `linear-workflow` skill + reference templates, idempotent AGENTS Linear section, prompt updates, and new unit tests for writers and command wiring.
- `0.0.9` (2026-02-15): simplified Linear bootstrap to guided workspace/team/project mapping with managed AGENTS metadata block, non-interactive placeholder fallback, and prompt/skill simplification to avoid hardcoded Linear assumptions.
- `0.0.10` (2026-02-15): secret-manager precedence hardening docs, onboarding prompt/skill updates for safe host-run wrapper ordering, and new `dev doctor` heuristic warning (`repo.host-command-env-precedence`) for risky pre-wrapper DB assignments.
- `0.0.11` (2026-02-15): exec dependency ownership teardown — `dev app exec` now stops only dependencies started by that invocation and leaves already-running services up.
- `0.0.12` (2026-02-15): TLS host-coverage hardening — SAN preservation on refresh, run/exec auto-refresh for configured hosts, and new doctor warning `repo.tls-host-coverage`.
- `0.0.13` (2026-02-15): dependency-only docker app kind (`kind: dependency`) for non-routed services (for example Redis), direct run/exec/open guardrails, and schema/CLI/docs/test updates.

## Current baseline

Delivered and active:

- Unified per-repo config: `.devrouter.yml`
- Command groups: `dev repo ...` and `dev app ...`
- HTTP routing for host-run and Docker-run apps
- TCP/Postgres Docker routing on `:5432` with TLS/SNI
- Dependency-only docker services via `kind: dependency` (non-routed, dependency lifecycle only)
- Shared router ownership of `80/443/5432`
- Bundled demo repo (`demo/.devrouter.yml`) for onboarding rehearsal and smoke validation
- TCP port injection for host app TCP deps (`DATABASE_URL`, `SHADOW_DATABASE_URL`, `_HOST`/`_PORT`)
- `dev app exec` for one-shot commands with resolved dep env
- `dev app exec` argv-safe command execution by default with explicit `--shell` opt-in
- `dev app exec --env-map TARGET=SOURCE` for deterministic env alias mapping
- `dev doctor` heuristic for host command wrapper precedence (`repo.host-command-env-precedence`) on host apps with postgres dependencies
- `dev doctor` TLS SAN coverage warning for configured hosts (`repo.tls-host-coverage`) when TLS is enabled
- `dev app run` / `dev app exec` auto-refresh TLS cert SAN coverage for configured repo hosts when needed
- Agent discoverability: `dev repo agents` + skill distribution for AI coding assistants
- Optional Linear milestone workflow bootstrap (`dev init --with-linear` / `dev repo agents --with-linear`) with repo-local templates
- Managed AGENTS Linear mapping block (`workspace/team/project`) with guided capture on AGENTS write flows
- `dev init` prompt generation is side-effect free by default (`--write-agents` / `--write-skill` opt-in writes)
- Route identity carries app + service names; `dev open` resolves app names directly

Linear execution hygiene (required when using Linear workflow):

1. Set issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

## Onboarding readiness sprint

Goal: stabilize behavior and docs before broader repository onboarding.

Workstream checklist:

- [x] Host-run failure path cleanup: ensure timed-out startup does not leave child process running.
- [x] Dependency policy enforcement: fail fast when host-runtime dependencies are declared (Docker dependencies only in v1 auto-start flow).
- [x] Host-route TLS rendering consistency with current TLS state.
- [x] Documentation polish for first onboarding path and current limitations.
- [x] Add full demo app/config for onboarding rehearsal and smoke tests.
- [~] Add automated tests for the above behavioral guarantees. *(unit tests added for paths.ts + repo-config.ts; integration tests remain)*

## Post-onboarding milestones

## Milestone 1: Vitest + core unit tests (DONE)

- [x] Vitest setup with `vitest.config.ts`
- [x] Unit tests for `paths.ts` — security-critical path traversal guard (10 tests)
- [x] Unit tests for `repo-config.ts` — schema validation, strict unknown-field rejection (25 tests)
- [x] CI updated: `pnpm test` runs in GitHub Actions before build
- [x] 35 tests passing

## Milestone 2: Unit tests for routes.ts (DONE)

Target: `routes.ts` — pure functions, high value, zero infrastructure needed.

- [x] `parseHostsFromRule` — extract hostnames from Traefik rules (9 tests)
- [x] `findDuplicateHosts` — detect hostname collisions (4 tests)
- [x] `resolveRouteByName` — name-based route lookup (9 tests)
- [x] `discoverRoutes` — full route discovery with mock ContainerInfo (14 tests)

Acceptance criteria: all exported pure functions in `routes.ts` covered with edge cases. 36 new tests, 71 total.

## Milestone 3: Integration test foundation (IN PROGRESS)

- [x] `agents-md.ts` — AGENTS.md section writing + skill distribution (FS I/O, temp dirs)
- [ ] `host-routes.ts` — state persistence and file rendering (FS I/O, temp dirs)
- [ ] `doctor.ts` — diagnostic checks with mocked Docker client (stretch)

Acceptance criteria: FS-dependent modules tested with real temp dirs, no Docker required.

## Milestone 4: Protocol and runtime expansion

Acceptance criteria:

- Add MySQL TCP routing support with explicit TLS/SNI requirements.
- Evaluate Redis TCP routing support (separate from `kind: dependency`, which is now supported for non-routed dependency startup).
- Define host runtime TCP strategy (supported scope or explicit non-support).
- Add `dev db` helper for connection snippets.

## Milestone 5: UX and packaging

Acceptance criteria:

- `dev app env <name>` — print resolved dep env vars to stdout (low effort, high utility).
- Add repo bootstrap helper from discovered compose/service metadata to `.devrouter.yml`.
- Add `dev app doctor` diagnostics for common misconfigurations.
- Publish clear install/distribution strategy (local install, global package path, release process).

## Milestone 6: CI hardening

Acceptance criteria:

- CI gates include `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Smoke tests (`pnpm demo:smoke`) require Docker — local-only gate for now.
- Documentation checks ensure command references stay synchronized.

## Known risks

- Postgres multiplexing on one shared `:5432` depends on TLS/SNI-capable clients.
- Host-process detection relies on local `ps`/`lsof`; behavior may differ across environments.

## Decision log

- `.devrouter.yml` is the single source of truth for per-repo routing config.
- Stable CLI surface includes `up/down/status/ls/open/tls`, `repo init/agents`, and `app add/ls/run/exec/rm`.
- `kind=dependency` is a docker-only non-routed app variant for dependency startup/teardown without Traefik route wiring.
- `dev app exec` uses ownership-aware teardown: stop deps it started, leave already-running deps up.
- If exec dependency ownership detection is unavailable, teardown is non-destructive (deps remain running).
- TLS cert coverage is host-aware: defaults include `localhost` + `*.localhost`, configured hosts are auto-added on run/exec when TLS is enabled.
- `dev app exec` preserves argv semantics by default and only uses shell parsing when `--shell` is explicitly requested.
- `startAppDependencies()` is the shared dep-lifecycle helper used by both `run` and `exec`.
- Skill content for agent discoverability is embedded in the CLI bundle (not fetched at runtime) so distributed version always matches installed CLI.
- Agent discoverability writes to both AGENTS.md (idempotent section) and `.factory/skills/` (file copy) — covers human and AI discovery paths.
- `dev init` no longer writes AGENTS/skill by default; writes are explicit via flags.
- TLS remains mandatory for multiplexed Postgres hostname routing on shared `:5432`.
- `80/443/5432` stay reserved for Traefik.

## Future extensions

Potential additions building on the current `exec` + dep env infrastructure:

- `--keep-deps` flag for `dev app exec` — skip stopping deps started by that invocation (useful for running multiple commands in sequence)
- `--env-file <path>` for `dev app exec` — dump resolved env to a file instead of running a command
- `preStart` hooks in `.devrouter.yml` — `hostRun.hooks.preStart: string[]`, sequential shell commands that run after env resolution but before the app/command starts; integration point for secret managers (Infisical, Doppler)
- Configurable DATABASE_URL template — allow overriding fixed `prisma:prisma` credentials per app

## Non-goals (for now)

- Kubernetes support.
- Centralized global repository registry.
- Automatic system DNS mutation without explicit user opt-in.

# CHANGELOG

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Biome pinned to a fixed version for consistent formatting and lint behavior across all environments.
- Knip pinned for stable detection of unused files, unused dependencies, unlisted dependencies, and unresolved imports.
- `pre-commit` hooks covering basic file checks, Biome safe fixes, Knip, and Gitleaks secret scanning. Developers run `pre-commit install` once after cloning to activate them.
- `pnpm check` and `pnpm knip` added as CI gates. Existing CI continues to run `pnpm typecheck`, tests, build, and docs policy.

### Changed

- Repository normalized to Biome formatting and import order throughout. Existing files were reformatted in a single pass to establish a clean baseline.

## [0.0.26] - 2026-07-13

### Added

- `devrouter workspace ensure [path]` now attaches to or starts the exact linked worktree's DevPod, persists one stable workspace identity, validates the compose overlay, Git metadata mount, container environment, devnet aliases, route ownership, HTTP route reachability, and unique running TCP upstream ownership/health, and retries once with `--recreate` when an existing DevPod is stale.
- Managed devcontainer scaffolds now include the default and devrouter compose overlays required for linked-worktree Git access.

### Changed

- Workspace lifecycle operations are serialized per worktree, fail on ambiguous or conflicting identities, and replace routes atomically only after the DevPod runtime proof succeeds.
- `devrouter workspace up` delegates startup and reconciliation to the same fail-closed lifecycle as `workspace ensure`; `--no-devpod` remains a create-only escape hatch.
- New worktrees default to the repository-local `trees/<workspace>` layout used by agent workflows.

### Fixed

- Linked-worktree DevPods no longer report success while mounting an unrelated checkout, missing the host Git common directory, exposing stale devnet aliases, or retaining routes for a failed runtime.
- `devrouter workspace down` no longer inherits unrelated ambient workspace variables and cannot race an in-flight ensure operation for the same worktree.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.26.md

## [0.0.25] - 2026-07-08

### Added
- Outdated CLI version warnings: `loadRepoConfig` automatically prints a warning to `stderr` if the repository's `.devrouter.yml` configuration demands a newer CLI version than the installed/running version.
- Diagnostic check `repo.cli-outdated` in `devrouter doctor` to report whether the installed CLI version is older than the required version.

### Removed
- All Linear milestone workflow CLI parameters, integrations, templates, and markdown files.

### Changed
- Cleaned up stale CLI command references in validation scripts and workspace examples.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.25.md

## [0.0.24] - 2026-07-07

### Added
- Automatic injection of `DEVCONTAINER_COMPOSE_OVERLAY` environment variable to workspace execution contexts when active.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.24.md

## [0.0.23] - 2026-06-28

### Added

- `dev setup --yes --json` for agent-native first-run machine setup. It prepares devrouter-owned state (router files, `devnet`, Traefik, TLS when mkcert exists), reports structured actions/checks/next steps, and refuses mutation unless `--yes` is present.
- `dev repo inspect --json` for read-only repository fact gathering: package manager, scripts and likely ports, compose services, env variable names (values redacted), devcontainer presence, devrouter config, and agent guidance files.
- `dev repo devcontainer write --dry-run --json` and `dev repo devcontainer write --yes` for conservative managed Node/pnpm/Postgres devcontainer scaffolding. Custom existing target files are not overwritten, and non-pnpm repos stop with a structured diagnostic.
- `dev repo devcontainer verify --json` for read-only onboarding evidence, plus `--live --yes --json` for route registration and HTTP probes after the devcontainer is running.
- `examples/routing/` plus `pnpm routing:smoke` for the no-devcontainer devrouter routing example.
- `examples/devcontainer/` plus `pnpm devcontainer:smoke` for a live DevPod/devcontainer app + Postgres showcase.
- `dev doctor` now reports additional machine/devcontainer diagnostics for Docker Compose v2, mkcert, DevPod, Node/pnpm, devnet aliases, published devcontainer ports, and proxy upstream alias matches.

### Changed

- `dev doctor` is now strictly diagnostic for route state: it reports stale host routes and orphaned workspace proxy routes without mutating route files. It exits non-zero when any diagnostic has `level: "error"` while still printing JSON when requested.
- The old root `demo/` fixture is now `examples/routing/`, so all runnable examples live under `examples/`.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.23.md

## [0.0.22] - 2026-06-25

### Added

- **Workspace isolation** for parallel git worktrees / agents. A single "workspace token" now spans three layers with one identity: the devpod workspace id (`devpod up --id <ws>`), the routes devrouter registers, and the `${WORKSPACE}` placeholder in `.devrouter.yml` upstreams + the devcontainer compose network alias. Several worktrees of one repo can run at once without host/route collisions. Token resolution precedence: `--workspace <slug>` flag > `DEVROUTER_WORKSPACE` env var > auto-derived from a linked git worktree branch (sanitized) > none. The primary checkout resolves to no token and routes exactly as before — fully back-compatible.
- When a workspace is active, hosts auto-namespace (`web.localhost` → `web.<ws>.localhost`), `${WORKSPACE}` in an app `upstream` is substituted with the token and re-validated, and the docker `router` key is suffixed per workspace. The runtime config is computed in memory only — the committed `.devrouter.yml` is never rewritten. `${WORKSPACE}` is upstream-only (rejected in `host`). Namespaced hosts get explicit mkcert cert SANs auto-extended when TLS is enabled.
- `dev workspace up <branch> [--path <dir>] [--no-devpod] [--open]`, `dev workspace ls [--json]`, and `dev workspace down <workspace|branch> [--keep-worktree] [--keep-devpod]` manage the worktree+devpod+route lifecycle. `dev app run` / `dev app exec` gain `--workspace <slug>`.
- `examples/workspace/` — a runnable workspace-isolation showcase (`${WORKSPACE}` proxy upstream + `dev workspace up/ls/down` over two real git worktrees). `./run.sh` serves one app at `wsdemo.localhost` and `wsdemo.feat-a.localhost` simultaneously and prints the proof; `./run.sh down` tears it down.
- `dev app rm --keep-config` frees only the live route/hostname and leaves the repo's `.devrouter.yml` app definition untouched. Use it to release a hostname claimed by another repo's route (e.g. an old worktree) without rewriting that repo's committed config. Without the flag, `dev app rm` still removes the app entry and the route as before.

### Fixed

- `dev app run` now leaves `runtime: docker` target services running after startup. Docker runs previously reused the host-app dependency teardown path, so a routed docker app could be stopped immediately after the command reported it was running. The demo config also no longer declares host-process `envMap` aliases on `web-docker`; its container-local database URL belongs in `docker-compose.yml`.
- `dev app add` / `dev app rm` no longer clobber a hand-written `.devrouter.yml`. They previously round-tripped the whole file through the YAML serializer, which stripped every comment, re-sorted `apps` alphabetically, and injected empty `dependencies: []` into each entry — wiping committed notes (e.g. TLS/SNI `sslnegotiation=direct` docs). Edits are now applied surgically to the parsed YAML document: comments and key order are preserved, existing apps keep their position (new apps append at the end, updates replace in place carrying over the comment/blank line above them), and empty `dependencies` is omitted. On an unchanged config an add+rm round-trip is now a no-op diff.

### Changed

- `devcontainer-onboarding` skill: onboarding now adds a *Local development (devcontainer)* section to the target repo's agent-instructions file (`AGENTS.md`/`CLAUDE.md`) from the new `references/AGENTS-devcontainer.md`, so future agents default to the devcontainer path; devrouter routing is folded in as a "when available" layer. Added GOTCHAS #22 (platform-schema-copy repos must run `prisma format` between copy and generate, or `prisma generate`/`db push` fails P1012) with the matching `references/post-create.sh` step.
- `devcontainer-onboarding` skill: added a **multi-app monorepo** variant (one container runs `turbo dev` for N apps; devrouter routes N `*.<proj>.localhost` hosts → that container's N internal ports) with a dedicated SKILL.md section, plus GOTCHAS #23–#27 from onboarding `klicker-uzh`: #23 multi-app single-container routing + shared cookie domain + intra-container SSR; #24 dynamic per-instance service tokens (Hatchet) must mint against the same external DB the engine server uses (all-in-one images point the admin CLI at an unreachable internal DB) and are boot-required (init at module load); #25 audit Turbo `globalEnv`/`passThroughEnv` for every injected var (strict env mode silently strips undeclared ones); #26 pre-build apps whose dev script races (`rollup --watch` ∥ `nodemon`), not just packages; #27 framework env wiring — client/SSR URLs need the full endpoint path and `NODE_ENV=development` gates dev backend behavior; plus an OS note that the mkcert CA mount fallback is macOS-only (set `DEVROUTER_MKCERT_CAROOT` on Linux).
- `devcontainer-onboarding` skill: devcontainer compose templates now publish a `${WORKSPACE}-app` devnet alias (default `WORKSPACE=<project>` in `devcontainer.env`) and the `.devrouter.yml` proxy app uses `upstream: ${WORKSPACE}-app:<port>`, so onboarding lands on the workspace-isolated routing path by default. GOTCHA #19 (hostname-steal between worktrees) is reframed around `dev workspace` since namespaced hosts no longer collide.
- `dev doctor` reclaims orphaned workspace proxy routes whose worktree directory was removed without `dev workspace down` (check `routes.orphaned-workspace-routes`). It uses worktree existence as the orphan signal — never container/alias liveness — so stable primary-checkout routes whose devcontainer is merely stopped are never torn down.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.22.md

## [0.0.21] - 2026-06-14

### Added

- `runtime: proxy` now supports `protocol: tcp` (with `tcpProtocol`): registers a Traefik TCP route that SNI-routes `HostSNI(<host>)` on the shared protocol entrypoint (e.g. `:5432`) to the upstream — for fronting a database in an externally-managed container (e.g. a devcontainer's Postgres on `devnet`) with a stable `db.*.localhost`, no per-DB host port. Pairs with the existing HTTP proxy so N apps + their DBs route through devrouter with zero host-port collisions.
- TCP proxy routes require TLS (`dev tls install`): SNI is read from the TLS ClientHello. Postgres clients must use direct-SSL negotiation (`sslmode=require sslnegotiation=direct`, libpq 17+) so an immediate ClientHello carries the SNI. devrouter emits a per-protocol Traefik `TLSOption` advertising ALPN `postgresql` (libpq direct-SSL mandates the server negotiate it), and `dev app run` auto-extends the mkcert cert to cover the new host.
- `dev app add --runtime proxy --protocol tcp --tcp-protocol <postgres|redis|...> --upstream <host:port>` scaffolds a TCP proxy app.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.21.md

## [0.0.20] - 2026-06-13

### Added

- New app runtime `runtime: proxy`: registers a Traefik HTTP route to an already-running `upstream` (`host:port`) with no lifecycle, env injection, `hostRun`, compose ownership, or dependencies. Use it to put a stable `*.localhost` HTTPS host in front of a devcontainer or any externally-managed process, making devrouter compose-runner-agnostic.
- `dev app add --runtime proxy --upstream <host:port>` for creating proxy apps. New `upstream` field in the `.devrouter.yml` app schema (proxy apps only).
- Loopback upstreams (`localhost`/`127.0.0.1`/`0.0.0.0`) are rewritten to `host.docker.internal` so Traefik (in Docker) can reach a port published on the host.
- Proxy routes are written once by `dev app run` and persist until `dev app rm` (no process is started, re-running is idempotent). They are never treated as stale by `dev doctor` / eviction since they have no backing PID.

### Fixed

- HTTP-only (TLS-disabled) routing no longer 404s on Traefik v2.11. The generated `base.yml` previously emitted empty standalone maps (`http: {}` / `tls: {}`) which Traefik v2.11 rejects ("cannot be a standalone element"), failing the entire file provider so host/proxy routes never loaded. With TLS off, `base.yml` is now an empty (comment-only) file. The TLS-enabled path was unaffected.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.20.md

## [0.0.19] - 2026-03-07

### Fixed

- Dependency env vars (`{PREFIX}_HOST`, `_PORT`, `_URL`, etc.) and `envMap` aliases are now correctly injected even when dependency containers are already running. Previously, skipping the "start dependencies?" prompt also skipped overlay generation and port probing, resulting in missing env vars.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.19.md

## [0.0.18] - 2026-03-07

### Added

- Secret manager environment override: `secretManager.command` now supports `{env}` template placeholder resolved at runtime. New optional `secretManager.defaultEnv` config field provides the fallback value; new `--env <env>` CLI flag on `dev app run` and `dev app exec` overrides it. Enables switching SM environments (dev/stg/prd) without separate scripts.
- Per-dep deterministic env vars: TCP deps now get unique vars based on `{PREFIX} = dep.name.toUpperCase().replace(/-/g, "_")`: `{PREFIX}_HOST`, `{PREFIX}_PORT`, `{PREFIX}_URL` (protocol-specific), `{PREFIX}_SHADOW_URL` (postgres only). Multiple deps of the same protocol no longer collide.
- Config-level `envMap` on dependency references in `.devrouter.yml`: alias per-dep vars to project-specific names (e.g. `DATABASE_URL: DB_URL`). Applied after dep var resolution, flows through SM re-injection automatically.
- URL builders for redis (`redis://localhost:{PORT}`), mysql/mariadb (`mysql://root@localhost:{PORT}`).
- Concurrent run guard for `dev app run`: host apps with a live PID in `host-routes-state.json` are rejected with the existing URL, PID, and repo path. Stale entries (dead PID) are evicted silently.
- Hostname conflict detection: starting a host app whose hostname is already claimed by a different live app throws `HostnameConflictError`.
- `dev doctor` now includes `routes.stale-host-routes` check that evicts dead-PID entries from host route state.
- New module `src/core/concurrency.ts` with `assertAppNotRunning()` and `evictStaleHostRoutes()`.

### Breaking

- **Removed shared hardcoded env vars**: `DATABASE_URL`, `DIRECT_URL`, and `SHADOW_DATABASE_URL` are no longer auto-injected for postgres deps. Use per-dep vars (`DB_URL`, `DB_SHADOW_URL`) directly or add `envMap` entries to get legacy names.
- **Removed `--env-map` CLI flag**: env var aliasing is now config-only via `envMap` on dependency references in `.devrouter.yml`.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.18.md

## [0.0.17] - 2026-03-05

### Added

- Generic TCP routing: `tcpProtocol` now supports `postgres`, `redis`, `mariadb`, and `mysql`. New protocols are validated against `TCP_PROTOCOL_REGISTRY`.
- Dynamic TCP port binding: Traefik entrypoints and port mappings are only created when a TCP protocol is first used (`dev app run` / `dev app exec`). Ports are released on `dev down`.
- Active TCP protocol state tracked in `~/.config/devrouter/active-tcp-protocols.json`.
- Redis service added to the routing example (`examples/routing/docker-compose.yml`, `examples/routing/.devrouter.yml`).

### Changed

- `RouterStatus.boundPorts` now uses dynamic `tcp: Record<string, boolean>` instead of hardcoded `postgres5432`.
- `DevrouterDockerPostgresApp` type renamed to `DevrouterDockerTcpApp` with `tcpProtocol: string`.
- Route protocol display is now `tcp/<protocol>` (e.g., `tcp/redis`) instead of always `tcp/postgres`.
- Postgres-specific env injection (`DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL`) only applies when `tcpProtocol === "postgres"`. Generic `NAME_HOST`/`NAME_PORT` injected for all TCP protocols.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.17.md

## [0.0.16] - 2026-03-02

### Added

- Secret manager integration via optional `secretManager.command` in `.devrouter.yml`. When configured, `dev app run` and `dev app exec` wrap user commands with the SM command and re-apply devrouter-injected dependency env vars (`DATABASE_URL`, `DIRECT_URL`, `SHADOW_DATABASE_URL`, `*_HOST`, `*_PORT`) after the SM boundary via `env KEY=VAL` prefix. Env-map targets are also included in the re-injection set.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.16.md

## [0.0.15] - 2026-03-02

### Added

- Postgres dependency env injection now includes `DIRECT_URL` (equals `DATABASE_URL`). Enables Prisma + PgBouncer setups where `DIRECT_URL` bypasses the pooler for migrations.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.15.md

## [0.0.14] - 2026-02-15

### Changed

- `dev -V` now prints:
  - installed CLI version
  - local repository version from `.devrouter.yml` (`devrouter.version`)
  - next available upgrade target (if any)
- Upgrade guidance in distributed devrouter skills/AGENTS content now points agents to `dev upgrade` instead of manual changelog scanning first.

### Added

- New command: `dev upgrade [version] [--repo <path>]`.
  - `dev upgrade` lists available upgrade targets newer than the local `.devrouter.yml` `devrouter.version` and marks the next one.
  - `dev upgrade <version>` prints the target release's Agent Adaptation Prompt and then reports if a further version is available.
- New core upgrade parser/runtime:
  - reads local version metadata from `.devrouter.yml` (`devrouter.version`)
  - loads release prompts from `upgrade-prompts/<version>.md`
  - resolves semver-ordered target chains for agent-friendly incremental upgrades.
- Package distribution now includes `upgrade-prompts/` so release prompts are available to installed CLI flows.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.14.md

## [0.0.13] - 2026-02-15

### Changed

- Added first-class dependency-only Docker app entries via `kind: dependency` in `.devrouter.yml`.
  - These entries are Docker-only and non-routed.
  - They are started/stopped through dependency lifecycle flows only.
- `dev app run`, `dev app exec`, and `dev open` now reject direct targets configured with `kind: dependency` and provide guidance to use a routed parent app.
- Docker overlay generation now keeps `kind: dependency` services as compose-as-is (no Traefik labels, no random port publishing, no injected dependency env vars).
- CLI `dev app add` now supports `--kind app|dependency` (default `app`) and validates mode-specific flags.

### Added

- New `.devrouter.yml` app variant:
  - `kind: dependency`
  - `runtime: docker`
  - `docker.service`, `docker.composeFiles`
- New schema/behavior tests:
  - dependency-kind config acceptance/rejection coverage in `repo-config.test.ts`
  - dependency-only exec lifecycle + direct-target guardrails in `app-run-exec.test.ts`
  - dependency-only `dev open` guidance coverage in `open.test.ts`
  - onboarding/skill text coverage for dependency-kind schema in `ai-prompt.test.ts` and `agents-md.test.ts`

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.13.md

## [0.0.12] - 2026-02-15

### Changed

- TLS certificate refresh now preserves previously issued DNS SAN entries while always retaining default SANs (`localhost`, `*.localhost`).
- `dev app run` and `dev app exec` now auto-refresh TLS cert SAN coverage for configured repo hosts when TLS is already enabled.
- Runtime commands now fail fast with actionable guidance if automatic TLS cert refresh fails (`Run: dev tls install`).

### Added

- New `dev doctor` repo diagnostic check: `repo.tls-host-coverage`.
  - Scope: valid repo config with TLS enabled.
  - Warns when configured `.localhost` hosts are not covered by current TLS cert SANs.
  - Suggests remediation via runtime auto-refresh (`dev app run <name> --repo <repo> --yes`) or manual refresh (`dev tls install`).
- New TLS unit tests for SAN parsing, wildcard coverage semantics, uncovered-host detection, and SAN-preservation merge behavior.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.12.md

## [0.0.11] - 2026-02-15

### Changed

- `dev app exec` teardown is now ownership-aware.
  - Before starting dependencies, devrouter checks which selected dependency services are already running.
  - After command exit, devrouter stops only services started by that `dev app exec` invocation.
  - Services already running before `dev app exec` are left running.
- If ownership detection cannot be determined (`docker compose ps` failure), `dev app exec` uses non-destructive cleanup and leaves selected dependencies running.

### Added

- New compose introspection helper: `queryRunningComposeServices()` in `src/core/docker-run.ts`.
- New exec lifecycle tests for dependency ownership behavior:
  - already-running dependency is not stopped
  - newly started dependency is stopped
  - mixed running/new services stop only the newly started subset
  - ownership-unknown preflight leaves deps running and emits a warning

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.11.md

## [0.0.10] - 2026-02-15

### Changed

- Secret-manager interop guidance now explicitly documents wrapper precedence hazards for host-run commands (`DATABASE_URI=... <wrapper> run -- ...`).
- AI onboarding prompt and distributed devrouter skill guidance now include a safe host-run pattern that applies DB overrides after wrapper boundary (`... run -- env DATABASE_URI=...`).
- Product docs now document the `dev doctor` wrapper-precedence check and remediation flow.

### Added

- New `dev doctor` repo diagnostic check: `repo.host-command-env-precedence`.
  - Scope: host apps with transitive postgres dependencies.
  - Warns when `DATABASE_URI` or `DATABASE_URL` appears before a `run --` wrapper boundary in `hostRun.command`.
  - Suggests moving assignment after wrapper boundary and validating with an env probe.
- Unit tests for risky vs safe host command wrapper precedence behavior in `doctor.test.ts`.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.10.md

## [0.0.9] - 2026-02-15

### Changed

- `dev init --with-linear --write-agents` now collects minimal Linear mapping basics (workspace, team, project) and stores them in a managed AGENTS metadata block.
- `dev repo agents --with-linear` now uses the same guided metadata capture behavior when writing AGENTS artifacts.
- `dev init --with-linear` (without write flags) remains non-mutating and now includes explicit guided Linear mapping questions in the generated onboarding prompt.
- Linear workflow skill guidance is simplified to resolve repository-specific mapping from AGENTS metadata first, not hardcoded assumptions.
- Linear workflow guidance now requires ongoing Linear issue hygiene: status transitions during work, checkpoint progress comments, and end-of-session recap/status verification.

### Added

- Managed Linear metadata block in `AGENTS.md`:
  - `<!-- devrouter-linear-workflow-config:start -->`
  - `<!-- devrouter-linear-workflow-config:end -->`
- Stored fields:
  - `linear.workspace.name` (required)
  - `linear.team.name` (required)
  - `linear.team.key` (optional)
  - `linear.project.name` (required)
  - `linear.project.id` (optional)
  - `linear.updated_at`
  - `linear.capture_mode` (`interactive` or `placeholder`)
- Non-interactive fallback for AGENTS write flows: placeholders are written and a warning is printed.
- Unit tests for guided metadata capture, placeholder fallback, managed block replacement, and prompt updates.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.9.md

## [0.0.8] - 2026-02-15

### Changed

- `dev init` now accepts `--with-linear` to include optional Linear milestone workflow guidance in the generated onboarding prompt.
- `dev repo agents` now accepts `--with-linear` to install optional Linear workflow assets alongside the devrouter skill/AGENTS section.
- Documentation now includes optional Linear bootstrap flows while keeping product docs current-state and adaptation details in this changelog.

### Added

- New distributed skill: `.factory/skills/linear-workflow/SKILL.md`.
- New distributed reference templates:
  - `.factory/skills/linear-workflow/references/LINEAR_ISSUE_TEMPLATE.md`
  - `.factory/skills/linear-workflow/references/MILESTONE_PLAN_TEMPLATE.md`
  - `.factory/skills/linear-workflow/references/PROGRESS_UPDATE_TEMPLATE.md`
- New idempotent AGENTS section sentinel for Linear workflow policy: `<!-- devrouter-linear-workflow -->`.
- Unit tests covering:
  - `dev init --with-linear` non-mutating default and write behavior
  - `dev repo agents --with-linear` artifact creation behavior
  - `agents-md` linear section/file idempotency and path outputs
  - `dev init` prompt Linear section toggling via `withLinear`

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.8.md

## [0.0.7] - 2026-02-14

### Changed

- `dev app exec` now preserves argv semantics by default (`shell: false`) instead of flattening command parts into one shell string.
- `dev app exec` now supports explicit shell parsing via `--shell` and requires exactly one command string after `--`.
- `dev init` onboarding prompt now includes a dedicated Secret Manager Interop section (Infisical/Doppler), deterministic `DATABASE_URI <- DATABASE_URL` mapping guidance, and explicit env-probe checks before migrate/seed.
- Product docs now document current preferred one-shot forms for secret-manager-wrapped commands and include a brief compatibility note for pre-`0.0.7` parsing behavior.

### Added

- `dev app exec --env-map TARGET=SOURCE` (repeatable) to copy env values after dependency env resolution and before process spawn.
- Unit tests for argv-safe exec behavior, `--shell` guardrails, env-map behavior, spawn error handling, and secret-manager coexistence flow.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.7.md

## [0.0.6] - 2026-02-14

### Changed

- `dev init` is non-mutating by default. It now prints onboarding prompt text only unless explicit write flags are passed.
- `dev open <name>` now resolves by configured app name first, then service/container/host identities.
- `dev ls` human output now includes both `APP` and `SERVICE` columns, and route JSON includes `appName`.
- `dev doctor` now reports advisory warnings when postgres docker service credentials differ from devrouter's injected defaults (`prisma/prisma/prisma`).
- Demo configuration now aligns with postgres defaults used by injected dependency environment values.

### Added

- `dev init --write-agents` and `dev init --write-skill` for explicit artifact writes.
- `CHANGELOG.md` as the release/adaptation source of truth.
- Policy: upgrade/adaptation instructions are maintained here, while docs track current behavior only.

### Fixed

- Docker disk-full (`no space left on device`) error messaging now uses non-destructive guidance only.
- Demo now uses a host command that relies on injected dependency env instead of hardcoded `DATABASE_URL`.

### Agent Adaptation Prompt

Agent adaptation prompt: ./upgrade-prompts/0.0.6.md

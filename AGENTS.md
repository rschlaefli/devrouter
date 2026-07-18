# AGENTS.md

Guidance for agentic coders working in this repository.

## Setup docs

- [`docs/README.md`](./docs/README.md) (documentation map)
- [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md)
- [`docs/DEVCONTAINER.md`](./docs/DEVCONTAINER.md) (preferred: front a devcontainer via `runtime: proxy`)
- [`docs/REPO_ONBOARDING.md`](./docs/REPO_ONBOARDING.md)
- [`examples/routing/README.md`](./examples/routing/README.md)
- [`examples/devcontainer/README.md`](./examples/devcontainer/README.md)
- [`examples/workspace/README.md`](./examples/workspace/README.md)
- [`docs/project/index.md`](./docs/project/index.md) (dated active and delivered project records)
- [`docs/solutions/`](./docs/solutions/) (incident-derived lessons and prevention guidance)
- [`CHANGELOG.md`](./CHANGELOG.md)

## Documentation sync requirement

Keep these docs up to date with any behavior, command, schema, or onboarding workflow changes:

1. `README.md`
2. `AGENTS.md`
3. `docs/GETTING_STARTED.md`
4. `docs/DEVCONTAINER.md`
5. `docs/REPO_ONBOARDING.md`
6. `docs/README.md`
7. `examples/routing/README.md`
8. `examples/devcontainer/README.md`
9. `examples/workspace/README.md`
10. `CHANGELOG.md`
11. `upgrade-prompts/*.md`

## Documentation policy

1. Product manuals (`README.md`, `docs/GETTING_STARTED.md`, `docs/REPO_ONBOARDING.md`, `docs/DEVCONTAINER.md`, and `examples/*/README.md`) and active knowledge must describe current state only.
2. `docs/project/**`, `docs/adr/**`, and `docs/solutions/**` are status-labelled records and may retain historical context.
3. Upgrade/migration/adaptation instructions belong only in `CHANGELOG.md` and `upgrade-prompts/*.md`.
4. Each release section in `CHANGELOG.md` must reference exactly one prompt file under `upgrade-prompts/<version>.md`.



## Current product model

`devrouter` now uses one per-repo config file:

- `.devrouter.yml`

Upgrade metadata for agent workflows is stored per repo in:

- `.devrouter.yml` (`devrouter.version` for `devrouter -V` / `devrouter upgrade`)

Supported routing:

- HTTP host-run apps
- HTTP docker apps
- HTTP proxy apps (`runtime: proxy`) — route to an already-running `upstream` (`host:port`); for a managed devcontainer, `ensure` also supplies the process helper and invokes the repository adapter before readiness. `upstream` may use the `${WORKSPACE}` token (substituted at runtime; rejected in `host`).
- TCP apps on shared protocol ports with TLS/SNI (`runtime: docker` or `runtime: proxy`; supported `tcpProtocol`: `postgres`, `redis`, `mariadb`, `mysql`)
- Dependency-only docker services (`kind: dependency`, non-routed)
- Workspace isolation: each managed linked worktree has a local Git token plus a durable owner record in the repository's Git common directory. First use reuses an exact-path DevPod or derives a sanitized branch/path identity; later overrides may repeat but never rename it. When active, hosts auto-namespace (`web.localhost` → `web.<ws>.localhost`) and `${WORKSPACE}` upstreams substitute; managed `ensure` requires every HTTP/TCP proxy upstream to remain in that exact alias namespace. The committed `.devrouter.yml` is never rewritten (runtime config is in-memory).
- Managed lifecycle: use devrouter commands rather than raw DevPod mutations. A machine-global provider lock revalidates exact ID/path ownership around each action; managed-process reuse includes exact adapter bytes and allowlisted non-secret runtime identity; published route metadata and Traefik rendering share one canonical artifact.

## Supported command surface

- `devrouter init` (`--write-agents` / `--write-skill` optional; non-mutating by default)
- `devrouter -V` (`--repo <path>` optional; shows installed CLI version, local repo version, next upgrade target)
- `devrouter upgrade` (`[version]`, `--repo <path>` optional; lists targets or prints target adaptation prompt)
- `devrouter setup` (`--yes`, `--json`, `--repo <path>` optional; first-run machine setup plus structured diagnostics)
- `devrouter up`, `devrouter down`, `devrouter status`, `devrouter doctor` (alias: `devrouter verify`), `devrouter ls`, `devrouter open`, `devrouter logs`, `devrouter tls install`
- `devrouter ensure` (`[path]`, `--open`, `--json`), `devrouter stop` (`[path]`, `--delete`, `--json`), `devrouter exec` (`[path] -- <command...>`)
- `devrouter repo init`, `devrouter repo inspect` (`--json`), `devrouter repo devcontainer write` (`--dry-run`, `--yes`, `--json`), `devrouter repo devcontainer verify` (`--live`, `--yes`, `--json`), `devrouter repo agents`
- `devrouter app add` (`--kind app|dependency`), `devrouter app ls`, `devrouter app run` (`--env`, `--workspace`), `devrouter app exec` (`--shell`, `--env`, `--workspace`), `devrouter app rm` (`--keep-config`)
- `devrouter workspace up` (`<branch>`, `--path`, `--no-devpod`, `--open`), `devrouter workspace ensure` (`[path]`, `--open`, `--json`, compatibility alias), `devrouter workspace ls` (`--json`), `devrouter workspace stop` (`<workspace|branch>`), `devrouter workspace down` (`<workspace|branch>`, `--keep-worktree`), `devrouter workspace gc` (`--json`, `--yes`)

## Repository map

- `src/cli.ts`: command registration (lazy-loaded handlers)
- `src/core/ai-prompt.ts`: canonical AI onboarding prompt template + command intents
- `src/core/upgrade.ts`: repo version metadata + `upgrade-prompts/*.md` resolution for upgrade flows
- `src/core/agents-md.ts`: idempotent AGENTS.md section writer + skill file distributor for repo discoverability
- `src/commands/repo-agents.ts`: `devrouter repo agents` command handler
- `src/commands/repo-inspect.ts`: `devrouter repo inspect` command handler
- `src/commands/repo-devcontainer.ts`: `devrouter repo devcontainer write/verify` command handlers
- `src/core/devcontainer-verify.ts`: devcontainer onboarding verification report builder
- `src/commands/upgrade.ts`: `devrouter upgrade` command handler
- `src/commands/version.ts`: `devrouter -V` version summary command handler
- `src/commands/setup.ts`: `devrouter setup` command handler
- `src/core/doctor.ts`: diagnostic report engine for global + repo checks
- `src/core/setup.ts`: first-run setup orchestration for devrouter-owned machine state
- `src/core/tool-diagnostics.ts`: shared external-tool checks for Docker Compose, mkcert, DevPod, and Node/pnpm
- `src/core/devcontainer-diagnostics.ts`: static devcontainer alias/port/upstream checks used by doctor
- `src/core/repo-inspect.ts`: read-only repo stack inspector for agent onboarding facts
- `src/core/devcontainer-write.ts`: conservative devcontainer scaffold planner/writer
- `src/core/status.ts`: status collection + readiness insights
- `src/core/docker-error-guidance.ts`: shared Docker failure message enrichment (including disk-space guidance)
- `src/core/repo-config.ts`: `.devrouter.yml` schema + strict validation; workspace runtime config (`loadRuntimeConfig()`, `applyWorkspace()`, `namespaceHost()`, `${WORKSPACE}` upstream substitution)
- `src/core/workspace.ts`: workspace token resolution (`resolveWorkspace()`, `wsFromBranch()`, linked-worktree detection)
- `src/core/workspace-lifecycle.ts`: `devrouter workspace up/ls/stop/down` engine (worktree creation, reversible stop, fail-closed teardown, lifecycle locking)
- `src/core/workspace-ownership.ts`: durable Git-common-dir owner records and live Git/DevPod ownership classification
- `src/core/workspace-gc.ts`: dry-run-first cleanup for exact ledger-owned missing workspaces
- `src/core/devpod-mutation.ts`: machine-global serialization boundary for ownership-proven DevPod provider mutations
- `src/core/workspace-ensure.ts`: fail-closed `workspace ensure` engine (exact-path DevPod discovery/start, runtime proof, atomic route reconciliation)
- `src/core/managed-post-start.ts`: managed-adapter migration guard plus runtime-only process-helper delivery and invocation in the exact validated container
- `src/core/environment-stop.ts`: non-destructive exact-checkout stop lifecycle
- `src/core/devpod-exec.ts`: locked, exact-path one-shot DevPod execution
- `src/commands/workspace.ts`: `devrouter workspace` command handlers
- `src/core/concurrency.ts`: concurrent run guard (`assertAppNotRunning`) + stale route eviction (`evictStaleHostRoutes` for dead PIDs; `evictOrphanedWorkspaceRoutes` for removed-worktree proxy routes)
- `src/core/app-run.ts`: runtime orchestration, `startAppDependencies()` helper, `runConfiguredApp()`, `execWithAppEnv()`
- `src/core/docker-run.ts`: cached compose overlay generation, compose up, `queryMappedPort()`, `queryRunningComposeServices()` (routed apps get Traefik labels; `kind=dependency` services are left as-is)
- `src/commands/app-exec.ts`: `devrouter app exec` command handler
- `src/core/routes.ts`: discover HTTP + TCP routes from labels
- `src/core/router.ts`: shared Traefik stack/files under `~/.config/devrouter`
- `src/core/host-routes.ts`: locked host-route state, versioned canonical Traefik metadata/rendering, durable atomic publication, and compatibility recovery
- `src/core/paths.ts`: path traversal guard (`assertPathWithinRepo`) for repo-scoped file references
- `src/core/tls.ts`: mkcert integration, SAN coverage checks, and TLS enablement/refresh
- `src/commands/logs.ts`: `devrouter logs` command handler (Traefik log access)
- `src/core/output.ts`: human table + JSON output
- `src/types.ts`: shared types
- `examples/routing/.devrouter.yml`: complete sample config for host+docker+postgres routing
- `examples/workspace/`: runnable workspace-isolation showcase (`${WORKSPACE}` proxy upstream + workspace lifecycle over two real git worktrees; `run.sh` brings up two namespaced hosts and prints the proof)
- `examples/devcontainer/`: live DevPod/devcontainer showcase with app + Postgres proxy routes and static/live verify evidence
- `scripts/smoke-routing.sh`: end-to-end routing smoke script
- `scripts/smoke-devcontainer.sh`: live DevPod/devcontainer smoke script
- `scripts/check-docs-policy.sh`: docs-policy guard for product-doc drift and changelog prompt reference integrity
- `upgrade-prompts/*.md`: versioned agent adaptation prompts consumed by `devrouter upgrade`
- `.agents/skills/devrouter/SKILL.md`: bundled skill (reference copy; embedded in CLI for distribution)
- `.agents/skills/devcontainer-onboarding/SKILL.md`: skill for agents onboarding a repo to a self-contained devcontainer + proxy-only routing (`GOTCHAS.md`, `REFERENCE.md`, `references/*` templates)
- `src/core/__tests__/paths.test.ts`: unit tests for path traversal guard
- `src/core/__tests__/repo-config.test.ts`: unit tests for `.devrouter.yml` schema validation
- `src/core/__tests__/routes.test.ts`: unit tests for route discovery and resolution
- `src/core/__tests__/ai-prompt.test.ts`: unit tests for onboarding prompt/schema consistency
- `src/core/__tests__/agents-md.test.ts`: unit tests for AGENTS/skill file writers
- `src/core/__tests__/workspace.test.ts`: unit tests for workspace token resolution + worktree detection
- `src/core/__tests__/workspace-lifecycle.test.ts`: unit tests for `devrouter workspace up/ls/stop/down` orchestration (identity persistence, create-only mode, serialized fail-closed teardown)
- `src/core/__tests__/workspace-ownership.test.ts`: unit tests for owner records and `present`/`missing`/`locked`/`conflict` classification
- `src/core/__tests__/workspace-gc.test.ts`: unit tests for dry-run and exact-evidence garbage collection
- `src/core/__tests__/workspace-ensure.test.ts`: unit tests for exact-path DevPod ownership, one-time recreate, proof failures, and route replacement
- `src/core/__tests__/doctor.test.ts`: unit tests for diagnostics (TLS, Postgres credential checks, host-command wrapper precedence, TLS host coverage)
- `src/core/__tests__/docker-error-guidance.test.ts`: unit tests for disk-space remediation messaging
- `src/core/__tests__/app-run-exec.test.ts`: unit tests for argv-safe `devrouter app exec`, shell mode guard, per-dep env vars, config-level envMap, exec dependency ownership teardown, and SM `{env}` template resolution
- `src/core/__tests__/tls.test.ts`: unit tests for TLS SAN parsing, wildcard coverage, and host preservation logic
- `src/commands/__tests__/init.test.ts`: unit tests for `devrouter init` side-effect contract
- `src/commands/__tests__/open.test.ts`: unit tests for `devrouter open` app-name fallback behavior
- `src/commands/__tests__/repo-init.test.ts`: unit tests for `devrouter repo init` metadata initialization behavior
- `src/commands/__tests__/repo-agents.test.ts`: unit tests for `devrouter repo agents` behavior
- `src/commands/__tests__/upgrade.test.ts`: unit tests for `devrouter upgrade` and `devrouter -V`
- `src/core/__tests__/upgrade.test.ts`: unit tests for version metadata + prompt-file parsing
- `vitest.config.ts`: Vitest configuration
- `biome.json`: formatting, linting, and import-order configuration
- `knip.json`: unused file/dependency and unresolved import checks
- `.pre-commit-config.yaml`: local Biome, Knip, Gitleaks, and basic file guards

## Non-negotiable constraints

1. Router/global artifacts must remain under `~/.config/devrouter`.
2. `.devrouter.yml` is the only supported repo config for new flows.
3. No global repo registry.
4. Keep `.localhost` as hostname convention.
5. Keep Traefik ownership of `80/443/5432`.
6. Postgres TCP hostname multiplexing remains TLS-required.

## Security constraints

1. `.devrouter.yml` paths (`composeFiles`, `hostRun.cwd`) must not escape repo root — enforced by `assertPathWithinRepo` in `src/core/paths.ts`.
2. Hostnames must match `VALID_HOSTNAME_RE` (lowercase alphanumeric + hyphens + `.localhost` suffix). No underscores. Namespaced hosts (`web.<ws>.localhost`) are produced by inserting the sanitized token label; `${WORKSPACE}` is rejected in `host` (only allowed in `upstream`).
3. Dependency graphs are validated for cycles at resolution time (`resolveAppDependencies`).
4. `shell:true` in host-run spawn is intentional (same trust model as npm scripts / docker-compose). Command length capped at 4096 chars.
5. Workspace tokens are sanitized via `wsFromBranch()` (lowercase, non-alphanumeric → `-`, capped at 32 chars) before use in hostnames/aliases. `devrouter workspace` spawns git/devpod argv-safe (no shell-string interpolation of branch/token).

## Architecture patterns

- **Command pattern**: thin `src/commands/*.ts` handler imports a core function from `src/core/*.ts`. Keep handlers minimal.
- **Dep lifecycle**: `startAppDependencies()` in `app-run.ts` is the reusable helper for starting deps, resolving env vars, and returning a `stopDeps()` cleanup. `devrouter app run` stops auto-started docker deps when a host app exits, but docker app targets remain running until explicit cleanup; `devrouter app exec` uses ownership-aware teardown (stop only deps started by that exec call) and falls back to non-destructive cleanup if ownership detection is unavailable. Any new command needing resolved dep env should call this.
- **Port mapping**: `queryMappedPort()` in `docker-run.ts` calls `docker compose port` to discover random host ports. `prepareDockerOverlay()` accepts `publishTcpPorts` to auto-publish `0:<internalPort>` for TCP deps.
- **Dependency-only apps**: `kind=dependency` entries are Docker-only and do not expose routes; they can be auto-started/stopped only through dependency graphs (not direct `run`/`exec`/`open` targets).
- **Env injection**: TCP deps get per-dep deterministic vars: `{PREFIX}_HOST`/`_PORT`/`_URL`/`_SHADOW_URL` (where `{PREFIX} = dep.name.toUpperCase().replace(/-/g, "_")`). Protocol-specific URLs: postgres (`postgres://prisma:prisma@...`), redis (`redis://...`), mysql/mariadb (`mysql://root@...`). Config-level `envMap` on dependency references aliases these to project-specific names (e.g. `DATABASE_URL: DB_URL`). Aliases are applied in `startAppDependencies()` and become part of `depEnv` — they flow through SM re-injection and `buildExecEnvironment()` automatically.
- **Workspace runtime config**: `loadRuntimeConfig(repoPath, workspaceOverride?)` resolves the workspace token (`resolveWorkspace`) and returns `applyWorkspace(config, ws)` — a deep-cloned, in-memory config with namespaced hosts, `${WORKSPACE}` upstreams substituted (re-validated), and per-workspace docker `router` keys. The committed `.devrouter.yml` is never rewritten. All read paths (`status`, `doctor`, `open`, `app-run`) load through this; the resolved workspace threads down to `upsertHostRoute` as `HostRouteState.workspace` so teardown/GC can filter by tag without re-reading config.
- **Environment lifecycle**: run one-time `setup`, then use `ensure <path>` for both primary and linked checkouts; never branch manually on checkout kind or use live verify as startup. Managed consumer images contain no devrouter artifact: after exact-container proof, `ensure` delivers its matching helper to a runtime-only path and invokes the repository-owned adapter before atomically replacing routes. `stop <path>` is non-destructive, and `exec <path> -- <command...>` runs only in an already-running exact DevPod. `workspace up` creates linked worktrees; destructive `workspace down/gc` remains ledger-scoped and never targets the primary checkout.
- **Workspace cleanup**: `workspace ls` reports owner status as `present`, `missing`, `locked`, or `conflict`. `workspace gc` is a non-mutating report by default; `--yes` deletes only exact ledger-owned missing/prunable DevPods and routes, then their records, and never mutates Git worktrees, branches, or prune state. Git has no worktree-removal hook, so doctor reports missing/conflicting ownership and points to `workspace gc --repo <repo>`.

- **Secret-manager precedence diagnostics**: `devrouter doctor` emits `repo.host-command-env-precedence` for host apps with postgres deps when `DATABASE_URI`/`DATABASE_URL` is assigned before a `run --` wrapper boundary.
- **TLS host coverage**: `startAppDependencies()` in `app-run.ts` calls TLS coverage refresh for all configured repo hosts when TLS is enabled. `devrouter doctor` emits `repo.tls-host-coverage` when configured hosts are not covered by current cert SANs.
- **SM env override**: `secretManager.command` supports `{env}` template placeholders resolved by `resolveSmCommand()` in `app-run.ts`. `defaultEnv` provides the config-level fallback; `--env` CLI flag overrides at runtime. Resolution happens at usage sites in `execWithAppEnv` and `runHostApp` before passing to `wrapWithSecretManager`.

## Release checklist

1. Commit all implementation changes (fix/feature commits first, separate from release commit).
2. Bump `version` in `package.json` to `0.0.X`.
3. Bump `devrouter.version` in `examples/routing/.devrouter.yml` and `examples/devcontainer/.devrouter.yml` to `0.0.X`.
4. Add `[0.0.X]` section in `CHANGELOG.md` between `[Unreleased]` and previous release. Include `### Agent Adaptation Prompt` referencing `./upgrade-prompts/0.0.X.md`.
5. Create `upgrade-prompts/0.0.X.md` with: changes summary, task (bump version, schema migration if any, refresh artifacts), validation steps, report template.
6. Update `.agents/skills/devrouter/SKILL.md` and `src/core/ai-prompt.ts` to reflect any schema, env injection, CLI flag, or config changes in this release. Run `ai-prompt.test.ts` to verify consistency.
7. Run validation checklist (below).
8. Commit all release artifacts in a single commit: `Release 0.0.X -- <summary>`.

## Validation checklist

1. `pnpm check:docs-policy`
2. `pnpm check`
3. `pnpm knip`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm build`
7. `devrouter setup --repo ./examples/routing --yes --json`
8. `devrouter doctor --repo ./examples/routing`
9. `devrouter repo inspect --repo ./examples/routing --json`
10. `pnpm routing:smoke` for full route showcase/regression smoke
11. `pnpm devcontainer:smoke` when DevPod is available for live devcontainer verification
12. `pnpm devcontainer:smoke down` after live devcontainer verification
13. Update docs for any behavior/surface changes

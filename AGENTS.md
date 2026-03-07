# AGENTS.md

Guidance for agentic coders working in this repository.

## Setup docs

- [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md)
- [`docs/REPO_ONBOARDING.md`](./docs/REPO_ONBOARDING.md)
- [`demo/README.md`](./demo/README.md)
- [`docs/PLAN.md`](./docs/PLAN.md)
- [`CHANGELOG.md`](./CHANGELOG.md)

## Documentation sync requirement

Keep these docs up to date with any behavior, command, schema, or onboarding workflow changes:

1. `README.md`
2. `AGENTS.md`
3. `docs/GETTING_STARTED.md`
4. `docs/REPO_ONBOARDING.md`
5. `docs/PLAN.md`
6. `demo/README.md`
7. `CHANGELOG.md`
8. `upgrade-prompts/*.md`

## Documentation policy

1. Product docs (`README.md`, `docs/*`, `demo/README.md`) must describe the current state only.
2. Upgrade/migration/adaptation instructions belong only in `CHANGELOG.md` and `upgrade-prompts/*.md`.
3. Each release section in `CHANGELOG.md` must reference exactly one prompt file under `upgrade-prompts/<version>.md`.

## Linear execution hygiene

When work is tracked in Linear, this is required:

1. Set the issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

## Current product model

`devrouter` now uses one per-repo config file:

- `.devrouter.yml`

Upgrade metadata for agent workflows is stored per repo in:

- `.devrouter.yml` (`devrouter.version` for `dev -V` / `dev upgrade`)

Supported routing:

- HTTP host-run apps
- HTTP docker apps
- TCP PostgreSQL docker apps on shared `:5432` (TLS/SNI)
- Dependency-only docker services (`kind: dependency`, non-routed)

## Supported command surface

- `dev init` (`--write-agents` / `--write-skill` optional; `--with-linear` optional; non-mutating by default)
- `dev -V` (`--repo <path>` optional; shows installed CLI version, local repo version, next upgrade target)
- `dev upgrade` (`[version]`, `--repo <path>` optional; lists targets or prints target adaptation prompt)
- `dev up`, `dev down`, `dev status`, `dev doctor` (alias: `dev verify`), `dev ls`, `dev open`, `dev logs`, `dev tls install`
- `dev repo init`, `dev repo agents` (`--with-linear` optional)
- `dev app add` (`--kind app|dependency`), `dev app ls`, `dev app run` (`--env`), `dev app exec` (`--shell`, `--env`), `dev app rm`

## Repository map

- `src/cli.ts`: command registration (lazy-loaded handlers)
- `src/core/ai-prompt.ts`: canonical AI onboarding prompt template + command intents
- `src/core/upgrade.ts`: repo version metadata + `upgrade-prompts/*.md` resolution for upgrade flows
- `src/core/agents-md.ts`: idempotent AGENTS.md section writer + skill file distributor for repo discoverability
- `src/core/linear-onboarding.ts`: guided Linear workspace/team/project metadata collector for AGENTS bootstrap
- `src/commands/repo-agents.ts`: `dev repo agents` command handler
- `src/commands/upgrade.ts`: `dev upgrade` command handler
- `src/commands/version.ts`: `dev -V` version summary command handler
- `src/core/doctor.ts`: diagnostic report engine for global + repo checks
- `src/core/status.ts`: status collection + readiness insights
- `src/core/docker-error-guidance.ts`: shared Docker failure message enrichment (including disk-space guidance)
- `src/core/repo-config.ts`: `.devrouter.yml` schema + strict validation
- `src/core/concurrency.ts`: concurrent run guard (`assertAppNotRunning`) + stale route eviction (`evictStaleHostRoutes`)
- `src/core/app-run.ts`: runtime orchestration, `startAppDependencies()` helper, `runConfiguredApp()`, `execWithAppEnv()`
- `src/core/docker-run.ts`: cached compose overlay generation, compose up, `queryMappedPort()`, `queryRunningComposeServices()` (routed apps get Traefik labels; `kind=dependency` services are left as-is)
- `src/commands/app-exec.ts`: `dev app exec` command handler
- `src/core/routes.ts`: discover HTTP + TCP routes from labels
- `src/core/router.ts`: shared Traefik stack/files under `~/.config/devrouter`
- `src/core/host-routes.ts`: host process route state + dynamic file rendering
- `src/core/paths.ts`: path traversal guard (`assertPathWithinRepo`) for repo-scoped file references
- `src/core/tls.ts`: mkcert integration, SAN coverage checks, and TLS enablement/refresh
- `src/commands/logs.ts`: `dev logs` command handler (Traefik log access)
- `src/core/output.ts`: human table + JSON output
- `src/types.ts`: shared types
- `demo/.devrouter.yml`: complete sample config for host+docker+postgres routing
- `scripts/smoke-demo.sh`: end-to-end demo smoke script
- `scripts/check-docs-policy.sh`: docs-policy guard for product-doc drift and changelog prompt reference integrity
- `upgrade-prompts/*.md`: versioned agent adaptation prompts consumed by `dev upgrade`
- `.factory/skills/devrouter/SKILL.md`: bundled skill (reference copy; embedded in CLI for distribution)
- `.factory/skills/linear-workflow/SKILL.md`: optional Linear workflow skill (written with `--with-linear`)
- `.factory/skills/linear-workflow/references/*`: optional issue/milestone/progress templates for Linear workflow
- `src/core/__tests__/paths.test.ts`: unit tests for path traversal guard
- `src/core/__tests__/repo-config.test.ts`: unit tests for `.devrouter.yml` schema validation
- `src/core/__tests__/routes.test.ts`: unit tests for route discovery and resolution
- `src/core/__tests__/ai-prompt.test.ts`: unit tests for onboarding prompt/schema consistency
- `src/core/__tests__/agents-md.test.ts`: unit tests for AGENTS/skill file writers (including Linear workflow support)
- `src/core/__tests__/linear-onboarding.test.ts`: unit tests for guided Linear metadata collection + placeholder fallback
- `src/core/__tests__/concurrency.test.ts`: unit tests for concurrent run guard and stale route eviction
- `src/core/__tests__/doctor.test.ts`: unit tests for diagnostics (TLS, Postgres credential checks, host-command wrapper precedence, TLS host coverage)
- `src/core/__tests__/docker-error-guidance.test.ts`: unit tests for disk-space remediation messaging
- `src/core/__tests__/app-run-exec.test.ts`: unit tests for argv-safe `dev app exec`, shell mode guard, per-dep env vars, config-level envMap, exec dependency ownership teardown, and SM `{env}` template resolution
- `src/core/__tests__/tls.test.ts`: unit tests for TLS SAN parsing, wildcard coverage, and host preservation logic
- `src/commands/__tests__/init.test.ts`: unit tests for `dev init` side-effect contract
- `src/commands/__tests__/open.test.ts`: unit tests for `dev open` app-name fallback behavior
- `src/commands/__tests__/repo-init.test.ts`: unit tests for `dev repo init` metadata initialization behavior
- `src/commands/__tests__/repo-agents.test.ts`: unit tests for `dev repo agents` optional `--with-linear` behavior
- `src/commands/__tests__/upgrade.test.ts`: unit tests for `dev upgrade` and `dev -V`
- `src/core/__tests__/upgrade.test.ts`: unit tests for version metadata + prompt-file parsing
- `vitest.config.ts`: Vitest configuration

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
- **Dep lifecycle**: `startAppDependencies()` in `app-run.ts` is the reusable helper for starting deps, resolving env vars, and returning a `stopDeps()` cleanup. `dev app run` keeps the original stop-selected-deps policy; `dev app exec` uses ownership-aware teardown (stop only deps started by that exec call) and falls back to non-destructive cleanup if ownership detection is unavailable. Any new command needing resolved dep env should call this.
- **Port mapping**: `queryMappedPort()` in `docker-run.ts` calls `docker compose port` to discover random host ports. `prepareDockerOverlay()` accepts `publishTcpPorts` to auto-publish `0:<internalPort>` for TCP deps.
- **Dependency-only apps**: `kind=dependency` entries are Docker-only and do not expose routes; they can be auto-started/stopped only through dependency graphs (not direct `run`/`exec`/`open` targets).
- **Env injection**: TCP deps get per-dep deterministic vars: `{PREFIX}_HOST`/`_PORT`/`_URL`/`_SHADOW_URL` (where `{PREFIX} = dep.name.toUpperCase().replace(/-/g, "_")`). Protocol-specific URLs: postgres (`postgres://prisma:prisma@...`), redis (`redis://...`), mysql/mariadb (`mysql://root@...`). Config-level `envMap` on dependency references aliases these to project-specific names (e.g. `DATABASE_URL: DB_URL`). Aliases are applied in `startAppDependencies()` and become part of `depEnv` — they flow through SM re-injection and `buildExecEnvironment()` automatically.
- **Linear bootstrap metadata**: `--with-linear` AGENTS write flows collect minimal Linear mapping (workspace/team/project), write placeholders in non-interactive mode, and persist to managed AGENTS block sentinels.
- **Secret-manager precedence diagnostics**: `dev doctor` emits `repo.host-command-env-precedence` for host apps with postgres deps when `DATABASE_URI`/`DATABASE_URL` is assigned before a `run --` wrapper boundary.
- **TLS host coverage**: `startAppDependencies()` in `app-run.ts` calls TLS coverage refresh for all configured repo hosts when TLS is enabled. `dev doctor` emits `repo.tls-host-coverage` when configured hosts are not covered by current cert SANs.
- **SM env override**: `secretManager.command` supports `{env}` template placeholders resolved by `resolveSmCommand()` in `app-run.ts`. `defaultEnv` provides the config-level fallback; `--env` CLI flag overrides at runtime. Resolution happens at usage sites in `execWithAppEnv` and `runHostApp` before passing to `wrapWithSecretManager`.

## Release checklist

1. Commit all implementation changes (fix/feature commits first, separate from release commit).
2. Bump `version` in `package.json` to `0.0.X`.
3. Bump `devrouter.version` in `demo/.devrouter.yml` to `0.0.X`.
4. Add `[0.0.X]` section in `CHANGELOG.md` between `[Unreleased]` and previous release. Include `### Agent Adaptation Prompt` referencing `./upgrade-prompts/0.0.X.md`.
5. Create `upgrade-prompts/0.0.X.md` with: changes summary, task (bump version, schema migration if any, refresh artifacts), validation steps, report template.
6. Run validation checklist (below).
7. Commit all release artifacts in a single commit: `Release 0.0.X -- <summary>`.

## Validation checklist

1. `pnpm check:docs-policy`
2. `pnpm test`
3. `pnpm typecheck`
4. `pnpm build`
5. `dev doctor --repo ./demo`
6. `pnpm demo:smoke` for full route showcase/regression smoke
7. Update docs for any behavior/surface changes

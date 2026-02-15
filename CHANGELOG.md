# CHANGELOG

All notable changes to this project are documented in this file.

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

```text
You are upgrading a repository that uses devrouter to version 0.0.12.

Task:
1) Keep `.localhost` hostnames as configured; multi-segment hostnames (for example `elearning.klicker.localhost`) remain supported.
2) Ensure runtime workflows use normal run/exec entrypoints so TLS host coverage can auto-refresh:
   - `dev app run <app> --repo <repo> --yes`
   - `dev app exec <app> --repo <repo> --yes -- <command ...>`
3) Validate TLS coverage diagnostics:
   - run `dev doctor --repo <repo>`
   - inspect `repo.tls-host-coverage`
4) If `repo.tls-host-coverage` warns, remediate by either:
   - running app startup via `dev app run <app> --repo <repo> --yes` (auto-refresh), or
   - running `dev tls install` (manual refresh).
5) Re-run diagnostics after remediation:
   - `dev doctor --repo <repo>`

Validation:
- `dev doctor --repo <repo>` has no blocking errors
- `repo.tls-host-coverage` is clear for configured hosts
- representative HTTPS route no longer presents Traefik default cert fallback

Report:
- hostnames reviewed/kept
- whether auto-refresh or manual refresh was used
- doctor summary for `repo.tls-host-coverage`
- unresolved TLS or certificate-trust risks
```

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

```text
You are upgrading a repository that uses devrouter to version 0.0.11.

Task:
1) Refresh discoverability artifacts with the installed CLI version:
   - `dev repo agents --repo <repo>`
2) Review automation/scripts that expect `dev app exec` to always stop dependencies.
   - Update assumptions: exec now stops only deps it started; already-running deps stay up.
3) For workflows that chain app startup + seed/migrate:
   - keep using `dev app run <app> --repo <repo> --yes`
   - run one-shot commands with `dev app exec <app> --repo <repo> --yes -- <command ...>`
   - confirm DB/service remains running when it was already up before exec.
4) Keep deterministic alias mapping for non-Prisma apps:
   - `dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- <command ...>`
5) Keep env probe before migrate/seed when secret managers are involved:
   - `dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL`

Validation:
- start app/deps: `dev app run <host-app> --repo <repo> --yes`
- run one-shot command: `dev app exec <host-app> --repo <repo> --yes -- <seed-or-migrate-command ...>`
- verify dependency service state is unchanged when it was already running before exec
- run `dev doctor --repo <repo>`

Report:
- scripts/workflows reviewed for old teardown assumptions
- command(s) validated and resulting dependency lifecycle behavior
- unresolved risks/ambiguities
```

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

```text
You are upgrading a repository that uses devrouter to version 0.0.10.

Task:
1) Refresh discoverability artifacts with the installed CLI version:
   - `dev repo agents --repo <repo>`
2) Audit host-run commands that wrap app startup with secret managers (Infisical/Doppler or any wrapper using `run --`):
   - detect forms like `DATABASE_URI=... <wrapper> run -- ...`
   - migrate to post-wrapper env override when DB vars must be forced:
     - `<wrapper> run -- env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} <app command ...>`
3) For one-shot commands, keep deterministic alias mapping:
   - `dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- <command ...>`
4) Run env probe before migrate/seed to confirm effective values:
   - `dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL`
5) Run diagnostics and resolve new wrapper-precedence warnings:
   - `dev doctor --repo <repo>`
   - address `repo.host-command-env-precedence` warnings by moving DB assignments after `run --`.

Validation:
- run representative host app startup (`dev app run <host-app> --repo <repo> --yes`)
- run env probe command and confirm `DATABASE_URI` aligns with injected `DATABASE_URL` for local postgres flow
- run `dev doctor --repo <repo>` and confirm no blocking errors

Report:
- host-run commands updated
- env probe output summary
- doctor check summary (including whether `repo.host-command-env-precedence` is clean)
- unresolved risks/ambiguities
```

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

```text
You are upgrading a repository that uses devrouter to version 0.0.9.

Task:
1) Refresh discoverability artifacts with the installed CLI version:
   - `dev repo agents --repo <repo>`
2) If Linear workflow is enabled in this repository, re-run with guided metadata capture:
   - `dev repo agents --repo <repo> --with-linear`
3) Confirm AGENTS.md contains one managed Linear metadata block between:
   - `<!-- devrouter-linear-workflow-config:start -->`
   - `<!-- devrouter-linear-workflow-config:end -->`
4) Ensure required mapping fields are set (no placeholders left):
   - `linear.workspace.name`
   - `linear.team.name`
   - `linear.project.name`
5) If placeholders exist from non-interactive runs, re-run the command in an interactive TTY and provide workspace/team/project values.
6) For Linear-tracked implementation, enforce execution hygiene:
   - set issue status at session start and each phase transition
   - post progress comments at meaningful checkpoints during implementation
   - post an end-of-session recap comment and re-check status/comment freshness before stopping

Validation:
- run `dev init --repo <repo> --with-linear` and confirm guided Linear questions appear
- run `dev repo agents --repo <repo> --with-linear` and confirm AGENTS metadata block is populated
- run `dev doctor --repo <repo>`

Report:
- final workspace/team/project mapping stored in AGENTS
- whether placeholders were replaced
- any unresolved mapping ambiguity
- confirmation that Linear status/comment cadence was followed during execution and at session end
```

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

```text
You are upgrading a repository that uses devrouter to version 0.0.8.

Task:
1) Refresh discoverability artifacts with the installed CLI version:
   - `dev repo agents --repo <repo>`
2) If your team wants Linear-backed milestone workflow assets, bootstrap them explicitly:
   - `dev repo agents --repo <repo> --with-linear`
   - or `dev init --repo <repo> --with-linear --write-agents --write-skill`
3) Ensure AGENTS.md now references both skills when Linear workflow is enabled:
   - `.factory/skills/devrouter/SKILL.md`
   - `.factory/skills/linear-workflow/SKILL.md`
4) Adopt the linear-workflow templates for new milestone tracking:
   - `references/LINEAR_ISSUE_TEMPLATE.md`
   - `references/MILESTONE_PLAN_TEMPLATE.md`
   - `references/PROGRESS_UPDATE_TEMPLATE.md`
5) Use devrouter release guidance from `https://github.com/rschlaefli/devrouter/blob/main/CHANGELOG.md` (latest Agent Adaptation Prompt); this does not require adding `CHANGELOG.md` to the target repository unless that repository already has its own policy.

Validation:
- run `dev init --repo <repo> --with-linear` and confirm the prompt includes "Linear milestone workflow"
- run `dev repo agents --repo <repo> --with-linear` and confirm Linear skill/template files exist
- run `dev doctor --repo <repo>`

Report:
- whether Linear workflow bootstrap was enabled
- artifacts created/updated
- any repo-specific deviations from the template policy
```

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

```text
You are upgrading a repository that uses devrouter to version 0.0.7.

Task:
1) Replace wrapper-recursion or brittle quoted `dev app exec` invocations with argv-safe form:
   - `dev app exec <app> --yes -- <command ...>`
2) For commands that require shell expansion, switch to explicit shell mode:
   - `dev app exec <app> --yes --shell -- "<single shell command string>"`
3) For non-Prisma apps expecting `DATABASE_URI`, add deterministic env aliasing:
   - `dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- <command ...>`
4) If using secret managers (Infisical/Doppler), verify effective DB env before migrate/seed:
   - `dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL`
5) Update onboarding/docs/scripts in your repo to prefer the new primary forms and keep wrapper scripts as fallback only.

Validation:
- run one migration/seed command through the updated `dev app exec` flow
- run the env probe command and confirm expected values
- run `dev doctor --repo <repo>`

Report:
- commands/scripts updated
- env-map usage introduced (if any)
- probe output summary
- unresolved risks/ambiguities
```

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

```text
You are upgrading a repository that uses devrouter to version 0.0.6.

Task:
1) Update any workflows/scripts that relied on `dev init` side effects:
   - use `dev init --write-agents --write-skill`, or
   - run `dev repo agents` after `dev init`.
2) Audit `dev open <name>` usage:
   - confirm names remain unambiguous with app-first resolution,
   - switch to explicit hosts if needed (for example `dev open api.localhost`).
3) Migrate any `dev ls` table parsing to `dev ls --json` and consume:
   - `routes[].appName`
   - `routes[].serviceName`
   - `routes[].hosts`
4) Run `dev doctor --repo <repo>` and handle `repo.postgres-credentials` advisories:
   - align to `POSTGRES_USER/PASSWORD/DB=prisma` where using injected DB URLs, or
   - keep custom credentials with explicit app/runtime URL management.
5) If your repo was copied from older demo patterns:
   - remove hardcoded host-side `DATABASE_URL` overrides,
   - align compose Postgres defaults to `prisma/prisma/prisma` when using injected env.

Validation:
- run `dev ls`
- run updated `dev open` commands
- run repo automation that consumes routes
- run `dev doctor --repo <repo>`
- run app startup with deps (`dev app run <host-app> --yes`)

Report:
- files/scripts changed
- command changes made
- doctor output summary
- unresolved risks/ambiguities
```

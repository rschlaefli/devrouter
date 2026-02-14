# CHANGELOG

All notable changes to this project are documented in this file.

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

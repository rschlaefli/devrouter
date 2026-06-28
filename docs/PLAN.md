# PLAN.md

Current-state roadmap and quality gates for `devrouter`.

## Current baseline

Delivered and active:

- Unified per-repo config: `.devrouter.yml`
- Repo-local upgrade metadata: `.devrouter.yml` `devrouter.version`
- Upgrade commands: `dev -V` and `dev upgrade [version]`
- First-run machine setup: `dev setup --yes --json`
- Read-only repo fact inspection: `dev repo inspect --json`
- Conservative Node/pnpm/Postgres devcontainer scaffold planning/writing: `dev repo devcontainer write --dry-run --json` and `dev repo devcontainer write --yes`
- Upgrade prompts stored as versioned files: `upgrade-prompts/<version>.md`
- HTTP routing for host-run and Docker-run apps
- HTTP proxy routing (`runtime: proxy`) to an already-running upstream (e.g. devcontainer)
- TCP/Postgres Docker routing on `:5432` with TLS/SNI
- Dependency-only docker services via `kind: dependency` (non-routed, dependency lifecycle only)
- Shared router ownership of `80/443/5432`
- Bundled demo repo (`demo/.devrouter.yml`) for onboarding rehearsal and smoke validation
- `dev app exec` for one-shot commands with resolved dependency env
- argv-safe exec by default with explicit `--shell` opt-in
- `dev app exec --env-map TARGET=SOURCE` for deterministic env alias mapping
- `dev doctor` wrapper precedence warning (`repo.host-command-env-precedence`)
- `dev doctor` TLS SAN coverage warning (`repo.tls-host-coverage`) when TLS is enabled
- `dev app run` / `dev app exec` auto-refresh TLS SAN coverage for configured repo hosts
- Agent discoverability flow via `dev repo agents`
- Optional Linear workflow bootstrap via `dev init --with-linear` / `dev repo agents --with-linear`
- Workspace isolation: `dev workspace up/ls/down` for parallel git worktrees of one repo
  - Three-layer identity: devpod workspace id, devrouter route namespace, and `${WORKSPACE}` upstream placeholder
  - Token resolution: `--workspace` flag > `DEVROUTER_WORKSPACE` env var > branch-derived slug > none (primary checkout, back-compatible)
  - Hosts auto-namespaced in memory (`web.localhost` → `web.<ws>.localhost`); committed `.devrouter.yml` is never rewritten
  - `${WORKSPACE}` substitution in proxy `upstream` only; rejected in `host`
  - TLS SAN auto-extended for active workspace hosts
  - `dev doctor` check `routes.orphaned-workspace-routes` reports worktrees removed without `dev workspace down`

## Documentation policy

- Product docs (`README.md`, `docs/*`, `demo/README.md`) describe current behavior only.
- Upgrade/migration/adaptation instructions stay in `CHANGELOG.md` and `upgrade-prompts/*.md` only.
- Each release section in `CHANGELOG.md` references exactly one prompt file under `upgrade-prompts/`.

## Validation gates

Required checks for behavior and doc consistency:

1. `pnpm check:docs-policy`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`
5. `node dist/dev.js -V --repo ./demo`
6. `node dist/dev.js upgrade --repo ./demo`
7. `node dist/dev.js setup --repo ./demo --yes --json`
8. `node dist/dev.js doctor --repo ./demo`
9. `node dist/dev.js repo inspect --repo ./demo --json`
10. `pnpm demo:smoke` (environment permitting)

## Near-term roadmap

### Milestone 1: Test surface hardening

- Add focused tests for `host-routes.ts` state persistence and rendering.
- Expand diagnostics tests with mocked Docker responses for edge-case guidance.
- Add command-level regression tests for docs-related surfaced behavior.

### Milestone 2: UX and operability

- Add `dev app env <name>` for resolved dependency env inspection.
- Add repo bootstrap helper from discovered compose metadata to `.devrouter.yml`.
- Add `dev app doctor` for app-scoped diagnostics and remediation hints.

### Milestone 3: Protocol/runtime expansion

- Evaluate additional TCP protocol support with explicit TLS requirements.
- Define supported/non-supported host-runtime TCP strategy clearly in schema + docs.

### Milestone 4: CI and release hygiene

- Keep CI gates aligned with validation gates.
- Keep docs-policy guard mandatory in CI.
- Ensure packaged assets include upgrade prompt files consumed at runtime.

## Known risks

- Postgres multiplexing on one shared `:5432` depends on TLS/SNI-capable clients.
- Host-process detection relies on local process/network inspection commands and can vary by environment.
- Full smoke validation requires Docker and local socket/network access.

## Decision log

- `.devrouter.yml` is the single source of truth for per-repo routing config.
- Traefik retains ownership of `80/443/5432`.
- TLS remains mandatory for multiplexed Postgres hostname routing on shared `:5432`.
- `kind: dependency` remains docker-only and non-routed.
- `dev app exec` teardown is ownership-aware and non-destructive on ownership uncertainty.
- Upgrade flows read local repo version from `.devrouter.yml` and prompt files from `upgrade-prompts/`.
- Workspace namespacing is computed in memory only; the committed `.devrouter.yml` is never rewritten by workspace operations.
- `${WORKSPACE}` is intentionally scoped to `upstream` only — `host` auto-namespacing is the authoritative mechanism to prevent collisions.
- Primary-checkout routes (no workspace token) are never touched by workspace GC or teardown operations.

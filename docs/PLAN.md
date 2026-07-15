# PLAN.md

Current-state roadmap and quality gates for `devrouter`.

## Current baseline

Delivered and active:

- Unified per-repo config: `.devrouter.yml`
- Repo-local upgrade metadata: `.devrouter.yml` `devrouter.version`
- Upgrade commands: `devrouter -V` and `devrouter upgrade [version]`
- First-run machine setup: `devrouter setup --yes --json`
- Read-only repo fact inspection: `devrouter repo inspect --json`
- Conservative Node/pnpm/Postgres devcontainer scaffold planning/writing: `devrouter repo devcontainer write --dry-run --json` and `devrouter repo devcontainer write --yes`
- Devcontainer onboarding evidence: `devrouter repo devcontainer verify --json` (static) and `devrouter repo devcontainer verify --live --yes --json` (route registration/probes)
- Upgrade prompts stored as versioned files: `upgrade-prompts/<version>.md`
- HTTP routing for host-run and Docker-run apps
- HTTP proxy routing (`runtime: proxy`) to an already-running upstream (e.g. devcontainer)
- TCP routing with TLS/SNI (`runtime: docker` or `runtime: proxy`; supported `tcpProtocol`: `postgres`, `redis`, `mariadb`, `mysql`)
- Dependency-only docker services via `kind: dependency` (non-routed, dependency lifecycle only)
- Shared router ownership of `80/443/5432`
- Routing example (`examples/routing/.devrouter.yml`) for no-devcontainer routing rehearsal and smoke validation
- Live DevPod/devcontainer example (`examples/devcontainer/`) with `pnpm devcontainer:smoke`
- `devrouter app exec` for one-shot commands with resolved dependency env
- argv-safe exec by default with explicit `--shell` opt-in
- Config-level dependency `envMap` for deterministic env alias mapping
- `devrouter doctor` wrapper precedence warning (`repo.host-command-env-precedence`)
- `devrouter doctor` TLS SAN coverage warning (`repo.tls-host-coverage`) when TLS is enabled
- `devrouter app run` / `devrouter app exec` auto-refresh TLS SAN coverage for configured repo hosts
- Agent discoverability flow via `devrouter repo agents`
- Repository quality gates via Biome, Knip, TypeScript, pre-commit, and Gitleaks
- Workspace isolation: `devrouter workspace up/ensure/ls/stop/down/gc` for parallel git worktrees of one repo
  - One local token plus a durable Git-common-dir owner record across DevPod id, devrouter route namespace, `${WORKSPACE}` upstreams, and devnet aliases
  - Exact-path DevPod discovery; first use derives a sanitized branch/path slug only when no exact DevPod exists
  - Persisted identity is authoritative; ambiguous or conflicting identities fail closed
  - Hosts auto-namespaced in memory (`web.localhost` → `web.<ws>.localhost`); committed `.devrouter.yml` is never rewritten
  - `${WORKSPACE}` substitution in proxy `upstream` only; rejected in `host`
  - `workspace ensure` validates overlay/Git mounts, environment, aliases, health, Git access, HTTP route reachability, and unique running TCP upstream ownership; one stale DevPod gets one recreate
  - Route replacement happens atomically only after runtime proof; ensure/stop/down serialize per worktree
  - `stop` preserves checkout, owner record, and data; full `down` rejects dirty or locked worktrees before side effects
  - `workspace ls` reports `present`, `missing`, `locked`, or `conflict`; `gc` reports by default and mutates exact missing owners only with `--yes`
  - TLS SAN auto-extended for active workspace hosts
  - Git has no worktree-removal hook; doctor reports missing/conflicting owners and points to dry-run `workspace gc`
  - Workspace commands require Git; normal config/app/status/doctor flows remain Git-optional

## Documentation policy

- Product docs (`README.md`, `docs/*`, `examples/*/README.md`) describe current behavior only.
- Upgrade/migration/adaptation instructions stay in `CHANGELOG.md` and `upgrade-prompts/*.md` only.
- Each release section in `CHANGELOG.md` references exactly one prompt file under `upgrade-prompts/`.

## Validation gates

Required checks for behavior and doc consistency:

1. `pnpm check:docs-policy`
2. `pnpm check`
3. `pnpm knip`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm build`
7. `node dist/devrouter.js -V --repo ./examples/routing`
8. `node dist/devrouter.js upgrade --repo ./examples/routing`
9. `node dist/devrouter.js setup --repo ./examples/routing --yes --json`
10. `node dist/devrouter.js doctor --repo ./examples/routing`
11. `node dist/devrouter.js repo inspect --repo ./examples/routing --json`
12. `pnpm routing:smoke` (environment permitting)
13. `pnpm devcontainer:smoke` when DevPod is available
14. `pnpm devcontainer:smoke down` after live devcontainer verification

## Near-term roadmap

### Milestone 1: Test surface hardening

- Add focused tests for `host-routes.ts` state persistence and rendering.
- Expand diagnostics tests with mocked Docker responses for edge-case guidance.
- Add command-level regression tests for docs-related surfaced behavior.

### Milestone 2: UX and operability

- Add `devrouter app env <name>` for resolved dependency env inspection.
- Add repo bootstrap helper from discovered compose metadata to `.devrouter.yml`.
- Add `devrouter app doctor` for app-scoped diagnostics and remediation hints.

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
- `devrouter app exec` teardown is ownership-aware and non-destructive on ownership uncertainty.
- Upgrade flows read local repo version from `.devrouter.yml` and prompt files from `upgrade-prompts/`.
- Workspace namespacing is computed in memory only; the committed `.devrouter.yml` is never rewritten by workspace operations.
- `${WORKSPACE}` is intentionally scoped to `upstream` only — `host` auto-namespacing is the authoritative mechanism to prevent collisions.
- Primary-checkout routes (no workspace token) are never touched by workspace GC or teardown operations.

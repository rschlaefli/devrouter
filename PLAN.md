# PLAN.md

Roadmap for `devrouter` beyond the current MVP.

## Context

MVP is intentionally small and delivered:

- shared Traefik router management
- route discovery and listing (docker + host routes)
- app onboarding via compose override generation
- optional local TLS with mkcert
- host-run app support via `devrouter.host.yml` and `dev host *` commands

Next steps focus on reliability, onboarding, and operational polish.

## Guiding goals

1. Keep cognitive load low for new contributors.
2. Preserve independent app repos.
3. Avoid configuration sprawl.
4. Make local setup predictable on macOS.

## Milestone 1: Host mode hardening

Status: next priority

Topics:

1. Add unit tests for:
   - host rule parsing (`src/core/routes.ts`)
   - compose override generation (`src/core/add-app.ts`)
   - TLS state detection (`src/core/router.ts`)
   - host config validation (`src/core/host-config.ts`)
   - host route rendering/state (`src/core/host-routes.ts`)
2. Add non-destructive integration smoke tests for:
   - `dev host run`
   - `dev host attach`
   - `dev host rm`
   - route merge behavior in `dev ls`
3. Improve host process matching diagnostics:
   - clearer ambiguity errors for `attach`
   - better timeout messaging when no port is detected
4. Validate behavior on both OrbStack and Docker Desktop contexts.
5. Verify route cleanup behavior on process exit/signals.

## Milestone 2: Additional commands (v1.1)

Status: planned

Topics:

1. `dev db <name>` (best-effort DB access guidance without port publishing).
2. `dev dns install` (explicit opt-in only, with sudo prompts and clear rollback steps).
3. `dev doctor` for environment checks (Node version, docker context, port conflicts, mkcert state).
4. Optional `dev host add` helper to scaffold `devrouter.host.yml` entries.

## Milestone 3: Packaging and distribution

Status: planned

Topics:

1. Local clone workflow is current default; preserve it.
2. Evaluate npm publishing strategy:
   - package metadata
   - release pipeline
   - versioning/changelog policy
3. Ensure wrapper/global install stories remain simple with PNPM/Volta setups.

## Milestone 4: Documentation and onboarding

Status: planned

Topics:

1. Add copy-paste examples for both onboarding modes:
   - container mode
   - host-run mode
2. Keep reusable AI agent prompt mode-aware with placeholders.
3. Add troubleshooting matrix:
   - port conflicts
   - route not discovered
   - TLS trust issues
   - hostname resolution edge cases
   - host process matching/attach issues

## Milestone 5: CI and quality gates

Status: planned

Topics:

1. Add CI for:
   - `pnpm typecheck`
   - `pnpm build`
   - tests
2. Optional lint/format tooling if it improves consistency without adding overhead.
3. Release checklist for stable changes.

## Milestone 6: Config evolution

Status: planned

Topics:

1. Evaluate migration from `devrouter.host.yml` to unified `devrouter.yml`.
2. Keep backward compatibility with automatic fallback reading.
3. Provide migration helper docs/script if schema is unified.

## Deferred/optional ideas

1. Optional Traefik dashboard helper (`dev dashboard`).
2. Structured event logging for debugging.
3. `dev ls --watch` mode.
4. Optional team presets for naming conventions.
5. Host route health probes for richer status output.

## Explicit non-goals (for now)

1. Kubernetes support.
2. Centralized app registry.
3. Automatic mutation of user system DNS without explicit command.
4. Expanding feature set at the cost of readability.

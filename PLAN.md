# PLAN.md

Roadmap for `devrouter` beyond the current MVP.

## Context

MVP is intentionally small and delivered:

- shared Traefik router management
- route discovery and listing
- app onboarding via compose override generation
- optional local TLS with mkcert

Next steps focus on reliability, onboarding, and operational polish.

## Guiding goals

1. Keep cognitive load low for new contributors.
2. Preserve independent app repos.
3. Avoid configuration sprawl.
4. Make local setup predictable on macOS.

## Milestone 1: MVP hardening

Status: next priority

Topics:

1. Add unit tests for:
   - host rule parsing (`src/core/routes.ts`)
   - compose override generation (`src/core/add-app.ts`)
   - TLS state detection (`src/core/router.ts`)
2. Add command integration smoke tests (non-destructive).
3. Improve `dev up` diagnostics:
   - deduplicate duplicate IPv4/IPv6 listener lines
   - identify common conflict causes (OrbStack proxy, other reverse proxies)
4. Validate behavior on both OrbStack and Docker Desktop contexts.

## Milestone 2: Additional commands (v1.1)

Status: planned

Topics:

1. `dev db <name>` (best-effort DB access guidance without port publishing).
2. `dev dns install` (explicit opt-in only, with sudo prompts and clear rollback steps).
3. `dev doctor` for environment checks (Node version, docker context, port conflicts, mkcert state).

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

1. Add short copy-paste examples for common frameworks (Node, Python, Go).
2. Provide `docker-compose.devrouter.yml` templates per service shape.
3. Add troubleshooting matrix:
   - port conflicts
   - route not discovered
   - TLS trust issues
   - hostname resolution edge cases

## Milestone 5: CI and quality gates

Status: planned

Topics:

1. Add CI for:
   - `pnpm typecheck`
   - `pnpm build`
   - tests
2. Optional lint/format tooling if it improves consistency without adding overhead.
3. Release checklist for stable changes.

## Deferred/optional ideas

1. Optional Traefik dashboard helper (`dev dashboard`).
2. Structured event logging for debugging.
3. `dev ls --watch` mode.
4. Optional team presets for naming conventions.

## Explicit non-goals (for now)

1. Kubernetes support.
2. Centralized app registry.
3. Automatic mutation of user system DNS without explicit command.
4. Expanding feature set at the cost of readability.

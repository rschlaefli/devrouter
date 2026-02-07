# PLAN.md

Roadmap after unified `.devrouter.yml` and PostgreSQL TCP routing.

## Current baseline

Delivered:

- Unified repo config (`.devrouter.yml`)
- `repo`/`app` command surface
- HTTP routing (host + docker)
- TCP/Postgres docker routing on shared `:5432` with TLS/SNI
- Legacy command cutover (`dev add`, `dev host ...`)

## Next milestones

## Milestone 1: Hardening

1. Add schema unit tests for `.devrouter.yml`.
2. Add integration tests for:
   - `dev app run` host runtime
   - `dev app run` docker runtime
   - dependency prompts / `--yes`
   - HTTP + TCP route discovery in `dev ls`
3. Validate behavior on Docker Desktop and OrbStack.
4. Improve `dev up` conflict diagnostics for `80/443/5432`.

## Milestone 2: Protocol and runtime expansion

1. Add MySQL TCP support.
2. Add optional Redis TCP support.
3. Evaluate host runtime TCP targets.
4. Add `dev db` helper for connection guidance snippets.

## Milestone 3: UX and packaging

1. Add migration helper command from legacy files to `.devrouter.yml`.
2. Add optional `dev app doctor` diagnostics.
3. Improve install/distribution (global npm path + release process).

## Milestone 4: CI

1. CI gates: typecheck, build, tests.
2. Add command smoke tests.

## Non-goals (for now)

1. Kubernetes support.
2. Centralized repo registry.
3. Automatic system DNS mutation without explicit opt-in command.

# OSS Release Plan

Goal: publish `@devrouter/cli` as a high-quality, simple OSS package on npm.

- **License:** MIT
- **Platforms:** macOS, Linux, WSL (no native Windows)
- **Container runtimes:** Docker Desktop, OrbStack, native Docker engine
- **CLI binary:** `devrouter` (users alias `dev` themselves)
- **Package:** `@devrouter/cli`

---

## M0: Legal & Project Identity

- [ ] Add MIT `LICENSE` file at repo root
- [ ] Rename bin entry to `devrouter`; document `alias dev=devrouter` in README
- [ ] Update `package.json`:
  - name: `@devrouter/cli`
  - Remove `private: true`
  - Add `repository`, `homepage`, `author`, `license`, `files` fields
  - Set `engines.node` to `>=24`
- [ ] Add `.npmignore` (exclude `src/`, `scripts/`, `examples/`, `docs/`, `.claude/`)
- [ ] Add minimal `CONTRIBUTING.md`
- [ ] Add `CODE_OF_CONDUCT.md` (Contributor Covenant)

## M1: Security Hardening

- [x] Document `shell:true` as intentional (same trust model as npm scripts) + add 4096-char command length cap (`src/core/app-run.ts`, `src/core/repo-config.ts`)
- [x] Path traversal guard for `composeFiles` and `hostRun.cwd` via `assertPathWithinRepo` (`src/core/paths.ts`, `src/core/docker-run.ts`, `src/core/app-run.ts`)
- [x] Strict hostname regex validation — lowercase alphanumeric + hyphens + `.localhost` suffix (`src/core/repo-config.ts`)
- [x] Dependency cycle detection with clear cycle-path error messages (`src/core/repo-config.ts`)

## M2: Cross-Platform (macOS + Linux + WSL)

- [ ] Remove auto-install of mkcert; document prerequisites, link to mkcert install docs
- [ ] Fix `host.docker.internal` for native Linux Docker (`src/core/host-routes.ts`) — use `172.17.0.1` or bridge gateway
- [ ] Validate `ps`/`lsof` flag compatibility across platforms (`src/core/app-run.ts`)
- [ ] Test with Docker Desktop, OrbStack, native Docker engine
- [ ] Centralize `isPidRunning()` (duplicated in 4 files) into shared util
- [ ] Add platform detection utility

## M3: Testing & CI

- [ ] Set up vitest
- [ ] Unit tests: config parsing, dependency resolution, route discovery, port detection
- [ ] Integration tests: app run (host + docker), route listing
- [ ] Adapt smoke tests for CI (no Docker dependency for unit layer)
- [ ] GitHub Actions: typecheck, build, test on macOS + Ubuntu
- [ ] Long-term: Docker-in-Docker CI for full integration/smoke tests

## M4: Error Handling & DX

- [ ] Replace silent failures with explicit errors (YAML parse, host route state, port detection)
- [ ] Add `--verbose`/`--debug` flag for troubleshooting output
- [ ] Improve error messages with context (what failed, what to do)
- [ ] Validate port ranges strictly (reject invalid instead of silent default)
- [ ] Handle stale state file gracefully (warn + recreate vs silent empty)

## M5: Documentation & Publishing

- [ ] Polish README for OSS audience (badges, install instructions via npm, quickstart)
- [ ] Sync tracked docs (README, AGENTS.md, GETTING_STARTED, REPO_ONBOARDING, PLAN, and example READMEs)
- [ ] Add `CHANGELOG.md`
- [ ] Set up semantic-release or changesets for versioning
- [ ] npm publish workflow in GitHub Actions
- [ ] Verify `npx @devrouter/cli` works

---

## Open Questions

- **CI Docker tests:** Mock Docker for unit tests initially; Docker-in-Docker for full smoke tests later?
- **Install UX:** `npx @devrouter/cli` is verbose — recommend `npm i -g @devrouter/cli` as primary path?

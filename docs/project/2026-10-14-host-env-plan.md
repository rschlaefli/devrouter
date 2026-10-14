# Host environment for checkout-scoped host tools

Status: approved 2026-10-14 (executable batch; decisions: single `env` command with `-- <command>` exec form, `DEVROUTER_` variable namespace). Execution mode: `solo` (Opus 5.5). Ceremony tier: full path, because the change adds a public CLI and JSON contract.

## Approval summary

**Why and what changes?** Agents run host tools (Playwright, psql, agent-browser, k6) against a checkout's devrouter stack by assembling URLs and database endpoints by hand. KlickerUZH reads `docker port` for a random loopback Postgres port. Another session rewrote a container DSN to the routed `db.<...>.localhost:5432` endpoint. Neither path is a devrouter command. This package adds one command for the checkout at `[path]`:

- `devrouter env [path] [--json]` reports the workspace, the HTTPS URL of each routed app, both host endpoints of each TCP app, and the mkcert CA path. The two TCP endpoints are the routed TLS/SNI endpoint (`<host>:5432`, which needs a direct-TLS client) and the published loopback port when the upstream container publishes one. JSON output is versioned (`version: 1`).
- `devrouter env [path] -- <command...>` runs a host command with that environment exported, without a shell, and returns its exit code.

**What stays unchanged?** No credentials appear in any output: consumers keep supplying user and password from their own committed env files. Running `env` reads state only. It never starts, stops or reconciles a runtime, so `devrouter ensure` remains the only way to change the runtime. The committed `.devrouter.yml` schema stays as it is. Profile reuse (D3) and lease-based idle stop (D4) are deferred. With D3 deferred, `ensure --profile` keeps its current downward reconciliation.

**What could change the decision?**

1. Command shape. Recommended: a single `env` command whose `-- <command>` form runs a command, like POSIX `env`. Alternative: a separate `devrouter host-run [path] -- <command>`. A top-level `devrouter run` would invert the meaning of the existing `exec` (which runs inside the DevPod) and sit next to `app run`, so I advise against it.
2. Exported variable names. Recommended: a `DEVROUTER_` namespace (`DEVROUTER_WORKSPACE`, `DEVROUTER_<APP>_URL`, `DEVROUTER_<APP>_HOST`/`_PORT`), so exports never shadow a consumer's own `DATABASE_URL` or `API_URL`. `NODE_EXTRA_CA_CERTS` is set only when it is absent. Alternative: the unprefixed `{PREFIX}_HOST/_PORT/_URL` convention that `app exec` uses for Docker dependencies.

**How will we know it is done?** Unit tests cover report assembly, loopback attribution and command exit/env behavior. The repository validation checklist passes. A live check on the KlickerUZH worktree `trees/playwright-host-dx` gets namespaced URLs and a loopback port from `devrouter env . --json`, and `devrouter env . -- psql …` connects through the loopback endpoint. The runtime is stopped afterwards.

**What does approval authorize?** Implementation on `rs/host-env-run`, local commits, pushes to that branch, and one draft PR to `main`. It also authorizes a reversible `devrouter ensure`/`stop` on the KlickerUZH DX worktree for the live check. It does not authorize the release commit, version bump, publishing, merging, marking the PR ready, or changing KlickerUZH to delegate to `devrouter env`. The KlickerUZH change is a follow-up that needs a released devrouter version.

## Execution details

### Evidence and binding contracts

- Runtime view: `loadRuntimeConfig(repoPath)` in `src/core/repo-config.ts` already gives namespaced hosts and resolved `${WORKSPACE}` upstreams. `isTLSEnabled()` picks the URL scheme. `listHostRoutes()` in `src/core/host-routes.ts` provides the live route state behind each app's `active` flag.
- Loopback attribution: `inspectWorkspaceContainers()` and `hasExactComposeIdentity()` in `src/core/devpod-environment.ts` prove a compose container belongs to this checkout. A TCP app's loopback endpoint comes from the one exact-identity container whose `devnet` aliases include the upstream host. Its published binding for the upstream port must be on `127.0.0.1` or `::1`. Any other outcome yields `loopback: null` with a reason (`not-published`, `ambiguous`, `not-running`, `unavailable`); nothing is guessed.
- Routed TCP: the port and client parameters come from `TCP_PROTOCOL_REGISTRY`. Postgres reports `sslmode=require` and `sslnegotiation=direct`. `ai-prompt.ts` already records that framework drivers need the loopback port.
- CA: `getMkcertRootCAPath()`. When it fails, the report carries `caPath: null` with the reason instead of failing the command.
- Exec mode: `spawn` with an argv array, inherited stdio, the child's exit code (signal deaths map to `128 + n`), and SIGINT/SIGTERM forwarded to the child.

### Delegation map

| Workstream | Slices | Owner | Acceptance boundary |
| --- | --- | --- | --- |
| Host environment | S1, S2, S3 | main (solo) | Validation checklist plus live KlickerUZH check |

### Test portfolio

| Risk | Obligation | Seam | Distinct failure |
| --- | --- | --- | --- |
| Report uses non-namespaced hosts or the wrong scheme for a linked worktree | add new | `buildHostEnvReport()` pure function, synthetic config | host tools target the primary checkout's stack |
| Loopback port attributed to another checkout's container or a non-loopback binding | add new | loopback resolver on synthetic container snapshots | psql or Prisma writes to the wrong database |
| Exec mode loses the exit code, interprets argv through a shell, or overwrites consumer env | add new | `src/commands/__tests__/env.test.ts`, real `node -e` child | CI or the launcher reports success on failure |
| Onboarding prompt and skill drift from the CLI surface | extend existing | `ai-prompt.test.ts` | agents are told about a command that does not exist |

### Slices

- **S1 — `devrouter env [path] [--json]`.** New `src/core/host-env.ts` (report assembly and loopback resolver), new `src/commands/env.ts`, registered in `src/cli.ts`. Human output is a compact table; `--json` is the versioned report. Acceptance: the new unit tests, `pnpm typecheck`, `pnpm check`. Commit `feat(env): report host endpoints for a checkout`.
- **S2 — `devrouter env [path] -- <command...>`.** Exec mode in `src/commands/env.ts`, plus the exported variable mapping in `host-env.ts`. Acceptance: `env.test.ts`. Commit `feat(env): run host commands with the checkout environment`.
- **S3 — Documentation surfaces.** Update `docs/DEVCONTAINER.md` (host tools section), `.agents/skills/devrouter/SKILL.md`, `src/core/ai-prompt.ts`, the command surface and repository map in `CLAUDE.md`/`AGENTS.md`, `CHANGELOG.md` `[Unreleased]`, and this record's index entry. Acceptance: `pnpm check:docs-policy`, `pnpm check:knowledge`, `ai-prompt.test.ts`. Commit `docs(env): document host environment command`.

### Verification

Run validation checklist items 1–8 after S3, then the live KlickerUZH check with a rebuilt CLI (`pnpm build`, invoked through `node dist/cli.js`). Afterwards run `devrouter stop` for that checkout and confirm the runtime stopped. End-of-package self-simplification and self-review of the integrated diff are labeled as self-review.

### Working context

- Branch `rs/host-env-run`, worktree `trees/rs/host-env-run`, based on `origin/main` `a9f61a6` (0.3.1).
- Origin: handoff `klicker-uzh/2026-10-14-host-playwright-devrouter-dx-handoff.md` (D1+D2). The KlickerUZH side shipped as uzh-bf/klicker-uzh#6521.

## Progress

- 2026-10-14: plan approved with both recommended decisions. Next: S1.

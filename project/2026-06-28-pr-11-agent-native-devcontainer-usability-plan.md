# devrouter - agent-native devcontainer usability plan

Status: **PR open, follow-up restructure in progress**. Last updated: 2026-06-28.

## Plan identity

- Plan path: `project/2026-06-28-pr-11-agent-native-devcontainer-usability-plan.md`
- Proposed branch: `codex/agent-native-devcontainer-usability`
- Target branch: `main`
- PR: [#11](https://github.com/rschlaefli/devrouter/pull/11)
- Prior related work:
  - `project/2026-06-25-pr-9-workspace-agent-native.md`
  - `project/2026-06-28-pr-10-architecture-deepening-plan.md`

## Progress

- 2026-06-28: User approved execution with goal prompt. Branch work starts on `codex/agent-native-devcontainer-usability`.
- 2026-06-28: S0 committed as `a24af18`.
- 2026-06-28: S1 implemented and verified.
  - Added `dev setup --yes --json` with structured actions/checks/nextSteps and a non-mutating confirmation guard when `--yes` is omitted.
  - Extended check-only doctor diagnostics for Docker Compose v2, mkcert, DevPod, Node/pnpm, and static devcontainer alias/port/upstream checks.
  - Changed doctor route-state behavior to report stale/orphaned routes without mutating state.
  - Accepted review findings from Pasteur/Poincare: real `--yes` semantics, doctor exit code on error, long-syntax Compose ports, external `devnet` validation, one stale-route diagnostic, valid orphan-route suggestion.
  - Evidence: `pnpm typecheck`; `pnpm check:docs-policy`; `pnpm build`; escalated `pnpm test` (31 files, 300 tests); `node dist/dev.js setup --repo ./examples/routing --json` exits 1 with `setup.confirmation`; `node dist/dev.js setup --repo ./examples/routing --json --yes` exits 0 with 4 skipped actions and 21 ok checks; `node dist/dev.js doctor --repo ./examples/routing --json` exits 0 with 21 ok checks; `pnpm routing:smoke` passes.
- 2026-06-28: S1 committed as `622c2bc`.
- 2026-06-28: S2 implemented and verified.
  - Added read-only `dev repo inspect --json` plus compact human summary when `--json` is omitted.
  - Inspector reports package manager, Node metadata, scripts/app candidates with evidence, compose services, env names only, devcontainer files, devrouter config, agent guidance, and actionable issues.
  - Accepted Nash/Pascal review findings: redact script env assignments, sanitize invalid config errors, include compose files referenced by `.devrouter.yml`, update embedded skill output, make `--json` meaningful, add command-level tests.
  - Evidence: `pnpm exec vitest run src/core/__tests__/repo-inspect.test.ts src/commands/__tests__/repo-inspect.test.ts src/core/__tests__/agents-md.test.ts`; `pnpm typecheck`; `pnpm check:docs-policy`; `pnpm build`; escalated `pnpm test` (33 files, 305 tests); `node dist/dev.js repo inspect --repo ./examples/routing`; `node dist/dev.js repo inspect --repo ./examples/routing --json`.
- 2026-06-28: S2 committed as `ce6acaa`.
- 2026-06-28: S3 implemented and verified.
  - Added `dev repo devcontainer write --dry-run --json` plus guarded `--yes` write for a conservative Node/pnpm/Postgres scaffold.
  - Generated managed `.devcontainer/` files and `.devrouter.yml`; custom existing target files stop with a conflict; non-pnpm repos stop with `repo.devcontainer.package-manager-unsupported`.
  - Kept AGENTS mutation explicit via existing `dev repo agents`; `write` now suggests AGENTS guidance instead of editing custom agent docs implicitly.
  - Extended devcontainer diagnostics so `${WORKSPACE:-project}` aliases match both default and active workspace upstreams.
  - Accepted Socrates/Bacon findings: pnpm-only support, installed CLI version in generated `.devrouter.yml`, absolute repo-aware next steps, `--dry-run`/`--json` separation, no implicit AGENTS mutation, broader diagnostics tests.
  - Evidence: `pnpm exec vitest run src/core/__tests__/devcontainer-write.test.ts src/core/__tests__/devcontainer-diagnostics.test.ts src/commands/__tests__/repo-devcontainer.test.ts src/core/__tests__/doctor.test.ts src/core/__tests__/agents-md.test.ts src/core/__tests__/ai-prompt.test.ts`; `pnpm typecheck`; `pnpm check:docs-policy`; `pnpm build`; generated temp-repo dry-run/write/post-write dry-run/doctor replay with all devcontainer checks ok; sandbox `pnpm test` failed only on existing local-listen `EPERM`, escalated `pnpm test` passed (35 files, 313 tests).
- 2026-06-28: S4 implemented and verified.
  - Added `dev repo devcontainer verify --json` as read-only PR evidence over required files, doctor gate, proxy app entries, and workspace namespacing.
  - Added guarded `dev repo devcontainer verify --live --yes --json`; live mode registers proxy routes with a quiet route-only path and probes HTTP routes without invoking the full app-run dependency lifecycle.
  - Accepted Fermat/Kuhn findings: no `runConfiguredApp` in live verify, parseable JSON with no stdout prefix, runtime workspace hosts for live probes, no duplicated doctor checks in top-level JSON, parent CLI description updated, prompt/skill flow includes `write --yes` before verify.
  - Evidence: `pnpm exec vitest run src/core/__tests__/devcontainer-verify.test.ts src/commands/__tests__/repo-devcontainer.test.ts src/core/__tests__/agents-md.test.ts src/core/__tests__/ai-prompt.test.ts`; `pnpm typecheck`; `pnpm check:docs-policy`; `pnpm build`; generated temp-repo static verify JSON exits 0; live guard JSON exits 1 with `repo.devcontainer.verify-live-confirmation`; live `--yes --json` parseability check emitted JSON first and cleaned temporary route; escalated `pnpm test` passed (36 files, 318 tests).
- 2026-06-28: S5 implemented and verified.
  - Added `examples/devcontainer/` with a zero-dependency Node app, Postgres, real `.devcontainer/`, proxy-only `.devrouter.yml`, and a live smoke script.
  - Added `pnpm devcontainer:smoke` / `pnpm devcontainer:smoke down`; the smoke runs setup, static verify, DevPod startup, live route verify, app JSON assertion, and direct-SSL Postgres checks for both `prisma` and `shadow`.
  - Extended the generated devcontainer template with a managed Postgres init hook so `SHADOW_DATABASE_URL` points to a real database on fresh volumes.
  - Accepted Gibbs/Lorentz findings: fixed command/docs drift around `--live --yes --json`, removed misleading workspace override, added cleanup commands to validation docs, added example version metadata to the release checklist, asserted app response body, made `psql` direct-SSL robust, and created/smoked the `shadow` database.
  - Evidence: `bash -n examples/devcontainer/run.sh scripts/smoke-devcontainer.sh examples/devcontainer/.devcontainer/init-db.sh examples/devcontainer/.devcontainer/post-start.sh`; focused devcontainer tests; `pnpm check:docs-policy`; `pnpm typecheck`; `pnpm build`; escalated static `node dist/dev.js repo devcontainer verify --repo examples/devcontainer --json` exits 0 with 5 ok checks; escalated `pnpm devcontainer:smoke` passes with live verify 7 ok checks, app JSON `{"ok":true,"workspace":"devcontainer-demo","port":3000}`, and two direct-SSL `psql` checks returning `1`; `pnpm devcontainer:smoke down` passes; escalated `pnpm test` passes (36 files, 318 tests).
- 2026-06-28: S6 implemented and verified.
  - Reworked README, `docs/DEVCONTAINER.md`, `docs/GETTING_STARTED.md`, and `docs/REPO_ONBOARDING.md` so the same agent-native loop appears consistently: setup, doctor, inspect, dry-run write, write, static verify, DevPod, live verify, PR evidence.
  - Updated bundled `devrouter` and `devcontainer-onboarding` skills, reference snippets, gotchas, and `src/core/ai-prompt.ts` so agents prefer CLI inspect/write/verify before manual template work.
  - Accepted Maxwell/Euler findings: fixed missing `--repo`/`--json` in prompt validation commands, split devcontainer vs host/docker validation paths, clarified the product scaffold is app + Postgres only, split preflight/devpod/live verify in agent snippets, simplified PR evidence wording, and avoided an unexplained `${WORKSPACE}` in the README first example.
  - Evidence: stale default-flow search found no outdated `dev up && dev tls` / `for a in app ... dev app run` guidance; `pnpm exec vitest run src/core/__tests__/ai-prompt.test.ts src/core/__tests__/agents-md.test.ts`; `pnpm check:docs-policy`; `pnpm typecheck`; `pnpm build`; escalated `pnpm test` passes (36 files, 318 tests).
- 2026-06-28: Final branch/security/thermonuclear reviews found release-blocking cleanup items and no design reversal.
  - Accepted and fixed shell/Dockerfile injection risks in generated devcontainer files: pnpm versions are semver-validated before use, the Dockerfile quotes the package spec, and inferred `*:dev` script names are shell-quoted.
  - Accepted and fixed docs/generated-guidance drift around removed `--env-map`; current guidance now documents config-level dependency `envMap`, and docs-policy rejects the removed flag in current docs/generated guidance surfaces.
  - Accepted and fixed stale embedded devrouter skill drift; `dev repo agents` now distributes a copy that exactly matches `.agents/skills/devrouter/SKILL.md`, with a regression test for exact sync.
  - Accepted and fixed human `dev repo devcontainer write` output so blocking issues print IDs, details, suggestions, and issue-specific next steps.
  - Accepted and fixed supported-routing summaries so docs mention TCP `runtime: docker` and `runtime: proxy` with the supported protocol set.
  - Evidence so far: focused devcontainer/agent tests pass; `pnpm check:docs-policy` passes; `pnpm typecheck` passes; `pnpm build` passes.
- 2026-06-28: Final post-review validation passed.
  - Static gates: `pnpm check:docs-policy`; `pnpm typecheck`; `pnpm build`; `git diff --check`.
  - Unit/integration gates: escalated `pnpm test` passed (36 files, 321 tests).
  - Routing example setup/run gates: `node dist/dev.js -V --repo ./examples/routing`; `node dist/dev.js upgrade --repo ./examples/routing`; `node dist/dev.js repo inspect --repo ./examples/routing --json`; escalated `node dist/dev.js setup --repo ./examples/routing --yes --json` (0 performed, 4 skipped, 21 ok); escalated `node dist/dev.js doctor --repo ./examples/routing --json` (21 ok, 0 warn, 0 error); escalated `pnpm routing:smoke` passed and printed `https://routing-host.localhost`, `https://routing-docker.localhost`, and `postgres://routing-db.localhost:5432`.
  - Devcontainer/DevPod live gates: escalated `pnpm devcontainer:smoke down`; escalated `pnpm devcontainer:smoke` passed with live verify `7 ok, 0 warn, 0 error`, app JSON `{"ok":true,"workspace":"devcontainer-demo","port":3000}`, and two direct-SSL `psql` checks returning `1`; escalated `pnpm devcontainer:smoke down` cleaned up; final escalated `node dist/dev.js doctor --repo ./examples/routing --json` remained `21 ok, 0 warn, 0 error`.
- 2026-06-28: Accepted final branch re-check docs findings and fixed stale TCP-summary wording plus one secret-manager/envMap wording issue in `docs/GETTING_STARTED.md`.
  - Re-check evidence: stale phrase search for old TCP/Postgres-only and always-injected env wording found no hits; `pnpm check:docs-policy`; `pnpm typecheck`; `pnpm build`; `git diff --check`.
- 2026-06-28: Reorganized runnable fixtures so the no-devcontainer path is `examples/routing/`, alongside `examples/devcontainer/` and `examples/workspace/`.
  - Renamed `demo/` to `examples/routing/`, renamed `scripts/smoke-demo.sh` to `scripts/smoke-routing.sh`, and changed the package script from `demo:smoke` to `routing:smoke`.
  - Renamed routing example hosts from `demo-*` to `routing-*` so folder names, route names, docs, and smoke output agree.
  - Current docs now distinguish the no-devcontainer routing example from the DevPod/devcontainer example.
  - Evidence: `pnpm check:docs-policy`; `pnpm typecheck`; `pnpm build`; `git diff --check`; escalated `pnpm test` (36 files, 321 tests); `node dist/dev.js -V --repo ./examples/routing`; `node dist/dev.js upgrade --repo ./examples/routing`; `node dist/dev.js repo inspect --repo ./examples/routing --json`; escalated `node dist/dev.js setup --repo ./examples/routing --yes --json` (21 ok); escalated `node dist/dev.js doctor --repo ./examples/routing --json` (21 ok, 0 warn, 0 error); escalated `pnpm routing:smoke` passed with `routing-host.localhost`, `routing-docker.localhost`, and `routing-db.localhost`; escalated `pnpm devcontainer:smoke` passed; escalated `pnpm devcontainer:smoke down` cleaned up.
- Active slice: Commit and PR update for example reorganization.
- Next: commit/push and update PR #11 body.

### Final Review Deferrals

- Defer extracting duplicated proxy-route registration from `devcontainer-verify.ts` and `app-run.ts`. The duplication is narrow, already covered by live verification, and changing the route mutation abstraction at the final gate would increase risk without improving the showcase path.
- Defer extracting shared package/compose parsing helpers from `repo-inspect`, diagnostics, and scaffold planning. The current duplication is readable and isolated; a shared parser module should be a separate architecture slice with tests for all call sites.
- Defer replacing the managed devcontainer substring marker with a stricter per-file manifest. The current marker is sufficient for the generated files in this release; exact ownership metadata belongs in a later scaffold-upgrade slice.

## Problem

Engineers should not manually wire devrouter + devcontainer + DevPod. Their agents should do it.

Current state:

- Good primitives exist:
  - `runtime: proxy` over `devnet`
  - `${WORKSPACE}` upstreams
  - `dev workspace up/ls/down`
  - `dev doctor`
  - `.agents/skills/devcontainer-onboarding/` templates
  - `examples/workspace/` smoke
- Gaps:
  - Agent must infer too much from prose.
  - Setup is not one deterministic inspect/apply/verify loop.
  - Devcontainer onboarding skill is useful but not a product surface.
  - Diagnostics do not yet explain devcontainer/devpod failures in a direct, fixable way.
  - Docs start with routing concepts instead of the engineer value: clone, agent sets up PR, engineer runs workspace.

## Goal

Make devrouter devcontainer onboarding agent-native:

1. Agent can bootstrap a machine.
2. Agent can inspect a new repo.
3. Agent can propose a small devcontainer/devrouter plan.
4. Agent can scaffold/update files.
5. Agent can verify with real devpod/devrouter checks.
6. Agent can open a PR with concrete evidence.

Human engineer experience:

- "Ask agent to make this repo devrouter-ready."
- Review PR.
- After merge: `dev workspace up <branch>` or `devpod up .` plus stable routed URLs.

## Non-goals

- No central repo registry.
- No cloud control plane.
- No opaque AI magic inside devrouter CLI.
- No broad app-framework generator.
- No attempt to perfectly infer every repo. Unknowns should become explicit TODOs.
- No large docs rewrite before the product loop works.
- No support matrix explosion. Start with Node/pnpm + Docker/DevPod + proxy routes.
- No secrets migration. Devcontainer env stays dev-only; real secrets stay in existing systems.

## Product principle

Agent-native means CLI outputs are:

- deterministic
- idempotent
- non-interactive with `--yes`
- dry-runnable where useful
- JSON-readable with stable diagnostic IDs
- actionable: every failure says what to run or edit next

Core loop:

```text
setup -> doctor -> inspect -> dry-run -> write -> verify -> PR evidence
```

No command should require the agent to scrape prose when structured output is reasonable.

## Low-complexity command surface

Keep new surface small and grouped.

### Machine setup and diagnostics

```bash
dev setup --yes --json
dev doctor --json
```

Purpose:

- Add one explicit initial setup command for devrouter-owned machine state.
- Keep `dev doctor --json` as the non-mutating diagnostic command for "what is wrong?"
- `dev setup` prepares:
  - global router files under `~/.config/devrouter`
  - shared Docker network `devnet`
  - shared Traefik router stack
  - mkcert TLS/certs when possible
- Both setup and doctor report machine-level prerequisites:
  - Docker daemon/context reachable
  - Docker Compose v2 reachable
  - Homebrew/mkcert state
  - DevPod installed when devcontainer/workspace flows are relevant
  - Node/pnpm versions sane for this repo when repo metadata exists

Rule:

- `dev setup` may mutate devrouter-owned state and run the existing `dev up` / `dev tls install` behavior.
- `dev setup` should be idempotent and agent-safe with `--yes`.
- `dev setup --json` returns what it changed, what it skipped, and missing dependency recommendations.
- Missing external tools become clear remediation items. Do not silently install broad toolchains.
- `dev doctor --json` never mutates. It checks setup quality and diagnoses failures after setup.
- Add new doctor/setup check IDs using the same diagnostic shape:
  - `global.docker-compose`
  - `global.mkcert`
  - `global.devpod`
  - `global.node-toolchain`
  - `repo.devcontainer.aliases`
  - `repo.devcontainer.no-published-ports`

Agent-native setup contract:

- Non-interactive path: `dev setup --yes --json`.
- Idempotent: safe to rerun; already-ready steps report `skipped` or `ok`.
- Structured: output includes `actions`, `checks`, `summary`, `nextSteps`, and stable diagnostic IDs.
- Bounded mutation: only devrouter-owned state is changed by default.
- Dependency recommendations: missing Docker, Compose v2, DevPod, Node, pnpm, Homebrew, or mkcert are reported with exact install/remediation commands.
- No secret access: setup never asks for or prints credentials.
- Machine readable failure: exits non-zero on blocking failure and still prints JSON when `--json` is requested.
- Human readable default: without `--json`, the same result is printed as concise status plus next steps.

### Repo inspection

```bash
dev repo inspect --json
```

Purpose:

- Produce stack facts for an agent:
  - package manager and versions
  - app candidates and likely ports
  - existing Docker Compose files
  - existing `.devcontainer/`
  - Prisma/Postgres/Redis hints
  - auth/OIDC hints
  - existing `.env*` names, without printing secret values
  - current `.devrouter.yml`
  - AGENTS/CLAUDE guidance files

Rule:

- Inspector reports confidence and evidence path.
- It does not decide final architecture alone.

Example JSON shape:

```json
{
  "repoPath": "/repo",
  "packageManager": { "name": "pnpm", "version": "11.6.0", "source": "package.json" },
  "apps": [
    { "name": "web", "port": 3000, "confidence": "medium", "evidence": ["package.json:scripts.dev"] }
  ],
  "services": [
    { "kind": "postgres", "source": "docker-compose.yml", "confidence": "high" }
  ],
  "devcontainer": { "exists": false },
  "issues": [
    { "id": "repo.devcontainer.missing", "level": "warn", "summary": "No .devcontainer found." }
  ]
}
```

### Repo devcontainer onboarding

```bash
dev repo devcontainer write --dry-run --json
dev repo devcontainer write --yes
dev repo devcontainer verify --json
dev repo devcontainer verify --live --yes --json
```

Purpose:

- `write --dry-run --json`: create an agent-readable proposed file/change plan from repo inspection.
- `write`: scaffold or update `.devcontainer/`, `.devrouter.yml`, and local agent guidance.
- `verify`: run the concrete route/devpod/devnet checks.

Rule:

- Put canonical templates in one source of truth for the CLI.
- Keep `.agents/skills/devcontainer-onboarding/references/` as a generated or synced consumer copy.
- Keep placeholder/TODO comments when confidence is low.
- Do not delete an existing `.devcontainer/`; update conservatively or stop with a plan.
- Do not clobber an existing custom `.devrouter.yml`.
- App-entry management stays with `dev app add`; devcontainer write only creates a minimal proxy/dependency config when safe.
- Never commit real secrets.

## Agent contract

An agent should be able to do this:

```bash
dev setup --yes --json
dev doctor --json
dev repo inspect --json
dev repo devcontainer write --dry-run --json
dev repo devcontainer write --yes
dev repo devcontainer verify --json
```

Then:

- run repo checks
- commit changes
- open PR
- include `verify --json` summary in PR body

Failure behavior:

- Keep the repo-wide CLI exit contract: `0` for success, `1` for failure.
- Agents branch on JSON check IDs and levels, not on multiple exit-code meanings.
- Use existing diagnostic shape where possible: `id`, `level`, `summary`, `details`, `suggestion`, and optional docs links.

JSON issue fields:

```json
{
  "id": "global.devnet",
  "level": "error",
  "summary": "External Docker network devnet does not exist.",
  "suggestion": "Run dev up before devpod up.",
  "docs": "docs/DEVCONTAINER.md#join-devnet"
}
```

## Engineer-facing value proposition

Use this phrasing in docs:

> devrouter gives every devcontainer stable local HTTPS and database hostnames with no port collisions. Your agent can add the setup to a repo, verify it, and open a PR. Engineers then run one workspace command per branch instead of hand-wiring ports, TLS, DBs, and auth mocks.

Avoid leading with Traefik/SNI/devnet details. Put those below "How it works".

## Documentation structure

Keep docs small and task-oriented.

### README.md

Top sections:

1. What devrouter is for.
2. Fast path for engineers.
3. Fast path for agents.
4. Existing command reference.

Add this short block:

```md
## Agent-native setup

For a new machine:

```bash
dev setup --yes --json
dev doctor --json
```

For a new repo:

```bash
dev repo inspect --json
dev repo devcontainer write --dry-run --json
dev repo devcontainer write --yes
dev repo devcontainer verify --json
```

Agents should include the verification JSON summary in their PR.
```

### docs/DEVCONTAINER.md

Keep as concept/reference doc.

Changes:

- Add "agent command flow" near top.
- Keep devnet, TLS, Postgres direct-SSL details as reference.
- Link to the agent-native section in `docs/REPO_ONBOARDING.md`.

### docs/GETTING_STARTED.md

Make engineer path obvious:

1. Install CLI.
2. Run `dev setup`.
3. Run `dev doctor --json` if setup fails or before opening a PR.
4. Try demo.
5. Ask agent to onboard repo.

Do not duplicate full devcontainer reference.

### docs/REPO_ONBOARDING.md

Make this the primary agent-native repo onboarding doc.

Add:

- Short "Agent-native onboarding" section near the top.
- Command contract:
  - `dev setup --yes --json`
  - `dev doctor --json`
  - `dev repo inspect --json`
  - `dev repo devcontainer write --dry-run --json`
  - `dev repo devcontainer write --yes`
  - `dev repo devcontainer verify --json`
- JSON diagnostic convention.
- PR evidence checklist.
- Retry/idempotency rules.
- Manual path remains fallback.

Keep the new section under ~150 lines. Only create `docs/AGENT_NATIVE_SETUP.md` later if this contract outgrows the onboarding doc.

### docs/TROUBLESHOOTING.md

New or extracted from existing docs only if needed.

Symptom-first:

- `devpod up` says `devnet` missing.
- Route returns 404.
- HTTPS cert not trusted.
- App cannot fetch OIDC issuer.
- DB client hangs on `db.<app>.localhost`.
- Parallel workspace host collides.
- DevPod project hash changed and old containers linger.

If this doc grows, create it. If not, keep troubleshooting in `DEVCONTAINER.md`.

### .agents/skills/devcontainer-onboarding/

Keep as advanced agent playbook.

Change role:

- from primary interface
- to implementation/reference material used by CLI docs and advanced agents

## Architecture decisions

### AD1: deterministic CLI, not embedded AI

Decision:

- devrouter CLI detects facts and writes templates.
- The external coding agent chooses and edits.

Why:

- Lower complexity.
- Easier to test.
- Works with Codex, Claude, opencode, future tools.

### AD2: structured diagnostics over prose

Decision:

- `dev setup --json` is the canonical initial machine setup surface.
- `dev doctor --json` remains the canonical non-mutating health and diagnostic surface.
- Both surfaces use the same dotted ID convention where they emit issues.
- JSON uses stable IDs and actionable suggestions.

Why:

- Agents can branch on results.
- Engineers can read same output.
- Setup and diagnosis have separate verbs but one shared diagnostic vocabulary.

### AD3: conservative scaffolding

Decision:

- `write --yes` only writes known files.
- Existing `.devcontainer/` triggers update plan or careful merge, not overwrite.
- Existing custom `.devrouter.yml` triggers a merge plan and stops unless the file is devrouter-managed.
- App entries remain owned by `dev app add`; devcontainer write only adds minimal proxy/dependency entries when safe.
- Unknown app/auth/DB facts become TODOs.

Why:

- Prevents false confidence.
- Keeps review small.

### AD4: one golden example

Decision:

- Add one real `examples/devcontainer/` using actual `.devcontainer/` and DevPod.
- Do not create many framework examples yet.

Why:

- One high-quality e2e beats many stale examples.

## Slices

### S0: Plan and command contract

Problem:

- Need agreed API before code.

Do:

- Commit this plan.
- Treat opencode review findings as scope constraints.
- Keep MVP command additions to:
  - `dev setup --yes --json`
  - `dev repo inspect --json`
  - `dev repo devcontainer write --dry-run --json`
  - `dev repo devcontainer write --yes`
  - `dev repo devcontainer verify --json`
- Extend `dev doctor --json` as the non-mutating check/diagnosis pair to setup.

Files:

- `project/2026-06-28-agent-native-devcontainer-usability-plan.md`

Check:

- Plan-only: `git diff --check`.
- No product-doc policy coverage is expected for `project/`.

Commit:

- `docs(project): add agent-native devcontainer plan`

### S1: Machine setup plus non-mutating diagnostics

Problem:

- A new engineer or agent needs one command that actually performs devrouter-owned initial setup.
- The same engineer or agent also needs a check-only command that explains what is broken without mutating state.

Do:

- Add `dev setup --yes --json`.
- `dev setup` performs the initial devrouter-owned setup:
  - ensure `devnet`
  - ensure global router files
  - start shared Traefik router
  - install/refresh TLS via the existing TLS path when possible
- `dev setup --json` reports:
  - actions performed
  - actions skipped because already ready
  - missing dependency recommendations
  - final doctor-style summary
- Extend existing `dev doctor --json`.
- Add missing global diagnostic checks:
  - `global.docker-compose`
  - `global.mkcert`
  - `global.devpod`
  - `global.node-toolchain`
- Add static repo checks when `.devcontainer/` exists:
  - `repo.devcontainer.aliases`
  - `repo.devcontainer.no-published-ports`
  - `repo.devcontainer.upstream-alias-match`
- Reuse existing diagnostic shape:
  - `id`
  - `level`
  - `summary`
  - `details`
  - `suggestion`
- Keep `dev doctor` strictly non-mutating.
- Keep `dev up` and `dev tls install` as lower-level commands; docs should point first-time users to `dev setup`.

Likely files:

- `src/cli.ts`
- `src/commands/setup.ts`
- `src/core/setup.ts`
- `src/core/__tests__/setup.test.ts`
- `src/core/doctor.ts`
- `src/core/__tests__/doctor.test.ts`
- `docs/GETTING_STARTED.md`
- `README.md`

Check:

- Unit tests for idempotent setup, Docker unavailable, missing Compose v2, missing mkcert/Homebrew, missing DevPod, missing Node/pnpm, alias mismatch, and published routed ports.
- `pnpm typecheck`
- `pnpm test`
- Manual: `node dist/dev.js setup --json --yes`
- Manual: `node dist/dev.js doctor --json --repo ./examples/routing`

Commit:

- `feat(setup): add first-run setup command`

### S2: Repo inspector

Problem:

- Agents need facts without ad hoc greps.

Do:

- Add `dev repo inspect --json`.
- Detect:
  - package manager
  - scripts and likely ports
  - compose services
  - existing devcontainer
  - DB/cache/auth hints
  - existing devrouter config
  - agent guidance files
- Include confidence and evidence.
- Never print env values, only names.

Likely files:

- `src/commands/repo-inspect.ts`
- `src/core/repo-inspect.ts`
- `src/core/__tests__/repo-inspect.test.ts`
- `src/cli.ts`
- `docs/REPO_ONBOARDING.md`

Check:

- Fixture repos in tests.
- Secret-value redaction tests.
- `pnpm test`

Commit:

- `feat(repo): add stack inspection for agents`

### S3: Devcontainer onboarding write

Problem:

- Agent still manually copies templates and resolves placeholders.

Do:

- Add `dev repo devcontainer write --dry-run --json`.
- Add `dev repo devcontainer write --yes`.
- Render templates from one canonical source.
- Generate:
  - `.devcontainer/docker-compose.yml`
  - `.devcontainer/devcontainer.json`
  - `.devcontainer/Dockerfile`
  - `.devcontainer/devcontainer.env`
  - `.devcontainer/post-create.sh`
  - `.devcontainer/post-start.sh`
  - `.devcontainer/README.md`
  - `.devrouter.yml`
  - AGENTS/CLAUDE local dev section
- Existing files:
  - if absent: write
  - if managed by devrouter marker: update
  - if custom: stop and emit merge plan
- Existing `.devrouter.yml`:
  - if absent: write minimal proxy/dependency config
  - if devrouter-managed: update managed section only
  - if custom or contains app entries outside the managed section: stop and emit merge plan
- Keep app-entry mutations with `dev app add`; do not duplicate that writer.
- Add a template sync test if skill references remain duplicated.

Keep profiles minimal:

- `node-postgres`
- `node-postgres-redis`
- `node-postgres-redis-oidc`
- `node-monorepo-proxy` as documented variant, not full auto support

Likely files:

- `src/commands/repo-devcontainer.ts`
- `src/core/devcontainer-plan.ts`
- `src/core/devcontainer-templates.ts` or `templates/devcontainer/*`
- `src/core/__tests__/devcontainer-template-sync.test.ts`
- `src/core/__tests__/devcontainer-plan.test.ts`
- `src/core/__tests__/devcontainer-write.test.ts`
- `.agents/skills/devcontainer-onboarding/references/*` sync as needed
- `docs/REPO_ONBOARDING.md`
- `docs/DEVCONTAINER.md`

Check:

- Snapshot tests for generated files.
- Existing-file no-overwrite tests.
- Placeholder resolution tests.
- No real secret values in generated env.
- `pnpm check:docs-policy`

Commit:

- `feat(devcontainer): scaffold agent-native repo setup`

### S4: Devcontainer verify

Problem:

- Agents need one evidence-producing verification command.

Do:

- Add `dev repo devcontainer verify --json`.
- Verify:
  - `dev doctor --json` has no blocking devcontainer diagnostics
  - route registration works
  - HTTP routes curl
  - Postgres/Redis command hints are present
  - workspace route namespacing works for config without starting full second devpod by default
- Start with non-destructive static checks plus optional `--live`.
- Keep static shape checks in `dev doctor`; keep this command focused on evidence-producing onboarding verification.

Command shape:

```bash
dev repo devcontainer verify --json
dev repo devcontainer verify --live --yes --json
```

Why `--live`:

- Running devpod/Docker is slower and mutates local state.
- Agents can still choose it for PR evidence.

Likely files:

- `src/core/devcontainer-verify.ts`
- `src/commands/repo-devcontainer.ts`
- `src/core/__tests__/devcontainer-verify.test.ts`
- `docs/REPO_ONBOARDING.md`
- `docs/DEVCONTAINER.md`

Check:

- Static fixture tests.
- Live check on example in S5.
- `pnpm test`

Commit:

- `feat(devcontainer): verify agent onboarding state`

### S5: Real devcontainer example

Problem:

- Current workspace example proves routing without real DevPod/devcontainer.

Do:

- Add `examples/devcontainer/`.
- Include minimal Node app + Postgres + Redis optional.
- Include actual `.devcontainer/`.
- Include `.devrouter.yml` with `${WORKSPACE}` upstreams.
- Add smoke script:

```bash
examples/devcontainer/run.sh
examples/devcontainer/run.sh down
```

Smoke:

- `dev up`
- `dev tls install`
- `devpod up .`
- `dev repo devcontainer verify --live --yes --json`
- curl app
- psql direct-SSL if local `psql` available, else skip with structured warning
- workspace up/down if feasible

Likely files:

- `examples/devcontainer/*`
- `scripts/smoke-devcontainer.sh`
- `package.json`
- `docs/GETTING_STARTED.md`

Check:

- `pnpm devcontainer:smoke` on local machine, marked as manual/live because it requires DevPod.
- If CI lacks DevPod, keep CI static and document live local smoke.

Commit:

- `test(devcontainer): add live devpod example smoke`

### S6: Docs and PR evidence loop

Problem:

- Engineer-facing usefulness must be obvious.

Do:

- Update docs with small structure above.
- Add PR evidence template for agents.
- Update bundled `devrouter` skill to tell agents to prefer CLI inspect/apply/verify before manual template work.
- Keep docs short; link reference docs instead of duplicating.

Likely files:

- `README.md`
- `docs/DEVCONTAINER.md`
- `docs/GETTING_STARTED.md`
- `docs/REPO_ONBOARDING.md`
- `.agents/skills/devrouter/SKILL.md`
- `.agents/skills/devcontainer-onboarding/SKILL.md`
- `src/core/ai-prompt.ts`

Check:

- `pnpm check:docs-policy`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

Commit:

- `docs(devcontainer): document agent-native setup flow`

## Merge sequence

Use three PR-sized groups unless implementation proves smaller than expected:

- PR1: S1 + S2. Add `dev setup`, extend `dev doctor --json`, add `dev repo inspect --json`.
- PR2: S3 + S4. Add devcontainer write/dry-run and verify.
- PR3: S5 + S6. Add live example and docs/skill/prompt sync.

Reason:

- PR1 gives agents a first-run setup action plus useful structured facts immediately.
- PR2 adds the real onboarding loop.
- PR3 proves and explains the flow without blocking the command MVP.

## Later roadmap, not next PR

Do after MVP proves useful:

- Richer dry-run diff rendering if plain JSON is not enough.
- More profiles:
  - Python/FastAPI/Postgres
  - Rails/Postgres/Redis
  - generic compose-only
- Hosted example videos/GIFs.
- Optional Linear issue generation from repo inspection.
- DevPod provider profiles if engineers need remote workspaces.
- CI job templates for static verification.
- Richer browser verification for auth flows.

## Verification strategy

Fast checks:

- unit tests for inspectors/planners/verifiers
- snapshot tests for templates
- docs policy
- typecheck
- build

Live checks:

- `dev setup --yes --json`
- `dev doctor --json`
- `dev repo devcontainer verify --live --yes --json`
- `examples/devcontainer/run.sh`
- `examples/devcontainer/run.sh down`

PR evidence:

- JSON summary from `dev setup --yes --json` when machine setup is part of the PR evidence
- JSON summary from `dev doctor --json`
- JSON summary from repo inspect
- JSON summary from devcontainer verify
- URLs tested
- DB/cache route status
- any skipped live checks with reason

## Risk

Risk:

- Too much CLI surface.

Mitigation:

- Add only one `dev setup` command, not a nested setup/check/apply command family.
- Keep `dev doctor --json` as check-only.
- Share diagnostic IDs and output shape across setup and doctor.
- Keep new surface under `repo inspect` and `repo devcontainer`.
- Do not add profile sprawl until one example works.

Risk:

- Agent over-writes a custom devcontainer.

Mitigation:

- Managed markers.
- Stop on custom files.
- `write --dry-run --json` before `write --yes`.

Risk:

- Inspector false confidence.

Mitigation:

- Confidence/evidence fields.
- Unknowns become TODOs.
- No auto-auth assumptions.

Risk:

- Live verify flaky across machines.

Mitigation:

- Split static vs `--live`.
- Stable issue codes.
- Explicit external dependency failures.

Risk:

- Docs become too long.

Mitigation:

- README = value + commands.
- `REPO_ONBOARDING.md` = agent contract plus manual fallback.
- `DEVCONTAINER.md` = reference.
- Troubleshooting only if symptom content becomes large.

## Open questions

1. Should `dev setup` install missing external tools or only recommend them?
   - Recommendation: mutate only devrouter-owned state by default. For missing Docker, DevPod, Node, pnpm, Homebrew, or mkcert, emit install recommendations. Preserve existing `dev tls install` behavior for backward compatibility unless we intentionally change it.
2. Should repo onboarding write AGENTS guidance by default?
   - Recommendation: yes when `--write-agents` or existing AGENTS/CLAUDE file is present; otherwise emit a suggested file.
3. Should live verify run DevPod by default?
   - Recommendation: no. Static verify by default; `--live --yes` for PR evidence.
4. Should this be one PR?
   - Recommendation: no. Use PR1 setup/doctor/inspect, PR2 write/verify, PR3 example/docs unless implementation proves much smaller.
5. Should templates live in CLI source or only in the skill references?
   - Recommendation: CLI is canonical; skill references are synced/regenerated consumer copies.

## Opencode review

Status: completed and integrated on 2026-06-28.

Requested reviewer:

- opencode
- model: `opencode-go/glm-5.2`
- variant: `max`

Prompt:

```text
Review project/2026-06-28-agent-native-devcontainer-usability-plan.md.
Focus:
- Does this make devrouter/devcontainer/devpod setup genuinely agent-native?
- Is command surface too complex?
- Are docs structured for engineer understanding?
- Are slices low-risk and mergeable?
- What should be cut, merged, or reordered?
Return Critical/Important/Minor findings and concrete changes.
```

Accepted findings:

- C1 revised after user review: drop `dev setup check`; keep `dev doctor --json` as the check-only diagnostic command.
- C2 revised after user review: add one plain `dev setup` command for initial setup; keep `dev up` and `dev tls install` as lower-level commands.
- C3: define `.devrouter.yml` merge/no-clobber rules and keep app-entry mutations with `dev app add`.
- I1: collapse `dev repo devcontainer plan` into `dev repo devcontainer write --dry-run --json`.
- I2: keep the existing CLI exit contract instead of adding 0/1/2/3 meanings.
- I3: keep static devcontainer diagnostics in `dev doctor`; keep `verify --live` focused on evidence.
- I4: choose one canonical template source and sync skill references if duplicated.
- I5: use three PR groups: doctor/inspect, write/verify, example/docs.
- M1: use existing dotted diagnostic IDs.
- M2: prefer `docs/REPO_ONBOARDING.md` for the agent contract; add `docs/AGENT_NATIVE_SETUP.md` only if the section grows too large.
- M3: keep dry-run JSON separate from mutating `write --yes`.
- M4: mark DevPod smoke as manual/live.
- M5: use `git diff --check` for the plan-only slice.

Deferred findings:

- Possible `dev up --with-tls`: superseded by `dev setup`.

User correction after opencode review:

- `dev doctor` must not be treated as setup. It checks setup and diagnoses what is wrong.
- Initial setup should be an explicit command such as `dev setup` or a future cleaned-up `dev init`.
- The plan now uses `dev setup` for first-run mutation and `dev doctor` for non-mutating diagnostics.

## Goal prompt

Use this prompt after plan approval:

```text
Goal: execute /Users/rschlae/Git/personal/devrouter/project/2026-06-28-agent-native-devcontainer-usability-plan.md.

Branch:
codex/agent-native-devcontainer-usability

Target:
main

Rules:
- Use df-sliced-development-workflow.
- Commit approved plan first.
- Work one slice at a time.
- Update Progress before and after each slice.
- Keep command surface minimal and agent-native: setup -> doctor -> inspect -> dry-run -> write -> verify -> PR evidence.
- Add one explicit `dev setup` command for first-run mutation.
- Keep `dev doctor --json` strictly non-mutating.
- Add JSON outputs with stable dotted diagnostic IDs for agent use.
- Do not silently install external tools; print remediation unless devrouter owns the mutation.
- Use three PR groups unless implementation is clearly smaller: setup/doctor/inspect, write/verify, example/docs.
- For each slice: implement, verify, review subagent, simplification subagent, integrate accepted findings, re-run verification, commit.
- Final: security review, branch review, PR via df-mr-description-writer.
```

## Next steps

1. Ask user to approve or adjust scope before implementation.
2. Create branch `codex/agent-native-devcontainer-usability`.
3. Commit the approved plan.
4. Start PR1: `dev setup`, doctor extensions, and `dev repo inspect --json`.

# devrouter - architecture deepening plan

Status: **in progress, S3 ready to commit**. Last updated: 2026-06-28.

## Plan identity

- Plan path: `project/2026-06-28-architecture-deepening-plan.md`
- Proposed branch: `codex/architecture-deepening-runtime-routes`
- Target branch: `main`
- PR: none yet
- Source report: `/var/folders/24/j7k2mlqn42l_dhq64jpqslxh0000gp/T/architecture-review-20260628-155228.html`
- Related history: `project/2026-06-25-pr-9-workspace-agent-native.md` for route/workspace behavior and current release evidence.

## Progress

- 2026-06-28: Architecture report reviewed. Repo clean on `main` at start of planning.
- 2026-06-28: Five report recommendations mapped to mergeable slices.
- 2026-06-28: Draft plan file created for independent review.
- 2026-06-28: Independent plan review returned `DONE_WITH_CONCERNS`; accepted fixes for final version/upgrade gates,
  `app rm` route deletion coverage, dependency planner contract, explicit release publish path, optional-slice
  decision checkpoint, and durable report summary.
- 2026-06-28: S0 started. Next: create `codex/architecture-deepening-runtime-routes`, run baseline gates, commit plan
  alone.
- 2026-06-28: S0 done on `codex/architecture-deepening-runtime-routes`. Baseline passed: focused vitest suite
  `147 passed`; `pnpm typecheck`; `pnpm build`; `node dist/dev.js -V --repo ./demo`; `node dist/dev.js upgrade
  --repo ./demo`. Initial sandbox vitest run failed on loopback `EPERM`; rerun with loopback access passed. Next: start
  S1 dependency runtime plan.
- 2026-06-28: S1 started. Next: add characterization/planner tests, extract pure dependency runtime planning, verify
  app-run/exec behavior unchanged.
- 2026-06-28: S1 implemented. Added `src/core/dependency-runtime-plan.ts`, planner characterization tests, and one
  app-run regression for docker app dependencies already running. Review agent `019f0e9b-ea50-70c1-8d77-3748f18ad6d5`
  returned `DONE_WITH_CONCERNS`: accepted stale-progress fix and docker-app/already-running dependency test gap.
  Simplification agent `019f0e9c-1196-7171-a3b9-76707fca9cb0` returned `DONE_WITH_CONCERNS`: accepted narrower
  planner exports, local app-run display helpers, and clearer base/observed plan names. Verification passed:
  dependency planner tests `7 passed`; app-run/exec pair `53 passed`; `pnpm typecheck`; `pnpm build`; `pnpm
  demo:smoke`. Next: commit S1, then start S2 route state ownership.
- 2026-06-28: S1 committed as `ef8ba15` (`refactor(runtime): deepen dependency planning`).
- 2026-06-28: S2 started. Next: map raw route-state policy, add route-state operations/tests, update callers, verify
  exact route deletion and workspace/orphan behavior.
- 2026-06-28: S2 implemented. Added `src/core/route-state.ts` and route-state policy tests; moved stale process,
  orphan workspace proxy, canonical worktree path matching, exact app route deletion, and run-conflict reconciliation
  behind route-state operations. Review agent `019f0ea9-db88-7831-a108-321ef51a8382` returned
  `DONE_WITH_CONCERNS`: accepted canonical same-app conflict fix, proxy re-register via route-state, and `/tmp` vs
  `/private/tmp` regressions. Simplification agent `019f0eaa-0ddd-7b50-884e-229706457f76` returned
  `DONE_WITH_CONCERNS`: accepted removing concurrency GC wrappers, caller tests mocking route-state, one-read
  workspace route listing, narrower exports, and mutating conflict operation rename. Verification passed: route-state
  S2 unit set `28 passed`; app-run/exec `46 passed` with loopback access; `pnpm typecheck`; `pnpm build`; `node
  dist/dev.js doctor --repo ./demo` (`18 OK`, `0 WARN`, `0 ERROR`); isolated temp-`HOME` route-state smoke; workspace
  example up/down. Next: commit S2, then record S4/S5 go/no-go checkpoint before optional code.
- 2026-06-28: S2 committed as `50f15d6` (`refactor(routes): deepen route state ownership`).
- 2026-06-28: Optional checkpoint recorded. S4 route inventory: **No-go**. Evidence: `ls`, `open`, and `doctor`
  still collect Docker + host routes, but the remaining code is thin orchestration over existing helpers and inventory
  would mostly forward calls. S5 workspace identity: **No-go**. Evidence: path matching/removal now sits in
  route-state; remaining workspace token/default-worktree behavior is cohesive in `workspace.ts` and
  `workspace-lifecycle.ts`. Next: start S3 config capability facts.
- 2026-06-28: S3 started. Next: add small capability facts module, wire parser/prompt low-risk constants, verify docs
  policy/typecheck/build.
- 2026-06-28: S3 implemented. Added `src/core/capabilities.ts` for runtime/protocol facts, TCP protocol listing,
  dependency-only runtime, workspace/secret-manager placeholders, dependency env suffixes, and Postgres dependency URL
  builders. Parser, dependency env generation, and onboarding prompt now import those facts without generating broad
  prose. Review agent `019f0eb7-9c61-7d42-b0ef-e9ea677daf08` returned `DONE_WITH_CONCERNS`: accepted expanded facts
  scope, direct unsupported `--tcp-protocol` app-add test, and stronger prompt drift assertions. Simplification agent
  `019f0eb7-eb9d-7e12-8397-8f0a2276dbb2` returned `DONE_WITH_CONCERNS`: accepted keeping the default TCP protocol
  local to config authoring, removing parser-only helper exports, and extracting prompt env-name formatting.
  Verification passed: focused S3 suite `133 passed`; `pnpm check:docs-policy`; `pnpm typecheck`; `pnpm build`. Next:
  commit S3, then run final full verification and review gates.

## Goal

Deepen the internal Modules called out by the architecture report while preserving current CLI behavior, config shape,
route state format, docs policy, and release flow.

Primary improvements:

1. Dependency Runtime Plan Module.
2. Route State Ownership Module.
3. Config Capability Facts Module.

Conditional improvements:

4. Route Inventory Module.
5. Workspace Identity concentration.

## Non-goals

- No new CLI flags.
- No `.devrouter.yml` schema migration unless implementation proves a current fact is wrong.
- No global repo registry.
- No change to `~/.config/devrouter` artifact location.
- No change to `.localhost` hostname convention.
- No change to Traefik ownership of `80`, `443`, or `5432`.
- No broad workspace manager.
- No full AI prompt generator. Share canonical facts only; keep prompt voice authored.
- No Docker compose command redesign unless dependency-runtime extraction proves current call shape blocks the slice.

## Report findings

### Finding 1: Deepen dependency runtime plan

Problem:

- `startAppDependencies()` says "start dependencies" but owns app selection, prompt policy, compose state, ownership
  tracking, TCP env, `envMap`, secret-manager reinjection inputs, logs, and teardown.
- `runConfiguredApp()` and `execWithAppEnv()` share this behavior but tests must mock many neighbors.

Evidence:

- Files: `src/core/app-run.ts`, `src/core/docker-run.ts`, `src/core/__tests__/app-run-exec.test.ts`.
- Report rank: `Strong`, top recommendation.

Decision:

- Build an internal Dependency Runtime Plan Module.
- Keep `docker-run.ts` as Docker Adapter.
- Keep public `runConfiguredApp()` / `execWithAppEnv()` behavior stable.

Risk:

- Refactor can silently alter dep ownership or teardown. Use existing exec/run tests plus a full demo smoke.

### Finding 2: Deepen route state ownership

Problem:

- Callers get raw host route state and must remember PID/proxy policy, workspace tags, canonical path comparisons,
  primary-checkout preservation, and orphan cleanup rules.

Evidence:

- Files: `src/core/host-routes.ts`, `src/core/concurrency.ts`, `src/core/workspace-lifecycle.ts`, `src/core/doctor.ts`.
- Existing tests cover sharp route/workspace cases, but the policy is spread across callers.
- Report rank: `Strong`.

Decision:

- Move route lifecycle operations behind one route-state Interface.
- Keep state file format and dynamic Traefik rendering unchanged.

Risk:

- Route deletion scope is security-sensitive. Verify with isolated `$HOME` route state before touching shared state.

### Finding 3: Create config capability facts

Problem:

- Parser, onboarding prompt, and bundled skill repeat schema/runtime facts.
- Drift pressure is high because prompt prose is a parallel shallow Interface.

Evidence:

- Files: `src/core/repo-config.ts`, `src/core/ai-prompt.ts`, `src/core/__tests__/ai-prompt.test.ts`,
  `.agents/skills/devrouter/SKILL.md`.
- Report rank: `Strong`.

Decision:

- Add a small facts Module for runtime/protocol support, TCP protocols, env var naming, workspace templating, and
  secret-manager placeholder rules.
- Import facts where low-risk. Keep prose human-authored.

Risk:

- Over-generating docs/prompt would reduce readability. Use facts for constants and targeted checks only.

### Finding 4: Add route inventory Module

Problem:

- `ls`, `open`, and `doctor` assemble route sources and duplicate host lookup logic.

Evidence:

- Files: `src/core/routes.ts`, `src/core/host-routes.ts`, `src/commands/ls.ts`, `src/commands/open.ts`,
  `src/core/doctor.ts`.
- Report rank: `Worth exploring`, not first.

Decision:

- Defer by default.
- Implement only if route-state work still leaves repeated route collection logic in multiple callers.

Risk:

- Today deletion moves limited complexity. Do not add a Module just to mirror three callers.

### Finding 5: Concentrate workspace identity

Problem:

- Workspace token, worktree identity, runtime config application, and route cleanup path semantics are spread across
  `workspace.ts`, `workspace-lifecycle.ts`, `repo-config.ts`, and `concurrency.ts`.

Evidence:

- Files: `src/core/workspace.ts`, `src/core/workspace-lifecycle.ts`, `src/core/repo-config.ts`,
  `src/core/concurrency.ts`.
- Report rank: `Worth exploring`, with caution against a broad workspace manager.

Decision:

- Defer by default.
- Implement only if route-state extraction repeats canonical worktree identity logic.
- If implemented, deepen `workspace.ts` around identity/path semantics only. Keep git/devpod/config orchestration out.

Risk:

- Easy to over-abstract. Keep it identity-only.

## Skill routing

- Planning/execution: `$df-sliced-development-workflow`.
- Plan and subagent output style: `$caveman` basic labels.
- Architecture source: `$improve-codebase-architecture` report already generated.
- Build loop: `$tdd` only where a public behavior can be protected first.
- Per-slice verification: `$verification-before-completion`.
- Per-slice review: independent review subagent, minimum diff/context only.
- Per-slice simplification: separate simplification subagent, minimum diff/context only.
- Final quality gate: `$thermo-nuclear-code-quality-review`.
- Final PR body: `$df-mr-description-writer`.

## Research

Question:

- Does external documentation materially change the plan?

Answer:

- No. Work is internal refactor over existing local Modules and tests.
- No new library/API behavior is planned.
- Existing report and current repo map are enough evidence.

Local evidence:

- Architecture report lists the five candidates and ranks the first three as `Strong`.
- Existing tests already cover dependency runtime, route state, workspace lifecycle, parser, and prompt consistency.
- Prior PR #9 plan records live route/workspace/deploy evidence and current release behavior.

Limitations:

- Report path is a temp HTML path. This plan's `Report findings` section is the durable summary and should be treated
  as current source material if the temp report disappears.

## Independent plan review

Status: `DONE_WITH_CONCERNS`, accepted.

Reviewer:

- Agent `019f0e8b-53ee-7522-827b-a3a60c8bc1c8`.

Accepted findings:

- Important: add `node dist/dev.js -V --repo ./demo` and `node dist/dev.js upgrade --repo ./demo` to final gates.
- Important: include `dev app rm --keep-config` / exact route deletion scope in S2.
- Important: define Dependency Runtime Plan contract as pure planning over config/app plus observed runtime state.
- Important: make release/publish path explicit: merge, wait main CI, create GitHub release or manual publish workflow,
  wait publish, verify npm.
- Minor: require explicit S4/S5 Go/No-go record in `Progress` before optional code.
- Minor: make report findings durable in this plan instead of relying on temp HTML.

Deferred findings:

- None.

Review prompt:

```text
Review /Users/rschlae/Git/personal/devrouter/project/2026-06-28-architecture-deepening-plan.md.
Goal: plan architecture improvements from local report, not implement.
Use caveman basic form.
Return status DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED.
Focus: slice order, scope control, verification gates, optional follow-ups, route-state safety, dependency-runtime
behavior preservation, and release/deploy assumptions.
Do not edit files.
```

## Slice S0 - plan review, branch, baseline

Goal:

- Make plan executable and commit it alone before code changes.

Do:

- Create/switch to branch `codex/architecture-deepening-runtime-routes`.
- Confirm independent plan review is recorded.
- If the plan changes materially before commit, run a fresh independent review and integrate accepted findings.
- Run fast baseline checks.
- Commit plan only.

Files:

- `project/2026-06-28-architecture-deepening-plan.md`

Check:

- `git status --short --branch`
- `pnpm exec vitest run src/core/__tests__/app-run-exec.test.ts src/core/__tests__/concurrency.test.ts src/core/__tests__/workspace-lifecycle.test.ts src/core/__tests__/repo-config.test.ts src/core/__tests__/ai-prompt.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `node dist/dev.js -V --repo ./demo`
- `node dist/dev.js upgrade --repo ./demo`

Commit:

- `docs(project): add architecture deepening plan`

Exit:

- Branch exists.
- Plan review findings recorded.
- Plan committed alone.

## Slice S1 - dependency runtime plan

Goal:

- Make dependency lifecycle decisions local and testable without changing `dev app run` or `dev app exec` behavior.

Problem:

- `startAppDependencies()` mixes planning and execution.
- Tests must inspect orchestration through many mocked neighbors.

Do:

- Add a Dependency Runtime Plan Module, likely `src/core/dependency-runtime-plan.ts`.
- Define contract:
  - Inputs: config, selected app, dependency graph, and observed runtime state supplied by Adapters.
  - Output: execution plan, env plan, and teardown plan.
  - No Docker calls.
  - No process spawning.
  - No route/file state writes.
  - No prompt I/O.
  - Mapped ports and running-service state are observed inputs, not queried inside the planner.
- Add S1a characterization tests before moving behavior:
  - exercise current `runConfiguredApp()` / `execWithAppEnv()` behavior through existing mocked Adapters.
  - record teardown ownership and env injection expectations.
  - fail before extraction if current behavior is not understood.
- Move planning decisions out of `startAppDependencies()`:
  - resolved dependency list from config/app.
  - selected Docker apps.
  - services to start.
  - already-running vs newly-started ownership.
  - TCP deps needing mapped ports.
  - deterministic per-dep env vars.
  - config-level `envMap` aliases.
  - secret-manager reinjection env input.
  - teardown actions for run vs exec.
- Keep execution in `app-run.ts`.
- Keep Docker operations in `docker-run.ts`.
- Keep `StartedDeps` behavior stable for `runConfiguredApp()` and `execWithAppEnv()`.
- Add focused tests for plan cases before or alongside extraction.

Files:

- `src/core/app-run.ts`
- `src/core/docker-run.ts` only if call shape must narrow.
- `src/core/dependency-runtime-plan.ts`
- `src/core/__tests__/dependency-runtime-plan.test.ts`
- `src/core/__tests__/app-run-exec.test.ts`

Test cases:

- Host app with TCP docker dependency injects `{PREFIX}_HOST`, `{PREFIX}_PORT`, `{PREFIX}_URL`, postgres shadow URL.
- `envMap` aliases are applied after per-dep vars.
- Missing `envMap` source still fails fast.
- All deps already running: no prompt, env still injected, teardown no-op.
- Exec starts only missing deps and stops only owned deps.
- Unknown ownership detection keeps deps running.
- Docker app target without dependencies stays running after `dev app run`.
- Secret manager reinjection includes config-level `envMap` targets.

Check:

- `pnpm exec vitest run src/core/__tests__/dependency-runtime-plan.test.ts src/core/__tests__/app-run-exec.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `pnpm demo:smoke`

Review:

- Review subagent: correctness, behavior preservation, teardown ownership, test gaps.
- Simplification subagent: smaller plan shape, unnecessary exported types, noisy extraction.

Commit:

- `refactor(runtime): deepen dependency planning`

Exit:

- Existing app-run/exec tests pass.
- Demo smoke passes.
- Public command behavior unchanged.

## Slice S2 - route state ownership

Goal:

- Put route lifecycle policy behind one deep route-state Interface.

Problem:

- `concurrency.ts`, `workspace-lifecycle.ts`, and `doctor.ts` know raw `HostRouteState` policy.

Do:

- Prefer adding `src/core/route-state.ts` if it keeps storage/rendering in `host-routes.ts` clean.
- Accept deepening `host-routes.ts` instead if a new file only forwards calls.
- Hide these policies behind named operations:
  - find routes for canonical worktree path.
  - count routes for worktree/workspace.
  - remove routes for workspace worktree.
  - evict stale process routes.
  - evict orphaned workspace proxy routes.
  - detect same app/repo and hostname conflicts with proxy/PID rules.
- Keep raw persistence, lock behavior, and dynamic Traefik file rendering unchanged.
- Keep `HostRouteState` type stable.
- Update callers to use operations instead of filtering raw arrays.

Files:

- `src/core/host-routes.ts`
- `src/core/route-state.ts` if useful.
- `src/core/concurrency.ts`
- `src/core/workspace-lifecycle.ts`
- `src/core/doctor.ts`
- `src/commands/app-rm.ts`
- `src/core/__tests__/concurrency.test.ts`
- `src/core/__tests__/workspace-lifecycle.test.ts`
- `src/commands/__tests__/app-rm.test.ts`
- New `src/core/__tests__/route-state.test.ts` if operations need direct coverage.

Test cases:

- Dead PID host route evicted.
- Live PID host route kept.
- Proxy route never treated as process-stale.
- Workspace proxy route kept while worktree exists.
- Workspace proxy route reclaimed after worktree dir is gone.
- Primary-checkout proxy route never orphan-evicted.
- `/tmp` and `/private/tmp` path aliases match.
- `workspaceDown()` frees only same repo/worktree workspace routes.
- `dev app rm --keep-config` removes only the exact route for the target app/repo.
- `dev app rm --keep-config` preserves config while removing route state.
- `dev app rm` does not delete same app name from another repo or workspace.

Check:

- `pnpm exec vitest run src/core/__tests__/concurrency.test.ts src/core/__tests__/workspace-lifecycle.test.ts src/core/__tests__/doctor.test.ts src/commands/__tests__/app-rm.test.ts`
- `pnpm typecheck`
- `pnpm build`
- Isolated route-state smoke with temp `$HOME`:
  - seed primary proxy route, live workspace route, orphaned workspace route.
  - run `node dist/dev.js doctor --repo <repo>`.
  - verify only orphan removed.
- `node dist/dev.js doctor --repo ./demo`
- `./examples/workspace/run.sh`
- `./examples/workspace/run.sh down`

Review:

- Review subagent: route deletion scope, path canonicalization, proxy/PID policy, state format preservation.
- Simplification subagent: avoid extra route-state Module if it only renames `host-routes.ts`.

Commit:

- `refactor(routes): deepen route state ownership`

Exit:

- Route/workspace behavior unchanged.
- Isolated route-state smoke proves no unsafe deletion.

## Optional slice checkpoint

Required after S2, before S4/S5:

- Record S4 Go/No-go in `Progress` with evidence from actual post-S2 code.
- Record S5 Go/No-go in `Progress` with evidence from actual post-S2 code.
- If either optional slice is `Go`, run review subagent before implementation starts.
- If either optional slice is `No-go`, do not implement it in this branch.

## Slice S3 - config capability facts

Goal:

- Reduce drift between parser, prompt, and bundled skill without generating all docs/prose.

Problem:

- Runtime/protocol/TCP/workspace/SM facts are repeated in parser and user-facing agent guidance.

Do:

- Add a small facts Module, likely `src/core/capabilities.ts`.
- Include canonical facts:
  - supported app runtimes: `host`, `docker`, `proxy`.
  - supported protocols: `http`, `tcp`.
  - supported TCP protocols: `postgres`, `redis`, `mariadb`, `mysql`.
  - dependency-only runtime rule.
  - host/runtime/protocol compatibility table.
  - workspace placeholder string and placement rule.
  - deterministic dep env var suffixes.
  - postgres default URL/shadow URL shape.
  - secret-manager `{env}` placeholder.
- Import facts in parser where it reduces duplication.
- Import/render/assert facts in `ai-prompt.ts` and `ai-prompt.test.ts` where low-risk.
- Update `.agents/skills/devrouter/SKILL.md` only if wording changes or tests require parity.
- Do not generate the whole prompt or whole skill file.

Files:

- `src/core/capabilities.ts`
- `src/core/repo-config.ts`
- `src/core/ai-prompt.ts`
- `src/core/__tests__/repo-config.test.ts`
- `src/core/__tests__/ai-prompt.test.ts`
- `.agents/skills/devrouter/SKILL.md`

Test cases:

- Parser rejects unsupported TCP protocol using facts list.
- `dev app add` rejects unsupported TCP protocol using same facts list.
- Prompt includes all supported TCP protocols from facts.
- Prompt and bundled skill still describe dependency-only and workspace placeholder rules.
- Existing canonical prompt skeleton still parses.

Check:

- `pnpm exec vitest run src/core/__tests__/repo-config.test.ts src/core/__tests__/ai-prompt.test.ts`
- `pnpm check:docs-policy`
- `pnpm typecheck`
- `pnpm build`

Review:

- Review subagent: drift reduction without over-generation.
- Simplification subagent: fewer exported facts, avoid abstractions not used by at least two consumers.

Commit:

- `refactor(config): centralize capability facts`

Exit:

- Parser and prompt tests share facts where useful.
- Prompt/skill remain readable.

## Slice S4 - conditional route inventory

Status:

- Deferred unless S2 leaves repeated route collection/lookup logic in `ls`, `open`, and `doctor`.

Go condition:

- After S2, at least two callers still manually combine Docker labels plus host state plus duplicate detection, and the
  duplicate logic is non-trivial.

No-go condition:

- S2 makes route callers small enough that inventory would mostly forward to existing helpers.

If go, do:

- Add Route Inventory Module, likely `src/core/route-inventory.ts`.
- Keep Docker label discovery and host route state as internal Adapters.
- Move operations:
  - collect active routes.
  - find duplicate hosts.
  - resolve route by app name/host.
  - format source metadata needed by `ls`, `open`, `doctor`.
- Update `src/commands/ls.ts`, `src/commands/open.ts`, and `src/core/doctor.ts`.

Files:

- `src/core/route-inventory.ts`
- `src/core/routes.ts`
- `src/core/host-routes.ts`
- `src/commands/ls.ts`
- `src/commands/open.ts`
- `src/core/doctor.ts`
- Route/open/doctor tests as needed.

Check:

- `pnpm exec vitest run src/core/__tests__/routes.test.ts src/commands/__tests__/open.test.ts src/core/__tests__/doctor.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `node dist/dev.js doctor --repo ./demo`

Commit:

- `refactor(routes): centralize route inventory`

Exit:

- Only execute if go condition is met and review agrees.

## Slice S5 - conditional workspace identity

Status:

- Deferred unless S2/S4 repeats workspace identity/path semantics.

Go condition:

- Workspace token/path/canonical worktree logic remains duplicated in two or more Modules after S2.

No-go condition:

- Existing `workspace.ts` plus route-state operations are enough.

If go, do:

- Deepen `src/core/workspace.ts` around identity only.
- Add operations:
  - resolve workspace identity from explicit/env/worktree.
  - canonicalize worktree path.
  - derive default worktree path.
  - match branch to workspace token.
  - compare route-backed repo path to worktree path.
- Keep git worktree creation/removal, devpod calls, and config mutation out of the Module.

Files:

- `src/core/workspace.ts`
- `src/core/workspace-lifecycle.ts`
- `src/core/repo-config.ts` only if runtime config identity can import stable facts.
- `src/core/concurrency.ts` or `src/core/route-state.ts`
- `src/core/__tests__/workspace.test.ts`
- `src/core/__tests__/workspace-lifecycle.test.ts`

Check:

- `pnpm exec vitest run src/core/__tests__/workspace.test.ts src/core/__tests__/workspace-lifecycle.test.ts src/core/__tests__/repo-config.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `./examples/workspace/run.sh`
- `./examples/workspace/run.sh down`

Commit:

- `refactor(workspace): concentrate identity semantics`

Exit:

- Only execute if go condition is met and review agrees.

## Slice S6 - final verification, review, PR, release decision

Goal:

- Prove branch is mergeable and decide whether a release is needed.

Do:

- Update this plan's `Progress`.
- Run full local gates.
- Run final security review subagent.
- Run final branch review subagent.
- Integrate or explicitly defer accepted findings.
- Create/update PR with `$df-mr-description-writer`.
- Decide release:
  - If branch is pure internal refactor with no user-facing behavior/docs change, merge without immediate npm release unless
    user requests a version cut.
  - If behavior/docs/agent guidance changes materially, follow repo release checklist for next `0.0.X`.

Full check:

- `pnpm check:docs-policy`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `node dist/dev.js -V --repo ./demo`
- `node dist/dev.js upgrade --repo ./demo`
- `node dist/dev.js doctor --repo ./demo`
- `pnpm demo:smoke`
- `./examples/workspace/run.sh` if S2/S4/S5 changed route/workspace behavior.
- `./examples/workspace/run.sh down` if workspace smoke ran.

Release check, only if cutting a version:

- Bump `package.json`.
- Bump `demo/.devrouter.yml` `devrouter.version`.
- Add `CHANGELOG.md` section.
- Add exactly one `upgrade-prompts/<version>.md`.
- Update `.agents/skills/devrouter/SKILL.md` and `src/core/ai-prompt.ts` if behavior/schema/agent guidance changed.
- Push PR.
- After PR approval and merge:
  - wait for `main` CI.
  - create GitHub release `v<version>` or run the CI workflow manually with `publish=true`.
  - wait for publish workflow.
  - verify npm with:
    - `npm view @devrouter/cli@<version> version dist.tarball`
    - `npx --yes @devrouter/cli@<version> -V --repo ./demo`

Commit:

- No fixed commit. Use slice commits plus optional release commit:
  - `chore(release): 0.0.X`

Exit:

- Full gates pass.
- Reviews handled.
- PR body matches branch diff, commits, plan progress, and verification.
- Release decision recorded.

## Docs sync rules

Update docs only for behavior, command, schema, or onboarding workflow changes.

Required docs if public behavior changes:

- `README.md`
- `AGENTS.md`
- `docs/GETTING_STARTED.md`
- `docs/REPO_ONBOARDING.md`
- `docs/PLAN.md`
- `demo/README.md`
- `CHANGELOG.md`
- `upgrade-prompts/*.md`

Likely docs for this branch:

- None for S1/S2 if behavior stays internal.
- `.agents/skills/devrouter/SKILL.md` and `src/core/ai-prompt.ts` for S3 if capability facts change wording or agent
  guidance.
- Release docs only if cutting next npm version.

## Safety notes

- Route deletion is highest-risk area. Use isolated `$HOME` for destructive-capable route-state smoke.
- Do not run workspace smoke against shared state until `pnpm build` passed.
- Do not weaken hostname validation, workspace token sanitization, path traversal guards, or TCP TLS requirements.
- Do not use broad `git add .` if unrelated user changes appear.
- Do not change state file schema unless explicitly planned and migration covered.

## Goal prompt

Use this prompt to continue implementation:

```text
Goal: execute /Users/rschlae/Git/personal/devrouter/project/2026-06-28-architecture-deepening-plan.md.

Current plan path:
/Users/rschlae/Git/personal/devrouter/project/2026-06-28-architecture-deepening-plan.md

Branch:
codex/architecture-deepening-runtime-routes

Target:
main

Rules:
- Update the plan file's Progress section before and after each slice.
- If a PR ID becomes known, rename only this current plan file to include `pr-<id>` and commit that metadata rename alone.
- Independent plan review is already recorded; if the plan changes materially before the plan commit, run a fresh review and record accepted/deferred findings.
- External cloud review agents are approved by default for workflow-scoped project work; share only minimum plan/diff/context, exclude secrets/credentials/tokens/PII, and ask the user first if sensitivity is unclear or external sharing is restricted.
- Work one slice at a time.
- For each implementation slice: implement, verify, run review subagent, run simplification subagent, integrate accepted findings, re-run verification, update Progress, commit cleanly.
- Use `apply_patch` for manual edits.
- Keep changes minimal and preserve current CLI/config behavior.
- Run `$verification-before-completion` before each slice commit and before claiming completion.
- Run final security review subagent before branch finalization.
- Run final branch review subagent before PR creation/update.
- Use `$df-mr-description-writer` for PR creation/update; body must reflect whole branch against target, commit history, diff, plan/progress, and any existing PR body.
- Full final verification: `pnpm check:docs-policy`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `node dist/dev.js -V --repo ./demo`, `node dist/dev.js upgrade --repo ./demo`, `node dist/dev.js doctor --repo ./demo`, `pnpm demo:smoke`, plus workspace smoke if route/workspace slices changed behavior.
- After S2, record explicit S4/S5 Go or No-go in Progress before optional code.
- End with Next Steps: merge/PR/release decision and any deferred optional slices.
```

## Next steps

1. Create branch `codex/architecture-deepening-runtime-routes`.
2. Run S0 baseline.
3. Commit plan alone.
4. Start S1.

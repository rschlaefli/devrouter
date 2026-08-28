# Devsy partial-start recovery plan

## Identity and scope

- Date: 2026-08-26.
- Repository: `/Users/rschlae/Git/personal/devrouter`.
- Branch: `rs/fix-devsy-partial-start`.
- Worktree: `/Users/rschlae/Git/personal/devrouter/trees/rs-fix-devsy-partial-start`.
- Base and target: `origin/main` at `468158fd322d7a749f685ce57c5ed49ceb4913ee` -> `main`.
- Delivery: prepare devrouter `0.0.42`, push the exact branch to `origin`, and open a draft pull request against `main`.
- Withheld actions: merge, npm or GitHub release publication, runtime deletion, temporary-fixture deletion, and broad Docker cleanup.

This package keeps a cold Devsy workspace recoverable when `devsy workspace up`
returns non-zero after registering or starting the exact checkout. Devrouter must
retain the ignored generated Dev Container configuration whenever exact absence
cannot be proved, because Devsy persists that path and needs it for canonical
`devrouter stop`.

The change does not alter runtime selection, inactivity-timeout configuration,
repository schema, route contracts, DevPod behavior, or user commands. It
restores the existing fail-closed lifecycle contract at the provider boundary.

## Reproduction and root cause

A real cold start selected Devsy from machine configuration and forwarded the
configured `30m` inactivity timeout. Devsy registered and started the exact
workspace, then returned non-zero when its agent injection failed. The provider
adapter threw an ordinary error before ownership postconditions ran, so
`workspaceEnsure` left `environmentStarted=false` and removed
`.devcontainer/devcontainer.devrouter.json`. Devsy had persisted that exact
configuration path, and canonical stop could no longer parse the workspace.
Restoring the ignored generated file made the same stop succeed.

The shared adapter has a second gap: `DevsyStartPostconditionError` is not
normalized to the `DevpodStartPostconditionError` compatibility signal that
`workspaceEnsure` already understands.

## Planner disposition

The required planner returned `DONE_WITH_CONCERNS`. Its concern is adopted:
after a non-zero Devsy start, only a proven absent exact owner permits ordinary
rollback cleanup. One exact owner, conflicting ownership, or unavailable or
invalid registry evidence is a possibly-mutated start and must retain the
generated config while failing closed.

Ownership inspection stays inside `src/core/devsy-mutation.ts` under the
machine-global provider lock. `src/core/devpod-mutation.ts` remains the
compatibility dispatch seam and normalizes the typed Devsy signal. No
provider-specific branch should be added to `workspaceEnsure` unless the public
seam proves the existing contract insufficient.

## Slices

### S0 - reviewed execution contract

Add this plan and its active project-index entry from the exact verified base.

Acceptance: scope, authority, test portfolio, verification, live-proof cleanup,
and stop conditions are explicit; the primary control checkout remains
untouched apart from its pre-existing untracked `.pnpm-store/`.

Commit: `docs(project): plan Devsy partial-start recovery`.

### S1 - partial-start classification and recovery

Use red-green TDD at two stable seams:

- `startDevsyWorkspace` classifies a failed command as possibly started when an
  exact owner remains or absence cannot be proved, and as an ordinary command
  failure only when exact absence is proved.
- Public `workspaceEnsure` retains the generated config for the typed Devsy
  failure, removes it for proven absence, and publishes no routes in either
  failure path.

Normalize the Devsy typed error through the existing provider facade, including
runtime-cache invalidation. Preserve DevPod behavior and ownership checks.

Acceptance: the focused Devsy mutation, DevPod mutation, workspace runtime, and
workspace ensure tests pass. The committed slice receives a simplifier review
and one slice review with lifecycle ownership, correctness, and architecture
lenses.

Commit: `fix(workspace): preserve Devsy partial-start recovery`.

### S2 - release and durable guidance

Prepare `0.0.42`: bump `package.json` and both example metadata files, add the
changelog section and exactly one upgrade prompt, and add the recovery invariant
to the managed lifecycle knowledge. Update the existing overlapping solution
record rather than creating a duplicate. Commands, schema, bundled skills, AI
prompt, README, setup manuals, and ADRs remain unchanged.

Acceptance: version artifacts agree; docs-policy and knowledge checks pass; all
solution citations resolve after final line-number review.

Commit: `chore(release): prepare Devsy partial-start recovery`.

This mechanical release slice stays with the main session because its changes
are small and depend on final source locations used by the solution citation;
delegating it would cost more integration than the work.

### S3 - repository and fresh Devsy proof

Run focused tests, then the repository validation sequence:

```sh
pnpm check:docs-policy
pnpm check:knowledge
pnpm check
pnpm knip
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
git diff --check
```

Run the release checklist's repository setup, doctor, inspect, and routing
smoke checks. Use only their scoped reversible cleanup.

Create one retained `/tmp` Git fixture whose path, Devsy ID, project name,
hosts, and Compose aliases share one fresh unique token. Prove no prior registry
owner or route exists before first use. Run the built `0.0.42` CLI with
`DEVSY_AGENT_BINARY=/tmp/devsy-linux-arm64-v1.16.2`; that verified official
binary is needed because this execution environment blocks Devsy's own agent
download. Confirm machine-config Devsy selection, `30m` inactivity
configuration, cold ensure, exact ownership, running provider state, and unique
route reachability.

Finish with canonical `devrouter stop <exact-path>` without `--delete`. Confirm
the same Devsy ID reports `Stopped` and `devrouter ls --json` has zero routes for
the exact path and unique hosts. Retain the fixture and stopped registration.

Acceptance: every required check passes, the exact runtime is stopped, and no
exact routes remain.

### S4 - final review and pull request

Run the integrated final reviewer against the exact committed range after fresh
verification and lifecycle shutdown. Apply only verified findings, rerun affected
checks, push `origin/rs/fix-devsy-partial-start`, and open a draft PR against
`main`. Rename this record to include the PR number, update the index, commit and
push that metadata-only change, then refresh the PR body and report exact-head CI.

Acceptance: the draft PR covers the whole branch, exact-head required checks are
reported, and merge and publication remain withheld.

## Stop conditions

Stop before final review or PR creation if ownership is ambiguous, the verified
agent binary is unavailable, any required check fails, canonical stop cannot
prove `Stopped`, or exact routes remain. Do not retry with another provider
mutation, delete the runtime, switch providers, merge, or publish the package.

## Approved plan exception

On `2026-08-27` the user approved opening the draft PR as an evidence-gathering
artifact while the two live smoke gaps remain. The draft PR must state both
gaps and remain blocked from merge. Merge, publication, runtime deletion, and
fixture deletion stay withheld.

## Progress

- `2026-08-26`: Fetched `origin`; the task worktree is clean at exact
  `origin/main` commit `468158f`, and no remote feature branch or open PR owns
  this work.
- `2026-08-26`: Reproduced a real Devsy partial start and proved the missing
  generated config prevents canonical stop. Restoring it allowed exact stop;
  provider status is `Stopped` and exact routes are empty.
- `2026-08-26`: Required planner review completed with
  `DONE_WITH_CONCERNS`; its fail-closed ownership classification is incorporated
  above.
- `2026-08-26`: Committed the provider classification, compatibility
  normalization, and public rollback regressions as `c73575d`. Focused Devsy,
  runtime-resolution, and workspace-ensure evidence passed 76 tests; the facade
  regression, Biome, typecheck, Knip, Gitleaks, and diff checks passed.
- `2026-08-26`: The configured hosted simplifier and slice-reviewer routes
  failed before work with HTTP 402. Their documented native continuity reviews
  both returned `DONE` with no findings.
- `2026-08-26`: Prepared and committed release `0.0.42` plus the durable
  recovery guidance. The Node 24.16.0 verification run passed docs policy,
  knowledge validation, Biome, Knip, typecheck, all 717 tests, build, package
  smoke, setup, doctor, repo inspection, Gitleaks, and diff checks. The
  Linux-only process smoke skipped on macOS because `/proc` is unavailable.
- `2026-08-26`: The routing smoke started its Docker app and Postgres but its
  routes did not become ready within 60 seconds. The host process stopped after
  TLS refresh, and the shared routing environment now reports a duplicate
  pre-existing `routing-db.localhost` route. This is recorded as environment
  evidence rather than attributed to the Devsy-only source diff.
- `2026-08-26`: A fresh retained fixture at
  `/private/tmp/devrouter-devsy-0-0-42.XDn19t` proved no prior Devsy owner or
  matching route. Built `0.0.42` selected embedded Devsy `1.16.2` from machine
  configuration and forwarded `INACTIVITY_TIMEOUT=30m`. Devsy registered the
  exact ID `devrouter-devsy-0-0-42-xdn19t`, then failed before creating a
  runtime because its agent reported Docker Compose unavailable. The fixed
  path retained `.devcontainer/devcontainer.devrouter.json`, preserved exact
  ownership and timeout metadata, and published zero routes. Canonical
  `devrouter stop` returned `stopped: true` and `freedRoutes: 0`; provider
  status is `NotFound`, which proves no runtime exists, and the exact route set
  remains empty. The fixture and registration remain for inspection.
- `2026-08-27`: The integrated final review returned `BLOCKED` by the
  accepted-plan verification gate with no verified implementation defect. The
  user approved the plan exception above, authorizing the draft PR as an
  evidence-gathering artifact.
- `2026-08-28`: The shared routing state had no duplicate hosts before a fresh
  `pnpm routing:smoke` run. The smoke passed host HTTPS, Docker HTTPS, and
  PostgreSQL TLS routing. Its scoped processes stopped, no duplicate hosts
  remain, and only the expected exited Docker-label routes remain. Successful
  Devsy cold startup is now the sole live verification blocker.
- `2026-08-28`: An isolated Compose probe reproduced the remaining error
  without mutating a workspace. Devsy's temporary `DOCKER_CONFIG` hides the
  OrbStack plugins under `~/.docker/cli-plugins`; the pinned verification
  `PATH` also omitted `/usr/local/bin`, so Devsy could not reach OrbStack's
  standalone `docker-compose` fallback. Restoring `/usr/local/bin` made that
  fallback report Compose `5.1.2`. One corrected cold-start run remains needed
  to confirm this configuration diagnosis end to end.
- `2026-08-28`: The user approved one exact corrected retry. Devsy reached
  `Running` and created the app container, proving Compose discovery was the
  configuration issue. Devrouter then rejected Devsy's provider-generated
  container-features Compose file because exact-model validation allowed only
  DevPod's equivalent path. Canonical `devrouter stop` succeeded, provider
  state is `Stopped`, the fixture remains clean, and both exact routes are
  absent. TDD regressions now cover the observed Devsy path and reject a
  similarly named provider directory; the minimal allowlist fix passes the
  full 719-test suite, Biome, typecheck, build, package smoke, and diff checks.
  At this checkpoint, a second live retry remained pending.
- `2026-08-28`: The retained fixture passed fixed-head ensure on `9b74456`
  without recreation. Devsy reported the managed runtime ready, both apps
  active, Postgres healthy, the managed process running, and zero drift. The
  HTTP route returned `200`; a libpq 18 direct-SSL query through the namespaced
  Postgres route returned `1`. Ordinary SSL negotiation timed out as documented
  for SNI routing and was not counted as product evidence. Canonical
  `devrouter stop` returned `stopped: true` and `freedRoutes: 2`; Devsy now
  reports `Stopped` and both exact routes are absent. Integrated final review
  is the remaining pre-merge gate.

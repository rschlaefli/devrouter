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

## Progress

- `2026-08-26`: Fetched `origin`; the task worktree is clean at exact
  `origin/main` commit `468158f`, and no remote feature branch or open PR owns
  this work.
- `2026-08-26`: Reproduced a real Devsy partial start and proved the missing
  generated config prevents canonical stop. Restoring it allowed exact stop;
  provider status is `Stopped` and exact routes are empty.
- `2026-08-26`: Required planner review completed with
  `DONE_WITH_CONCERNS`; its fail-closed ownership classification is incorporated
  above. Implementation and fresh release verification remain pending.

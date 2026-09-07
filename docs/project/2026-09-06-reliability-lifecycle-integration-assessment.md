# Lifecycle integration and qualification readiness

Status: investigation complete; next execution package is not yet approved.

The reliability foundation is locally reviewed, but normal commands still use
the existing lifecycle paths. Agents do not yet receive enforced admission,
continuous observation, automatic recovery, or parked-task continuation. This
assessment identifies the integration work required before those claims can be
tested. It does not substitute another model-only package for live reliability.

## Current evidence

The parent verified the foundation worktree was clean before this assessment at
`fa1f2eaa037e430b8c9cdb27dcc2bb6f9ea3f011`, five commits ahead of
`origin/main`, with no upstream. Remote refs were refreshed successfully.
PR #56, reset-failure recovery, remains open at
`71aa5a8d33ea8966c76705e41273cb7d3d384b5e`; it targets main and owns
overlapping reconciler recovery behavior. No integration was performed.

| Integration seam | Verified source behavior | Required acceptance evidence |
| --- | --- | --- |
| Execution completion | `devsyExec` resolves a missing child exit code as `1`; `devpodExec` uses a private remote status marker and rejects missing completion. Both return a number through `runExecCommand`. | Distinguish a proven application exit from transport loss or local signal. Preserve completion uncertainty after possible dispatch, never replay, and keep ordinary proven exit codes compatible. |
| Stop versus startup or execution | `workspaceEnsure` and both execution adapters hold the workspace lifecycle lock through their operation. `environmentStop` delegates linked-owned workspaces and acquires that lock directly in its fallback. Options accepted by exported `workspaceEnsure` do not expose cancellation or expected reliability revisions. | Persist stop intent before waiting for busy startup or execution; recheck intent before provider actions and route publication. A delayed startup or rollback must not undo stop. Prove exact child ownership before interruption and retained state after interruption. |
| Durable effects | The new reliability model emits effect requests, but existing production lifecycle paths do not consume it. `ManagedRuntimeState` is the existing runtime-state authority, not a durable operation-dispatch journal. | Define one crash-consistent operation record and lock ordering, persist before possible launch, and reconcile uncertain workers without duplicate dispatch. Preserve repository ownership as the identity authority. |

The execution-completion observation is a source-level finding, not evidence
that the installed Devsy release mishandles a particular remote operation.
Its existing tests cover ordinary numeric completion, missing workspace, empty
command, and spawn failure; they do not cover a signaled child or ambiguous
transport completion. Provider behavior must be qualified before selecting its
completion protocol.

DevPod currently rejects local signal termination even after receiving a remote
status marker. The completion contract must settle conflicting evidence rather
than assume that either the marker or transport termination always wins.
The parent also verified that delegated `workspaceStopOwnedPath` enters
`mutateWorkspaceOwnedPath`, which acquires the same workspace lifecycle lock
before ownership checks, provider mutation, and route removal.
Existing managed repair acquires the workspace lifecycle lock before the
provider mutation lock; the intent writer must not invert this ordering.

## Next package boundary

Prepare one full execution plan for interruption-safe lifecycle integration,
covering the roadmap's safe-lifecycle stage. The first runnable path should
exercise real command dispatch and completion provenance; then connect durable
intent and cancellation to startup, stop, and route publication. Reuse the
foundation types and exact-owner primitives. Do not create a second lifecycle
implementation or silently change the role of the existing runtime-state file.

The execution plan must settle the following before implementation:

| Decision | Required resolution |
| --- | --- |
| Persistence and fencing | Exact record ownership/location, atomic-write and recovery semantics, intent writes independent of long lifecycle work, and ordering against existing provider and route locks. A dispatch record must never contain raw command arguments or environment values. |
| Compatibility and activation | Which existing calls supply explicit start versus attachment intent, how unenrolled one-shot clients retain their contract, and how managed callers invoke the new guarded path without an implicit host-service install. |
| Reconciler overlap | Coordinate the specific reset-failure changes in PR #56 before editing its recovery regions. Fetch does not authorize merging or rebasing either branch. |
| Qualification target | Name an isolated VM or runner, installed provider/runtime versions, fixture resource caps, authorized fault classes, and exact lifecycle cleanup. Provisioning requires an allowed location and spending cap if no target exists. |

Implementation decomposition: the main session owns persistence, authority,
activation, and cross-lock decisions because these are coupled. After contracts
are frozen, a bounded executor can own provider completion parsing and focused
tests; an independent reviewer covers the integrated dispatch/stop seam.
No new executor was launched for this investigation because the current source
mapping is small and its conclusions determine the architecture boundary.

The full plan must include bounded slices with exact paths, dependencies,
acceptance checks, stop conditions, and a Delegation Map assigning every slice
once. Record source and installed-build provenance, provider coverage, commands,
protected-neighbour invariants, and distinct activation, provisioning, fault,
and cleanup authority. This assessment is not that execution contract.

## Qualification progression

Use installed CLI tests with synthetic subprocess fixtures first. Prove
unambiguous completion, connection loss after dispatch, duplicate requests,
late startup after stop, retained files, and no duplicate action after worker
loss. Include stop during a long-running command. Missing prerequisites must
produce a distinct non-passing result.

Then run the same lifecycle cases on the named isolated provider target, with
one protected neighbour and synthetic retained data. Record cold start, warm
reuse, stopped resume, and failure recovery separately. Start with bounded
fixture process termination; container memory-pressure tests require explicit
fixture limits and the disposable target. Never induce host OOM or restart a
shared VM. Stop and verify the exact fixture runtimes after each live session;
deletion commands must be enumerated in that execution plan.

Full admission, continuous controller observation, resource parking, and
harness-enforced waiting remain subsequent integration obligations. Their
acceptance is the real two-environment agent journey in the roadmap, including
pressure and controlled resume. Source tests do not close that milestone.

## Authority and pending input

The completed approval authorized the source foundation, not this new runtime
integration package, host enrollment, consumer changes, or live faults. The
roadmap expressly requires a disposable qualification target. The user has
been asked to identify an existing target or specify provisioning authority
and a spending cap. No runtime was inspected, started, stopped, or modified
during this investigation. Read-only source investigation and plan preparation
remain authorized.

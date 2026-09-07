# Interruption-safe lifecycle integration

## Approval summary

Status: approved for source implementation on 2026-09-07. Architecture consultation
and planner review are complete. The user authorized execution through the source
package terminal condition with a goal.

Connect the reliability foundation to production ensure, exec, and stop paths.
Stop must record intent promptly, prevent stale startup from restoring routes,
and preserve unknown command completion without replay. Verify the installed CLI
with isolated synthetic providers throughout implementation.

Approval permits the exact local source and documentation edits below, local
commits, configured automated reviews, package builds, and synthetic child-process
tests. Tests may interrupt and terminate only children they create and own. They
may create temporary synthetic checkouts, configuration, package prefixes, and
provider fixtures. They must never reach real Docker, Devsy, DevPod, or Traefik.

Existing explicit commands gain durable interruption bookkeeping. Preserve proven
application exit codes and the existing nonzero failure convention. This is a
caller-visible safety change: uncertain prior execution blocks replacement until
positive evidence or explicit stop resolves it. No force-clear or automatic replay
is introduced. This approval does not enroll consumers in a host controller.

No dependency, daemon, global repository registry, release, push, merge, upstream
integration, live runtime change, provisioning, or OOM injection is included.
Capacity admission, parking, controller observation, and harness integration remain
later roadmap work. Passing this package is source and installed-fixture evidence;
it does not qualify real-provider reliability or OOM resilience.

## Contract and implementation decisions

### State and ownership

Persist the existing ReliabilityState and bounded worker/operation identity under
the existing Devrouter configuration root. Bind records to canonical checkout,
workspace identity, and provider identity; existing ownership records remain
identity authority. ManagedRuntimeState continues to describe runtime facts.
Neither record may substitute operation completion for workload and route proof.
Do not persist command arguments, environment, output, or credentials.

Reuse existing private atomic-write and file-lock primitives. Validate bounded
versioned records before mutation. After an ambiguous write, reread under the
record lock; no launch occurs without definite durable dispatch acknowledgement.
If ambiguity remains, retain the reservation and completion-unknown state.

### Foundation extension for manual commands

Introduce contract version 2 with an explicit execution policy of manual or
capacity-managed. Policy is selected when a record is created and is immutable
for that record. Existing enrolled semantics remain capacity-managed; ordinary
unenrolled commands use manual authority. Unknown versions fail closed. No existing
version-1 persisted record is silently rewritten or enrolled; version 1 was the
source-only foundation and remains separately documented.

Manual authority permits explicit user-requested lifecycle effects without
inventing an admitted resource measurement. Represent admission as not-applicable
for manual records; no host reservation is asserted, and capacity projections must
report unmanaged rather than admitted or available. Capacity-managed records retain
all existing admission, charge, parking, and resume gates. Manual records reject
automatic parking and recovery actions. Full-stop proof remains mandatory in both
policies, independently of whether a host capacity charge exists.

Separate the current environment intent from a new explicit operation request.
Each operation has a kind (ensure or exec), an immutable request identity, and its
existing dispatch/completion state. A repeated request identity joins or reports
that same operation, including after completion; it never launches it again.
A new operation can replace the current slot only after definite terminal evidence,
never after completion-unknown or while a claimed worker may remain active.
Retain bounded request/result tombstones; on exhaustion fail closed instead of
silently forgetting deduplication history. No unbounded operation registry is added.

Repeated explicit ensure may reconcile the same running environment as a new
operation after the prior operation safely finishes. It does not implicitly
restart or change runtime generation. Exec submits a new operation against an
exact already-running environment; it cannot change stopped or parked intent to
running. Attachment itself still only joins an existing operation. Explicit stop
advances intent and fences every earlier operation; a later explicit ensure can
establish new start intent only after old work is conclusively drained.

Each CLI invocation creates one request identity before worker launch and retains
it across its internal coordination; separate user invocations are separate
requests. Concurrent distinct operations remain serialized or rejected while the
current operation is active. No command-argument hashing, implicit idempotency
between distinct invocations, or new public retry flag is introduced.

Version-2 contract/model/projection tests must cover manual ensure, repeated ensure,
successive exec, duplicate identity after completion, stop ordering, unknown prior
completion, bounded history exhaustion, and unchanged capacity-managed gates.

### Supervisor, worker, and locks

Use an asynchronous invocation-owned supervisor and a packaged child worker around
existing synchronous lifecycle operations. This is a bounded command process, not
a background service. The worker itself owns the lifecycle lock, so supervisor
loss cannot release serialization while the worker still mutates resources.
Use an owned IPC channel for request/result and cancellation coordination.

A short record lock serializes intent and effect claims. Never wait for lifecycle
or provider work while holding it. Retain lifecycle-before-provider lock ordering.
Stop writes a new stopped-by-user intent revision before waiting for old work.
Before each new provider effect, route publication, or rollback restoration, the
worker checks current fences and durably claims that effect.

Stop wins if its intent precedes the claim. A claim preceding stop remains
potentially in flight even if actual dispatch starts later. Stop must drain that
claim and fence subsequent effects before acknowledging completion. A check alone
cannot revoke a claimed action. No replacement worker dispatch occurs while old
work may remain active.

Cancellation uses owned child handles or a verified process incarnation. A PID,
dispatch UUID, deadline, or transport exit alone is insufficient. Supervisors may
signal their own children cooperatively and terminate them after a bounded grace
period. Such termination records uncertainty until exact provider and route proof
is available. A separate stop invocation may record intent and request cooperative
cancellation; it must not kill a process from an unverified journal PID.

### Caller behavior and evidence

Explicit ensure is start intent. Exec attaches to the already-running exact
workspace and never starts it. Explicit stop records stopped-by-user intent and
performs existing ownership-proven teardown. Existing workspace aliases must use
the same boundary without double-locking or a bypass. No automatic drain or stop
is performed by attachment or read-only recovery.

A validated operation-specific remote marker proves the application result even
when transport later fails; retain transport failure separately. A missing local
exit code is completion-unknown, not a fabricated application exit. Preserve
proven provider numeric results where the provider contract supplies them. Do not
introduce a new public exit code or require unqualified markers across providers.

Full stop requires positive workload cessation and exact route removal, plus proof
that earlier workers can no longer publish or mutate. Preserve ownership and
generated configuration whenever exact runtime absence is unproven. A completed
command, successful stop invocation, or expired timeout cannot release capacity.

## Execution details

### Baseline and coordination

Work in `/Users/rschlae/Git/personal/devrouter/trees/rs/reliability-contract-foundation`,
branch `rs/reliability-contract-foundation`, no upstream. On 2026-09-07, remote refs
were refreshed: HEAD `fa1f2eaa037e430b8c9cdb27dcc2bb6f9ea3f011` is five commits ahead
of origin/main and none behind. Preserve the primary-checkout user roadmap.

The recorded open [reset-failure recovery PR](https://github.com/rschlaefli/devrouter/pull/56)
overlaps ensure rollback. Read its current diff and coordinate overlapping regions
before editing; this does not authorize merging or rebasing it. Preserve existing
retained-state behavior and test assertions.

### Exact source manifest

Paths are relative to the task worktree. Add files only when their stated boundary
requires them; omit unused proposed files rather than adding scaffolding.

| Boundary | Permitted files |
| --- | --- |
| Command integration and worker distribution | `src/commands/ensure.ts`, `src/commands/stop.ts`, `src/commands/exec.ts`, `src/commands/workspace.ts`, new `src/lifecycle-worker.ts`, `tsup.config.ts` |
| Foundation extension | `src/core/reliability-contract.ts`, `src/core/reliability-model.ts`, `src/core/reliability-output.ts`, `src/core/__tests__/reliability-contract.test.ts`, `src/core/__tests__/reliability-model.test.ts`, `src/core/__tests__/reliability-output.test.ts` |
| Operation persistence and supervision | new `src/core/reliability-operation-store.ts`, new `src/core/reliability-lifecycle.ts`, new `src/core/reliability-worker.ts` |
| Production mutation and result boundaries | `src/core/devpod-exec.ts`, `src/core/devsy-exec.ts`, new `src/core/execution-outcome.ts`, `src/core/workspace-ensure.ts`, `src/core/environment-stop.ts`, `src/core/workspace-lifecycle.ts`, `src/core/devpod-mutation.ts`, `src/core/devsy-mutation.ts` |
| Focused tests | `src/commands/__tests__/ensure-stop.test.ts`, `src/commands/__tests__/exec.test.ts`, `src/core/__tests__/devpod-exec.test.ts`, `src/core/__tests__/devsy-exec.test.ts`, `src/core/__tests__/workspace-ensure.test.ts`, `src/core/__tests__/environment-stop.test.ts`, `src/core/__tests__/workspace-lifecycle.test.ts`, new `src/core/__tests__/execution-outcome.test.ts`, new `src/core/__tests__/reliability-operation-store.test.ts`, new `src/core/__tests__/reliability-lifecycle.test.ts`, new `src/core/__tests__/reliability-worker.test.ts` |
| Installed qualification | new `scripts/qualify-lifecycle.ts`, `scripts/package-smoke.sh` |

Existing atomic-file, runtime-state, ownership, and workspace lock primitives are
read-only dependencies. No generic subprocess rewrite is
planned. Broaden the manifest only for demonstrated necessity consistent with this
contract; a material contract or authority change requires a user ruling.

### Documentation manifest

Update this plan, the integration assessment, `docs/project/index.md`,
`docs/adr/0008-model-reliability-before-runtime-activation.md`, `docs/DEVCONTAINER.md`,
`docs/knowledge/change-and-verification-map.md`, `.agents/skills/devrouter/SKILL.md`,
and `src/core/ai-prompt.ts` only for implemented semantics. Historical foundation
verification remains separate. Product manuals must describe current behavior,
not future admission or recovery claims. Advisor summary remains the exact approved
payload; its original status is historical.

### Delegation and commit boundaries

| Slice and purpose | Owner | Acceptance |
| --- | --- | --- |
| Manual operation contract | Main | Version-2 authority and operation separation, with capacity-managed regressions preserved. |
| Execution provenance | Configured executor | Preserve proven outcomes and distinguish transport ambiguity with focused tests. |
| Durable lifecycle integration | Main | Production calls consume foundation transitions; deterministic stop races, no replay, coherent retained state. Main owns coupled locks and authority decisions. |
| Installed qualification and closeout | Main | Packaged worker and CLI execute synthetic fixtures; configured independent reviews and applicable repository checks pass. |

Each substantive slice receives its configured simplifier and risk-selected slice
reviewer after the local commit. The integrated source package receives a final
reviewer after checks. Correct findings and repeat only affected verification.
No new peer task is created. Local conventional commits are authorized by approval
of this plan; external publication is not.

## Verification and terminal condition

Use pinned Node 24.16.0 and pnpm 11.6.0. Run focused tests after each meaningful
change. Run repository docs-policy, knowledge, Biome, Knip, typecheck, unit tests,
build, and package smoke for the integrated source. Run the existing process tests
where supported; report Linux-only gaps rather than marking skips as passing.
Run bounded changed-code security checks using existing tooling; no broad audit.

The new qualification invocation is `node --import tsx scripts/qualify-lifecycle.ts`.
It packages and installs into a temporary prefix, then invokes the installed CLI
and sibling worker from a synthetic checkout. Record source revision and dirty-tree
status, tarball and binary digests, pinned tool versions, and fixture version.
Clean-tree qualification after the source commit supplies final source provenance.

Use fake provider executables that fail closed on unexpected commands, isolated
configuration, synthetic identities/data, and no real provider sockets or network.
Use deterministic subprocess barriers around persistence, effect claim, provider
return, rollback, and publication. Never use sleeps as evidence of race ordering.
The installed tests must prove actual production consumption of reliability state.

| Behavior | Required observable evidence |
| --- | --- |
| Dispatch and ambiguity | Concurrent duplicate identity launches at most once; failures before and after persistence never silently replay; corrupt or uncertain records fail closed. |
| Stop races | Stop before claim prevents launch; stop after claim drains it; delayed provider return, publication, and rollback cannot undo stop. |
| Process loss | Supervisor/worker loss preserves serialization and uncertainty; owned fixture child cleanup is verified; no PID-only signaling or replacement of possibly active work. |
| Outcome provenance | Application success/failure, spawn failure, missing completion, and marker/signal conflict remain distinguishable internally while CLI compatibility is preserved. |
| Retention and isolation | Generated files remain when absence is unproven; full stop requires both workload and route evidence; an independent synthetic neighbour remains functional. |

Missing prerequisites or a failing fixture are non-passing. No host OOM, shared-VM
restart, real provider fault, or runtime cleanup is permitted by these tests.

Terminal condition for this package is committed, independently reviewed source
plus passing installed synthetic qualification and an honest evidence report.
Real-provider qualification remains pending until the user names a disposable
target or provisioning location and spending cap, followed by an exact permitted
fault and cleanup manifest. The overall reliability roadmap remains incomplete.

## Progress

Active: manual operation contract. Route: main; architecture and lifecycle seams
are coupled. Acceptance: focused reliability contract/model/projection tests and
typecheck, followed by committed simplifier and slice review. The execution
provenance slice remains assigned to the configured executor after contract freeze.
Remaining: durable production integration, installed synthetic qualification,
independent final review, and source-only closeout. No publication or live-runtime
work is authorized.

The source foundation passed 1,008 tests and independent review before this
package. Those results do not verify future integration. The permission retry
and planner challenge are recorded below; no implementation has begun.

### Approved advisor retry, 2026-09-07

The user explicitly approved sharing the saved summary. The same isolated AGY
route then completed with exit code 0, provider status SUCCESS, and terminal
DONE_WITH_CONCERNS. The permission blocker is resolved. The local receipt is
`/private/tmp/devrouter-lifecycle-advice/approved-result.json`; the consultation
used `gemini-3.8-flash-high`, plan mode, sandbox, and disabled slash commands.
No additional repository files were supplied.

Parent disposition preserves the existing foundation and repository contracts:

- Accept short durable intent updates, conservative ambiguous completion, no
  replay, and independent application versus transport evidence.
- Reject the alternate state directory: machine state remains under the existing
  Devrouter configuration root. Reuse foundation states and fences instead of
  adding the advisor's parallel generation/state vocabulary.
- Reject STOPPED inferred from an idle or completed operation. Workload cessation
  and route removal require separate positive proof, including after cancellation.
- Reject signaling based on a recorded PID or a dispatch UUID alone. Cancellation
  needs a verified owned process incarnation; transport death never proves remote
  cessation. Timeouts never release capacity or authorize replacement.
- Reject automatic provider-stop mutation during attachment or recovery without
  corresponding intent and ownership authority. Preserve retained generated
  configuration whenever exact runtime absence is not proven.

The advisor did not close the dispatch-versus-stop race between releasing the
record lock and entering the provider. The final protocol must explicitly treat
that effect as already claimed and drain it before acknowledging full stop.
Its broad claim that asynchronous subprocesses cannot be safely cancelled is
not evidence; cancellation scope and process identity remain the deciding facts.
No suggested forced cleanup command or new exit code is adopted by this receipt.

A native planner is challenging the bounded integration package and remaining
user decisions. Implementation and live qualification are still pending.

Planner Descartes (`01a07a90-4d5f-7611-b5ab-d3785d100a48`) returned
DONE_WITH_CONCERNS. The parent accepted worker-owned lifecycle locking, separate
source versus live qualification, existing exit-code compatibility, and explicit
manifest requirements. The same planner performed a bounded final consistency check.

The planner identified that version 1 cannot express repeated manual ensure and
successive exec while retaining admission gates. The parent therefore specified
the explicit version-2 extension above and added the exact foundation paths. This
is part of the proposed approval scope, not authority already granted.

Final planner result: DONE, ready to present for source implementation approval.
Documentation policy and knowledge validation pass. No source files changed and
no runtime or installed-fixture qualification was run during plan preparation.

### Manual operation contract implementation

Version 2 now distinguishes manual execution from measured admission and retains
bounded operation results across successive calls. New operation dispatch requires
worker drainage; explicit stop still requires workload and route proof. Initial
exec may adopt an already-running exact runtime when no prior intent exists.
The focused suite passes 63 tests (8 added); TypeScript and changed-file Biome
checks pass on Node 24.16.0. Required simplifier and slice review are next.

OpenCodex readiness returned ready=true on 2026-09-07; configured executor
dispatch is available for the next settled provenance slice.

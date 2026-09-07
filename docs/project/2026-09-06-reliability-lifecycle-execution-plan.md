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
caller-visible safety change: uncertain prior arbitrary command execution blocks replacement until
positive evidence or explicit stop resolves it. No force-clear or automatic replay
is introduced. This approval does not enroll consumers in a host controller.

No dependency, daemon, global repository registry, release, push, merge, upstream
integration, live runtime change, provisioning, or OOM injection is included.
Capacity admission, parking, controller observation, and harness integration remain
later roadmap work. Passing this package is source and installed-fixture evidence;
it does not qualify real-provider reliability or OOM resilience.

## Automatic recovery amendment, 2026-09-07

The user explicitly replaced the degraded-state refusal default: ordinary ensure
must repair and continue startup without requiring a separate repair command.
This source amendment is approved by that instruction. No live-provider or OOM
execution authority is added.

Within the existing lifecycle lock, inspect retained degraded state before normal
startup mutations. For an existing or unproven-absent exact Compose project, run
one existing non-destructive repair of the recorded profile, with unchanged
provider locking, retained ownership checks, and stop fences. Resolve the desired
profile independently and apply any differing transition only after repair proves
ready. Keep both stages in the same worker and request; no recursive public call.
Explicit --repair keeps its current recorded-profile diagnostic behavior.

Preserve the existing positively-proven missing-project recovery path. It may
rebaseline after exact absence, but an inspection failure never proves absence.
This preserves current safe startup behavior; it adds no deletion, recreation,
resource adoption, or volume reset. Do not turn missing evidence into permission.

A new ensure may reconcile a drained interrupted or never-dispatched ensure while preserving its
unknown historical result and deduplication identity. Possibly-active workers,
unknown arbitrary exec, pending stop, corrupt journals, and history exhaustion
still require resolution. Never silently replay an arbitrary command. Recovery
within explicit start intent does not activate capacity-managed automatic recovery.

Repair failure retains diagnostic state and ends the bounded attempt. A failed
subsequent profile transition rolls back to the successfully repaired baseline.
Test automatic same/different-profile recovery, interruption reconciliation,
retention, stop fencing, and unchanged explicit-repair behavior. Main owns these
coupled lifecycle decisions and final proof; no independent implementation seam.

Planner Schrodinger reviewed this amendment and returned DONE_WITH_CONCERNS.
Accepted recorded-profile-first repair, narrow ensure-to-ensure reconciliation,
no arbitrary exec replay, and existing locks/fences. Parent retains the existing
positive-absence rebaseline behavior rather than adopting the suggested blanket
missing-resource refusal. Required tests must preserve its exact-absence gate.

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
never after unknown arbitrary exec or while a claimed worker may remain active.
The automatic recovery amendment permits a new ensure after interrupted ensure
only when the previous worker is positively drained.
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

Delivery update, 2026-09-07: the user's revised repository instructions authorize
ordinary task-branch pushes and draft PR delivery. The reviewed package is now
[draft PR #58](https://github.com/rschlaefli/devrouter/pull/58), targeting main.
CI [run 34111935696](https://github.com/rschlaefli/devrouter/actions/runs/34111935696)
passes on 0edbe60af42d9927c68158f84c778ef598981ee4; publishing was skipped.
The branch-history Gitleaks scan passes. Remote fetch and task-branch push now
succeed with scoped sandbox escalation. No merge, release or machine enrollment
has occurred. These current facts supersede the historical delivery restrictions
and SSH failure recorded below.

The active roadmap goal continues with eLearning at
`/Users/rschlae/Git/tc/elearning/trees/rs/reliability-canary`, on branch
`rs/reliability-canary` from fc0e48825cfc81591e725d2927f5293dbdc3d44b.
The isolated checkout is created, but no canary runtime has started. Source-path
doctor reports Devsy 1.16.2 and its verified ARM64 agent ready, Docker 29.4.0,
and Compose 5.1.2. Consumer readiness, synthetic data, preparation and resource
caps are under the next planning review; no OOM resilience claim is added.

Complete for the approved local source package. Final implementation is
f49ef002fb04bc89e93f3d1514401ad7027d710b. Ordinary ensure repairs retained degradation,
resolves implicit full profiles, and preserves generated configuration after uncertain
managed startup. Execution outcomes persist atomically; proven zero-launch failure
permits the next operation after worker drainage without stopping the environment.

The final reviewer passed the complete lifecycle package after one correction.
All 1,055 unit tests and 24 clean-source installed synthetic scenarios pass.
Package smoke, typecheck, formatting, Knip, docs/knowledge checks, Gitleaks and
bounded changed-code scanning pass. Linux /proc helper tests remain skipped on macOS.

This completes the source goal, not the original extended roadmap. No publication,
live-runtime change or OOM injection occurred. Real-provider recovery, capacity
admission, parking, controller observation and consumer-harness qualification remain
later work. The next live qualification requires a named disposable target,
provisioning location, memory cap and exact fault/cleanup manifest. Remote refresh
remains unavailable because the SSH agent refused signing; no upstream integration
or publication was attempted.


Historical preparation and review receipts follow.

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

Manual contract review found one identity mismatch: capability/pinning payload
was omitted from manual deduplication. The correction retains and compares the
full bounded consumer, including historical operations; one regression added.
Both redundant capacity comparisons identified by the simplifier were removed.
The same slice reviewer will check the correction; parent retains production
integration. Durable-record work currently passes seven synthetic filesystem tests.

### Execution provenance implementation

The configured executor supplied outcome-returning provider adapters while retaining
numeric wrappers. DevPod remote markers survive later signal/transport loss;
missing Devsy completion is typed unknown. The parent reviewed streaming bounds
and changed post-spawn errors to unknown rather than not-started. 29 focused
provider tests and typecheck pass. Provider execution was mocked; installed and
real-provider qualification remain outstanding.

Implementation dependency: export the existing processBirthIdentity helper from
`src/core/file-lock.ts` without changing its behavior. The worker needs the same
portable process-incarnation proof as lifecycle locks; reusing it avoids a second
identity algorithm. This adds that exact file to the manifest and preserves the
existing file-lock test suite as its verification. No lock semantics change.

The route publication seam also requires `src/core/route-publication.ts`: claim the
final publication after asynchronous infrastructure preparation, so stop fences
that write independently. Linked identity is claimed with the existing resolver
before opening a journal, avoiding first-use collision identity drift. Worker
identity is journaled only after its owned IPC readiness handshake and before
dispatch. A pre-handshake crash therefore cannot leave an unresolvable PID-less
worker reservation. No request reaches a worker before this durable boundary.

Installed dirty-tree fixtures now pass exit preservation, marker-plus-signal,
unknown-completion replay refusal, full stop, concurrent stop during execution,
successive Devsy exec, and corrupt-journal refusal. The journal retains a bounded
current typed outcome with separate transport metadata, never arguments/output.
`src/core/traefik-route-health.ts` also needs an effect claim immediately before
its delayed restart, so stale readiness recovery cannot mutate shared routing.
These findings broaden only the exact mutation-claim manifest, not authority.

Full-suite integration exposed import cycles when low-level mutation modules
loaded the entire lifecycle coordinator. New `src/core/reliability-context.ts`
holds only the worker-installed synchronous claim callback; it imports no runtime
modules. Mutation helpers use this leaf, preserving their existing dependency
boundary and avoiding unrelated test/configuration dependencies.

Add `package.json`'s `qualify:lifecycle` script for the approved qualification
invocation, making it discoverable to users and Knip. No dependency changes.

Generated skill distribution has an embedded copy in `src/core/agents-md.ts`;
update the same recovery guidance there. Its existing `agents-md.test.ts` failed
because the two copies diverged. Replace incidental prose-pinning assertions
with generation, sentinel, idempotency, and user-content preservation checks.
These two exact files join the guidance manifest; no new distribution system.

### Integrated manual lifecycle slice evidence

Source integration now includes private bounded journaling, worker-owned locking,
pre-dispatch persistence, effect fencing, exact stop proof, and workspace aliases.
Seven coordinator tests and seven journal tests pass. The full unit run passed
1,037 tests and found one stale embedded guidance copy; that copy was synchronized
and all eight guidance tests pass. The final identity recheck passes 41 affected
coordinator/alias tests. Biome, Knip, typecheck, docs policy, knowledge validation,
build and installed package smoke pass. Linux process-helper tests are skipped on
macOS because `/proc` is unavailable; that acceptance gap remains explicit.

Installed dirty-tree qualification proves nine behaviors, including successive
ensure and exec, marker/signal precedence, unknown replay refusal, concurrent stop,
corrupt records, and supervisor loss with retained serialization. Its status remains
partial until the remaining source-plan qualification matrix is covered. The fixture
uses closed provider executables, an isolated Docker API Unix socket, private
homes and synthetic data. No real-provider or OOM proof has been performed.

### Interruption correction and recovery steering

Local correction d62efdb preserves original worker ownership on duplicate dispatch
and records interruption on worker loss without a result. All 1,044 unit tests
pass; installed fixtures cover fourteen cases, including persistence failures and
worker loss with a still-active provider group. Linux /proc checks remain skipped.
The same slice reviewer is checking that correction. Automatic retained repair is
now the active source amendment; installed qualification and final review remain
incomplete. No live provider has been touched.

Automatic-recovery implementation now passes the ordinary same-profile repair
check and fifty focused contract/coordinator/guidance tests. The installed CLI
passes seventeen synthetic cases, including interrupted startup followed by
successful ensure without explicit stop. The prior unknown result stays retained.
A separate test worker owns transition/rollback tests; a fixture worker owns the
new isolated managed-recovery qualification helper. Main owns production changes.
Both scopes are synthetic and exclude real providers.

The active managed-lifecycle knowledge concept still described degraded state as
a mandatory refusal. Add `docs/knowledge/managed-environment-lifecycle.md` to the
documentation manifest and synchronize that owning concept with automatic repair.
No unrelated concept or new knowledge bundle is introduced.

The managed-fixture executor was stopped after a narrowing checkpoint still yielded
only read-only discovery and no artifact. Main resumed the fixture in the existing
qualification script; the proposed separate helper is omitted. Native activity
was live, so this is a progress-contract fallback, not a provider-availability claim.

Installed managed recovery exposed a canonical-profile round-trip bug: implicit
full startup was persisted as `full`, but repair rejected that name when no profile
was declared. Add `src/core/repo-config.ts` and its existing test file to this
amendment's exact source manifest. Resolve the implicit full profile by name while
preserving explicitly declared profiles; this enables recorded-profile repair.
The installed no-profile fixture is the regression, supplemented by resolver
round-trip coverage. No new configuration file, dependency or runtime authority.

Installed qualification also reproduced native DevPod partial-start configuration
loss. When managed startup returns nonzero, the provider now invalidates cached
observations and reports a possibly-started result so rollback retains generated
configuration. Unmanaged startup behavior remains unchanged. Installed qualification
proves retention and independent neighbour execution before and after exact stop.
All 1,053 unit tests pass; Linux process-helper checks remain skipped on macOS.

The automatic-recovery slice reviewer completed 89ebad9..70f3fef with no blocking
findings. Accepted both minor documentation clarifications: never-dispatched ensure
reconciliation and retained degraded state after managedRuntime configuration removal.
The implicit full-profile and native partial-start corrections were found by installed
qualification after that immutable range and require their own source review.

The installed synthetic matrix now passes 23 scenarios, including a deterministic
stop after route publication while readiness is in flight. The fixture reports
its own passed scope explicitly and never claims live-provider or OOM qualification.
Source review and clean-tree qualification remain pending. Remote refresh on this
continuation failed because the SSH agent refused signing; the last fetched
origin/main remains 14 commits behind this task branch with no target-only commits.
No remote integration or publication has occurred.

### Clean-source installed qualification

`pnpm qualify:lifecycle` passed from clean source
`311d1a5a6d6aeee9a24878af6a6635f49eba50f9`, using Node v24.16.0,
pnpm 11.6.0 and fixture version 2. The result scope is
`installed-cli-synthetic-providers`; live-provider and OOM qualification are false.

| Acceptance | Passing observation |
| --- | --- |
| Dispatch and ambiguity | Duplicate IPC and concurrent shared identity launch once; pre/post-persistence failures never replay; unknown completion and corrupt journals preserve uncertainty. |
| Stop races | Stop before dispatch prevents launch; stop after claim drains it; delayed infrastructure return and cancellation after publication cannot restore stopped routes. |
| Process loss | Supervisor loss retains serialization; worker loss with a live provider group prevents replacement; exact fixture group drainage permits stop completion. |
| Outcome provenance | Numeric failure, marker success plus transport signal, EACCES spawn failure and unknown completion remain distinguishable. |
| Retention and isolation | Ordinary ensure repairs a degraded implicit-full runtime without provider bootstrap; failed managed provider startup retains generated config; exact stop preserves a neighbour's journal and command execution. |

The packed tarball SHA-256 is
`2d3dc92b271b7c788d83801762a1c28fc1e41705c443dccf09ca381a3c3a3423`.
The CLI SHA-256 is
`9f187593e38eea6ecf2d06f74ac1f70fbcfc0e16aadce6ea438f43995cd87f41`.
The worker SHA-256 is
`ca980b214dc897ce8ba6cd808a10dbf962176d20859a66c6d1c1b0acc9b2db72`.
The isolated temporary fixture is `qualify-lifecycle-olQVDD`. Every launched CLI
completed; deliberate process-loss cases retain ownership until fixture drainage
is proved. No real provider, shared Docker socket or OOM workload was used.

Opengrep ran 210 applicable rules on the two recovery-correction production files
with zero findings. Earlier integration scanning covers the other changed production
files. Linux process-helper validation remains skipped because this host has no /proc.

Correction simplifier completed with one net-reduction suggestion. The implicit-full
selection now reaches the existing final result rather than duplicating it. All 101
profile tests pass; existing no-default comment and behavior are preserved. This is
a behavior-preserving reduction; clean-source installed qualification is rerun after
its commit because the emitted binary changes.

### Integrated final review correction

Final reviewer Godel found one medium issue: typed execution outcome and lifecycle
completion were separate writes, and a proven zero-launch failure was treated as
unknown completion. Both could needlessly require full stop before more work.
The correction writes outcome and matching transition in one journal transaction.
A manual exec with proven zero launch records NOT_LAUNCHED with no fabricated exit
code. It cannot dispatch again and permits a different operation only after positive
worker drainage. A never-dispatched drained operation is likewise safe to replace.
Unknown completion retains its explicit-stop gate; pending stop still wins.

This extends the existing unreleased version-2 operation enum and manual-only event
within the approved contract source manifest. No live record migration or provider
change occurs. All 1,055 unit tests pass, including failure after atomic rename but
before acknowledgement and zero-launch evidence with a still-active worker group.
Installed qualification now also runs a successful command after a proven spawn
failure without stopping the environment. Same-reviewer correction is pending.

### Final correction qualification

The same final reviewer passed complete range
fa1f2eaa037e430b8c9cdb27dcc2bb6f9ea3f011..f49ef002fb04bc89e93f3d1514401ad7027d710b
with no remaining findings. The correction retained stop precedence and worker
ownership while removing unnecessary full-stop requirements for definitive outcomes.

Clean source f49ef002fb04bc89e93f3d1514401ad7027d710b passed all 24 installed scenarios
on Node v24.16.0, pnpm 11.6.0 and fixture v2. The final tarball SHA-256 is
`c8d04db88c0c640b3feab38bcd811f1a6ed45e2b4b033ccc04ca7e14ad6e56db`.
The CLI SHA-256 is
`175ee6ac0b590b8183677f043b74c71794473fd9a7231f04ff3be557bef875df`.
The worker SHA-256 is
`d6adfea40686e4fb93e02e1eb1e4683f98cc177c9c03a679ffb0e83d0129f19d`.
The temporary synthetic fixture is `qualify-lifecycle-nVNrHI`; the receipt explicitly
sets live-provider and OOM qualification to false. Subsequent changes only record
this completion evidence and do not alter the tested executable content.

### Readiness continuation checkpoint, 2026-09-07

Resumed the existing active goal and preserved the in-progress readiness changes.
Remote refs were refreshed with host permissions after the sandbox denied writing
Git FETCH_HEAD. The task baseline db893a3 is 19 commits ahead of origin/main,
with no target integration performed. The isolated eLearning branch is one commit
ahead of origin/main at e47a0fed; its primary checkout remains untouched.

The readiness implementation passes typecheck, Biome, Knip, documentation policy,
knowledge validation, build and installed package smoke. All 1,088 existing and
updated tests pass with host permissions. The sandbox run failed process identity
checks used by ownership locks; host execution resolves those failures. Linux
process-helper tests remain skipped on macOS and must be exercised on Linux.

Added and passed an observed HTTP 503 regression proving that application failure
retains routes and the runtime without recreation. Two additional synthetic tests
use actual curl and a loopback server to verify media matching, redirect refusal
and a bounded stalled response. These pass independently; their server is stopped
after the run. No real consumer runtime or OOM workload was started.

The schema/probe executor completed its assigned paths with passing focused checks.
Planner Bohr retains the second canary-plan review; no verdict has arrived. The
frozen draft remains /private/tmp/devrouter-elearning-canary-plan.md and review
provenance is in the ignored local reviews directory. Do not duplicate this reviewer.
Before consumer startup, finish that review and remove automatic content seeding
from the isolated canary preparation path under the reviewed synthetic-data contract.
Packed lifecycle application-failure qualification, consumer resource verification,
the learner journey, warm preservation and Linux helper proof remain outstanding.

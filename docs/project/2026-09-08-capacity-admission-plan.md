# Capacity admission execution plan

Status: approved source sequence; native plan hardening APPROVED on round 3.
Owner: main. Branch: rs/capacity-admission. Target: main.
Baseline: 0db64c1a89e58d67b71e9686e849f41db6c721a7.

## Outcome and authority

Enrolled canonical ensure and exec must obtain durable all-domain capacity
reservations before dispatch. Stop bypasses admission. Preserve existing manual
behavior for non-enrolled environments. Deliver one reviewed, CI-green draft PR.
This package precedes bounded recovery and harness integration under the existing
roadmap goal; its delivery is not completion of that goal.

The user authorized source work, isolated fixtures and eLearning start/work/stop.
Machine policy activation requires measured, reviewable contents and bounded
approval. No service installation, data deletion, host OOM, shared VM restart,
paid infrastructure, automatic preemption or uncertain-command replay.

## Binding contracts

Reuse existing environment identity, session, operation journal, lifecycle worker
and controller. Extend operation coordination and create domain reservation policy.
Repository capacity estimates cannot grant machine enrollment. Operator policy
lives at the existing Devrouter home under controller/capacity-policy.json.
Persist managed enrollment in the journal so policy removal cannot bypass gating.
Conversion requires positive stopped and drained proof; retain manual record compatibility.

Repository capacity version 1 declares exact profile combinations with host and
runtime steadyBytes/startupTotalBytes (safe nonnegative integers, startup >= steady,
runtime steady positive) and named operation host/runtime increments. Operator
policy pins reviewed estimate digests, domains, protected headroom, slots and
qualified telemetry interpretation. Zero host charge requires explicit qualified
interpretation. Runtime domain binds daemon identity, not context display names.

Domain charge is unmanaged + shared + sum(max(observedOwned, reservedTotal)).
Startup total includes steady; operation increments add once. Full exact-owned
siblings count. Host VM charge and guest containers occupy independent domains.
Unknown or stale evidence prevents new dispatch; possibly-live charges never
expire merely with a lease. Collect telemetry outside transaction locks.

Controller owns accepted requests, transient bounded argv, and worker supervision.
Client wait expiry returns a non-success pending result with durable operation ID.
Reconnect observes the same operation; it never resubmits a command. Queue lifetime
is separately bounded. Lost payload after restart is NOT_STARTED only with positive
dispatch absence. Otherwise preserve uncertainty. Drain output with bounded buffers
and report gaps; never persist raw argv, environment or output in records.

Persist pending journal intent, reserve all domains atomically, bind reservation
and policy revision to journal, then dispatch using the existing supervisor.
Crash gaps retain excess charge rather than authorizing unreserved launch.
Preserve workspace lifecycle -> provider mutation -> short journal lock order.
Scheduler transactions acquire none of those locks and never surround provider
work. Pre-effect validation consumes fresh collected evidence without waiting for
capacity inside lifecycle/provider locks. Failed validation unwinds; only positive
never-launch and drainage proof allows requeue. Stop intent remains writable
without controller availability. Settlement follows the phase-specific evidence rules below.

Use bounded FIFO, initially one startup and one heavyweight slot per domain.
Proposed bounds: 32 queued/domain, 64 total, 900-second queue lifetime, 300-second
default caller wait capped at 900, 30-second IPC watch windows, 5-second sampling,
15-second maximum sample age. These are source defaults, not live memory thresholds.

## Ownership and acceptance

Executor owns strict policy/estimate parsing and focused schema tests. Main owns
controller/journal/provider integration and admission architecture. Executor owns
packed qualification and owning documentation once integration is stable.
Planner Rawls 01a07e33-a445-7d70-855f-0c8a3a39dfb5 constructed the current draft;
resume the same planner for hardening. Independent reviews remain required.

First executable tracer: two packed CLI clients call real production launch paths
against synthetic providers; one starts, another waits and returns its durable ID
at deadline, exact stop frees capacity, then waiting work starts once.
Extend to multi-domain atomicity, startup-total arithmetic, operation increments,
endpoint aliases, complete siblings, stale telemetry, crash-retained charges,
stop-before-dispatch, provider-lock delay, partial stop evidence, reconnect and
payload loss. Verify actual launch counters. Preserve manual command tests.
Run repository checks, Linux lifecycle tests, packed CLI and controller qualifiers;
wire capacity qualifier into CI only after a successful producing run.

Update onboarding, devcontainer and affected knowledge authorities, bundled skill,
AI prompt, Unreleased changelog and a new admission ADR. Release artifacts remain
outside this source package. Use synthetic fixture identities only in public files.

## Operation and supervision contracts

Missing or unknown operation names use a required operator-approved conservative
default increment and consume a heavy slot. The default covers at least the largest
reviewed named increment in each domain. No shell-text heuristic grants capacity.

Track active and requested profile sets independently. Compatible expansion waits
while retaining current resources. Optional transition total estimates cover both
steady profiles; absent estimates use source steady plus destination startup total.
Consumer capability requirements veto incompatible contraction. Partial transition
failure retains observed allocation and reservation until evidence allows settlement.

Public operation records expose operationId, phase (queued, dispatching, running,
terminal), nullable outcome (NOT_STARTED, COMPLETED, INTERRUPTED,
COMPLETION_UNKNOWN), reason and nullable exitCode. Preserve existing internal
never-launch states. Pending is not a terminal never-started result.

Startup excess settles after preparation/worker drainage and complete reconciliation;
operation increments settle after exact command cessation; steady charge settles
only after full stop proof. Application completion and command cessation differ.

Retain synchronous effect claims. They validate a bounded private atomically
published reservation snapshot locally: reservation, environment, operation, worker
incarnation, intent/runtime fence, controller epoch, policy revision, endpoint and
sample age. They do no IPC, collection or capacity wait. Missing/stale/invalid proof
throws before effects. Once dispatch is possible the charge cannot be reassigned
until positive never-started/drainage or cessation proof. Stop bypasses this check.

Extend the existing supervisor with explicit controller supervision: piped per-worker
output with bounded buffers and gaps, one controller shutdown handler, bounded exact
worker registry, independent client detach, terminal listener/timer cleanup. Preserve
manual inherited stdio. Controller shutdown never treats IPC close as cessation.

## Reservation authority and policy schema

The synchronous effect claim reads the bounded reservation snapshot inside the
existing journal transaction before incrementing effectSequence. Journal expected
reservation ID/revision must match. No cached snapshot grants authority alone.
Revocation fences the journal durably outside scheduler transactions; acknowledge
it only afterward. Previously accepted claims may remain in flight and retain
charges. Replacement controllers reconcile/fence affected journals before new
dispatch. Old snapshots never authorize replacement workers. Policy pause blocks
new scheduling immediately; it does not promise retroactive cancellation of effects.
Test claim-before-revocation, revocation-before-claim, crash while fencing and stale
snapshot reuse at the actual synchronous claim seam.

Machine policy uses this strict schema:

```text
version: 1
revision: positive safe integer
admissions: enabled | paused
scheduling:
  maxQueuedPerDomain, maxQueuedTotal, queueLifetimeSeconds: positive safe integers
  clientWaitSeconds: nonnegative safe integer
  maxClientWaitSeconds, watchSeconds: positive safe integers
  sampleIntervalSeconds, maxSampleAgeSeconds: positive safe integers
domains: map of bounded unique domain IDs to:
  host:
    kind: host
    adapter: macos-host-v1
    capacityBytes, protectedHeadroomBytes: positive safe integers
    startupSlots, heavySlots: positive safe integers
  or runtime:
    kind: runtime
    adapter: orbstack-local-v1
    endpoint: absolute Unix socket path
    daemonId: bounded nonempty string
    hostDomain: existing host domain ID
    hostChargeCeilingBytes: positive safe integer
    capacityBytes, protectedHeadroomBytes: positive safe integers
    startupSlots, heavySlots: positive safe integers
enrollments: bounded unique array of:
  repoPath, gitCommonDir: canonical absolute paths
  workspace: existing workspace token
  provider: devsy | devpod
  providerId: bounded nonempty string
  hostDomain, runtimeDomain: existing domain IDs of matching kinds
  profiles: bounded unique profile names
  estimatesDigest: SHA256 of normalized reviewed capacity estimates
  defaultOperation:
    hostIncrementBytes: nonnegative safe integer
    runtimeIncrementBytes: positive safe integer
```

Adapter IDs identify compiled versioned charge and pressure interpretations:
normal, pressured or unknown. Only fresh normal evidence admits work. No configurable
metric name, probe command or telemetry digest. Live qualification must justify
interpretation before activation. Each runtime ceiling charges its host once;
guest workload stays in runtime accounting. Reject duplicate daemon domains,
wrong-kind/missing references, mismatched host bindings, duplicate enrollments,
unsafe bounds and headroom >= capacity. Host ceilings must fit admissible host
capacity. Test two runtime pools on one host, independent pools, alias collisions,
missing bindings and all-domain rollback when any participating domain rejects.
Keep fixtures injected and never selectable executable policy.

## Progress

2026-09-08: user explicitly approved ready/merge/proceed. Controller observation
PR https://github.com/rschlaefli/devrouter/pull/62 merged with branch retained.
Merged-result CI https://github.com/rschlaefli/devrouter/actions/runs/34191981202
passed checks, tests, build, package and controller qualification. New clean
capacity branch starts at merged main. Existing waiting consumer tasks notified.
Native planner resumed and returned construction draft. Generic isolated advisor
consultation is running under /private/tmp/devrouter-capacity-advisor-20260908.

2026-09-08: Native hardening round 3 APPROVED. The prior generic advisor completed
with main corrections recorded in the private review report. Source implementation
continues under existing user authority. Live enrollment and package merge/release
remain separate boundaries.

Source progress: main added capacity-accounting.ts and four focused behavioral
checks; all pass on Node 24.17.0. These checks cover pure accounting only, not
guarded launches. Native executor Gauss 01a07f99-9834-7ff1-9ea4-fd771e6fef02 owns
capacity-policy.ts, repository estimate schema, shared types and schema tests.
Next integrate strict schemas, durable reservations and the first packed launch
tracer before any readiness claim. No live runtime was touched in this phase.

Main extended the existing worker supervisor with optional controller-owned piped
output, bounded independent buffers with loss reporting, abort-signal cancellation
and no per-worker process signal handlers. Manual inherited stdio remains default.
Thirteen accounting/worker checks pass on Node 24.17.0. Integration is pending.
Full typecheck caught fixture typing (corrected) and the executor's in-progress
per-profile schema transition; rerun after the executor completes. The exact
executor remains active. Main asked it to confirm accidental primary src/types.ts
edits before restoring only its owned duplicate; preserve other primary changes.

Executor delivered schema implementation; main independently passed 163 focused
tests and full typechecking. One correction remains with the same executor for
canonical combined enrollment profiles and duplicate transition-source aliases.
Main added capacity-request.ts; three tests verify startup/transition totals,
conservative unknown operations and reviewed-default/digest checks. This remains
pre-dispatch source work, not evidence of actual admission enforcement.

The executor confirmed accidental primary src/types.ts additions. Automatic
approval review rejected git restore because it discards uncommitted changes and
did not accept worker authorship as authorization. Primary remains untouched;
cleanup is pending explicit approval and does not block task-worktree development.

User approved primary cleanup ("then its fine"); main restored only the confirmed
src/types.ts duplicate. Other primary untracked files remain preserved. Executor
correction completed: combined enrollment profile aliases and duplicate transition
source aliases now receive explicit validation.

CapacityStore now persists all-domain reservations under the existing short file
lock and atomic writer. Three filesystem tests prove restart retention, idempotent
join, no partial-domain publication and rejection of unproven charge reduction.
All 171 focused tests pass; full typecheck passes. Filesystem tests initially could
not obtain process identity inside the sandbox; authorized host execution passed.
Store join acknowledges retained charge only; it never authorizes effects or
substitutes for fresh pre-effect validation. No release/settlement path exists yet.
Remaining critical path: bind store reservations to journal intent and workers,
implement positive-proof settlement and controller queue, then packed real dispatch
qualification. Current additions remain uncommitted pending integration checks and
the required independent implementation reviews.

The existing synchronous lifecycle effect claim now invokes assertCapacityEffect
inside its journal transaction for version-2 records. These records require a
capacity binding to reservation/operation/worker/policy and an expiry; legacy
version-1 records retain manual compatibility. Stop bypasses the additional check.
No production conversion or enrollment path is enabled yet. The model's existing
manual operation mechanics remain until controller request integration is complete;
this is an effect fence extension, not a capacity-managed readiness claim.
Twenty-eight focused journal/lifecycle/worker tests and typecheck pass. Reservation
renewal, controller epoch handling, positive-proof settlement and packed launch
qualification remain pending before integrated review or publication.

Complete stop proof now revokes the journal binding before a separate short
capacity transaction releases the matching reservation. Failed route proof retains
both binding and charge. Fifteen focused lifecycle/store tests pass, as do typecheck
and Knip. This implements the release half of the first waiting-start tracer;
controller queuing, launch and renewal remain to be connected.

prepareLifecycleOperation now exposes durable intent creation separately from
worker dispatch while superviseLifecycle preserves existing immediate behavior.
bindLifecycleCapacity checks current intent and the already-persisted reservation
under the journal transaction before recording a version-2 binding. Stop between
preparation and binding rejects the stale request without launching a worker.
The original committed-range risk review is still running; its owner received a
bounded convergence request. Do not replace it merely for an observation timeout.

Fifteen focused lifecycle cases pass, including stop-between-prepare-and-bind.
The expanded tests exposed shared fixture capacity state: stop cases ignored a
rejected setup reservation after another test occupied a startup slot. Each case
now clears only its owned synthetic controller state and asserts setup admission
before testing settlement. Full typecheck passes. No live controller admission
or consumer mutation has been enabled by these changes.

The committed-range risk reviewer completed with concerns. Main accepts the
reservation expansion finding as an integration blocker: accounting permits
same-environment growth, while the store currently rejects reservation replacement.
Before controller dispatch is connected, main owns an atomic expansion contract
that evaluates every domain and preserves existing charges until positive
settlement proof. Acceptance must cover ensure followed by exec, profile changes
whose requested totals are below retained startup charges, and rejected expansion
leaving the original reservation unchanged. Binding identity alone must never
substitute for admission of the requested operation's resource totals.

The masked policy counterfactual finding is already addressed in f66b780 with valid
synthetic IDs and passing counterfactual checks. The reviewer confirmed the current
all-domain accounting, stop revocation-before-release ordering, legacy record
compatibility, and bounded worker-output seams. These findings do not establish
controller integration or live capacity protection.

Main added an explicit predecessor-fenced reservation replacement primitive.
Replacement requires the caller to revoke the prior journal and prove worker
drainage; snapshot revision and predecessor IDs reject stale attempts. The store
evaluates fresh samples across the union of retained and requested domains and
persists maximum per-domain totals and retained slots atomically. Refused growth
leaves the prior snapshot intact. Five store cases cover restart retention, exec
growth, omitted domains, stale predecessor, refused growth, stale samples and
smaller transition totals. All 27 focused accounting/request/store/lifecycle tests
pass; full typecheck and diff whitespace checks pass. This primitive has no
controller caller yet. Journal revocation/drainage integration and pre-effect
resource validation remain required before the review concern is closed.

Main connected prepared lifecycle intent to store admission through
admitLifecycleCapacity. It checks current intent and absence of a registered worker,
requires the previous operation's recorded drainage, revokes its binding durably,
then attempts predecessor-fenced expansion outside the journal lock. Successful
admission binds the new operation; refusal retains the old charge with revoked
authority. Two additional synthetic lifecycle cases exercise admitted and refused
exec growth after a positively never-dispatched predecessor. All 22 lifecycle/store
tests and full typecheck pass. These cases do not prove real worker cessation or
controller queuing. Controller dispatch, repeated-request handling, phase settlement,
renewal, and packed real-worker qualification remain pending.

Main added capacity-queue.ts as an unwired production-path prototype: bounded
transient payloads and output, per-domain FIFO, fresh collected samples before
admission, controller-owned worker supervision, and independent bounded caller
waits. Typecheck passes; behavior tests remain with executor Gauss. Executor
Hypatia 01a07fd5-bfeb-7ca1-b1e4-99d6ad939694 owns additional lifecycle negative-path
tests. Both write only their assigned test files. Main retains queue/server source
ownership. Queue lifetime, shutdown journal reconciliation, reconnect projection,
idempotent admission retry and dispatch error handling are unfinished. Do not wire
this prototype into the live server or claim qualification before these contracts
and the packed launch tracer are complete.

Main added same-operation admission retry validation: identity and retained totals
must match; upward requirements under the same operation are rejected. Renewal
revokes the binding before fresh all-domain evaluation, preserving charge on
refusal. Queue admission exceptions now retain a machine-readable reason and
block only overlapping domains, while unrelated requests can progress. Duplicate
queue operation IDs must match accepted request/worker/environment/reservation
identity. Typecheck passed before the final duplicate-identity guard; focused
regression results remain pending with the existing executors. Remote fetch
succeeded through authorized host execution after sandbox FETCH_HEAD denial.

Queue lifetime now uses a 900-second monotonic deadline. Expiry and controller
close invoke retireQueuedLifecycle, which requires matching intent, no registered
worker and positive NOT_STARTED/NOT_LAUNCHED journal state before marking drainage
and revoking the binding. Runtime reservations remain retained. Unproven retirement
keeps an explicit reason and cannot fall through to dispatch after expiry. Source
typecheck passes. Negative lifecycle and queue behavior tests are still owned by
the same executors; their waits remain nonterminal. These are source primitives,
not integrated controller qualification or release evidence.

Main's focused run overlapped the executor's in-progress lifecycle file and found
three duplicated retry tests failing at first admission with stale effect authority.
The same executor owns deduplication and consistent fixture clocks, then the
original negative-path acceptance cases. This run is failed evidence (24 passed,
3 failed), not a passing regression claim. Do not change production expiry checks
to accommodate historical synthetic timestamps.

Gauss delivered eight queue behavioral tests; main independently reproduced all
eight passing. They cover mocked admission and worker supervision, not real
launches. Main added optional operator scheduling limits bounded by 64 total,
32 per domain and 900 seconds; lower configured limits are honored. Gauss owns
the final focused policy-bound tests. Full typecheck passes. Hypatia's ongoing
fixture correction reduced the observed lifecycle failures to one duplicate
historical-clock test; its corrected retry case passes. Await the completed
test artifact before accepting that suite. No server wiring or runtime changed.

The broad Vitest run passed 1,246 tests and exposed one valid new queue boundary
finding: fractional seconds became an integer after millisecond conversion. Main
fixed seconds validation; all nine queue tests and 18 current lifecycle tests now
pass together. Gauss completed its test ownership. Knip and typecheck pass.
The separately invoked process-helper script skipped because macOS lacks Linux
/proc; Linux execution remains required evidence. Repository formatting currently
reports one extra blank line in Hypatia's in-progress test file. Its original
negative-path tests and final completion are still pending; do not commit over
the active owner or claim the implementation review gates complete.

Main tightened admission and binding to require NOT_STARTED and not-drained
current intent. Three isolated regression cases prove drained, completed and
dispatch-recorded intent cannot acquire/rebind capacity; no reservation transaction
or effect check is reached. These cases pass, as do the existing 27 queue/lifecycle
cases and typecheck. Hypatia's same live handle remains nonterminal after a bounded
convergence request; its test-file ownership remains preserved. This checkpoint
does not close the pending integration or review requirements.

Hypatia returned terminal DONE_WITH_CONCERNS and released its test file. Main
completed queued-retirement, possibly-dispatched retirement rejection and missing
drainage retention tests; the independent guard test also covers an active worker.
All 34 queue/lifecycle/guard tests pass. Repository formatting, Knip and full
typecheck pass. The existing stop-between-prepare-and-bind test remains applicable.
The slice is ready to commit for independent review, not ready for publication,
controller activation or capacity-protection claims. Main owns the remaining
server/protocol integration, telemetry and policy qualification, renewal, phase
settlement and packed real-worker tracer.

Committed the prepared-intent/reservation/queue slice as fea5a46. Reused the existing
risk reviewer and simplifier for f66b780..fea5a46; supplied producing verification
to the simplifier after NEEDS_CONTEXT. Both reviews remain pending. Main separately
added lifecycle-operation-status.ts for durable current/history projection:
queued intent has no terminal outcome, drained possible launch remains unknown,
and completed nonzero exit codes remain definitive. Eleven focused projection
tests and typecheck pass. This new source is outside the immutable review range
and is not wired into controller IPC yet.

Added read-only operation-status IPC using the existing store/epoch/session/
generation validation. The server resolves identity from the validated session's
environment; callers cannot supply a different checkout path. A synthetic real
Unix-socket test proves retained nonzero result lookup and stale-generation
rejection before journal access. All 31 affected server/protocol/projection tests
and typecheck pass. This query does not submit or replay commands. Command
admission, policy enrollment and telemetry remain unwired; the committed prior
slice's independent reviews retain their immutable range.

Original risk route terminated with provider400 insufficient credits. Native
same-provider retry cannot fix exhausted credits; one trusted generic-continuity
Luna/max reviewer Singer 01a08000-91f1-7ba1-9fd4-f2d0fa5da7ce now owns the same
immutable risk review. Simplifier completed: main verified and applied its sole
recommendation, consolidating refused/exception queue topology tests into two
independently reported parameterized cases with shared completion assertions.
Added operation-status parser tests for complete binding, bounded operation ID
and rejection of caller-supplied checkout paths. All 18 queue/protocol tests pass.
No risk-review approval is claimed while Singer remains active.

Integrated source validation now passes 1,267 Vitest tests across 97 files.
The build and isolated packed CLI smoke both pass; packed validation installed
only into its temporary fixture and did not update the machine CLI. Linux
process-helper tests still skip on macOS. Updated the owning devcontainer manual
with the read-only operation-status contract. These results verify distribution
and source regression, not the still-unwired capacity launch path. Singer remains
the sole active risk reviewer for the prior committed slice.

Committed read-only operation-status IPC and the verified test simplification as
5fe1e2a. Main added bounded readCapacityPolicy to the existing policy module:
missing file/directory returns absent, while malformed, non-private or symlinked
policy remains an error rather than disabling enrollment. Files open nonblocking
without following symlinks; parsing retains the strict policy schema. Twelve policy
tests and typecheck pass. The reader is not activated by controller startup yet;
no real machine policy has been created or changed.

Aligned policy validation with implemented controller bounds: at most 64 total
queued entries, 32 per domain, 900-second queue/caller limits, 30-second watches
and 15-second sample age. Six policy counterfactuals prevent accepting limits
that the queue or evidence contract cannot honor. All 27 policy/queue tests pass.
The same risk-review handle remains nonterminal; main sent one bounded convergence
request without widening its immutable scope or treating a timeout as completion.

Queue ticks now require enabled private policy at their configured revision, then
reread the complete policy before each admission after telemetry collection.
Policy changes during sampling leave requests queued without admission or launch;
missing/invalid initial policy also preserves queued work. Three asynchronous
sampling cases cover pause, removal and revision changes. All 30 policy/queue tests
and typecheck pass. The queue still needs enrollment/domain binding and real
telemetry integration before server activation; revision equality alone does not
establish those missing proofs.

Removed caller-supplied budgets and sample-age overrides from CapacityQueue.
Admission now uses domain budgets and maximum sample age directly from the
validated operator policy read for that tick, with the existing post-collection
policy equality check. A focused case proves lower operator capacity and shorter
sample age reach admission. All 31 queue/policy tests pass. Enrollment identity
and endpoint telemetry qualification remain separate required integration work.

Queue construction now obtains total/per-domain/lifetime limits from the matching
operator policy rather than optional caller overrides. The existing lower-limit
and fractional/boundary tests now exercise policy-supplied values; all 31 affected
queue/policy tests pass. This keeps one authority for scheduling and budgets.
Policy-backed source remains uncommitted while validation completes; no policy
file or consumer runtime has been modified.

Committed policy-backed queue construction as 6c67fc0. Main added
resolveCapacityEnrollment using existing canonical linked-checkout/provider
resolution, Git common-directory identity, exact enrollment matching, enrolled
profile and reviewed estimate digest. Seven focused adapter-boundary tests pass
for matching and mismatched provider, provider ID, workspace, Git common directory,
profile and digest. These mock the established ownership probes; they do not prove
live ownership or dispatch. Source is not wired to canonical ensure/exec yet.

Started the existing packed lifecycle qualifier on this source tree with its closed
synthetic provider executables, isolated home and nonexistent Docker socket.
Session 11299 remains running; output is retained at
/private/tmp/devrouter-capacity-lifecycle-qualification.log and fixture artifacts at
/private/var/folders/24/j7k2mlqn42l_dhq64jpqslxh0000gp/T/qualify-lifecycle-JQ4ntb.
Use the same process handle; do not launch a duplicate. No producing qualification
result exists yet. This tests manual lifecycle compatibility, not the still-unwired
capacity queue launch path. Enrollment source typecheck passes.

Packed lifecycle qualifier session 11299 completed successfully. Its 25 producing
evidence entries cover installed manual ensure/exec/stop, automatic degraded-state
repair, application failure with retained tooling, duplicate IPC, stop-before-
dispatch, persistence failures, supervisor/worker loss and Devsy successive results.
Tarball SHA256 f556089822747484b55dae2752332958c4c69cef937116675228dc37b7a4eb5b;
CLI SHA256 b3f8ece589f3035fbb0d564b9d70109efd7f3dc5f763c1eadd83614903bb7e6d;
worker SHA256 c6eddf5f06bcb7a17836b1092134785c81f897d53ba319af6d9c88388738acfb.
Reuse this isolated packed manual-lifecycle evidence while its exercised source
is unchanged. It does not establish capacity-controlled launch, Linux process
helper behavior or current eLearning runtime qualification.

Enrollment resolution now repeats the existing canonical binding proof and checks
configuration bytes before returning, rejecting changed ownership during its
asynchronous probes. Eight focused enrollment cases pass, including the provider
replacement race. This is bounded read-only identity resolution, not a substitute
for the final pre-effect fence or real telemetry qualification.

Linux process-helper regression now passed in the exact isolated Docker fixture
devrouter-capacity-linux-helper-20260908 using the existing local
default-rs-101ce-app:latest image. The run used read-only source/root filesystem,
no network, dropped capabilities, 256 MiB memory/swap limit, one CPU, 128 PID limit
and 64 MiB temporary storage. The producing script printed reconciliation tests
passed; exact container state is exited, exitCode 0, OOMKilled false. Log:
/private/tmp/devrouter-capacity-linux-helper.log. The stopped fixture is retained;
no deletion, shared VM restart, live consumer mutation or host OOM was performed.
This closes Linux helper regression evidence only, not capacity admission or OOM
protection qualification.

Committed enrollment resolution and qualification receipts as 6255f5c. Main added
capacity effect validation at both supervisor dispatch journal transactions,
before dispatch registration and before dispatch-persisted acknowledgement. Two
negative worker cases prove revoked authority at either boundary prevents IPC
work delivery. All 32 worker/lifecycle tests pass. This changes supervisor source,
so packed worker qualification must be rerun for the changed dispatch boundary;
earlier Linux helper evidence remains applicable because its source is unchanged.

The repeated packed qualification completed with status passed and 25 synthetic
lifecycle evidence entries. Receipt:
/private/tmp/devrouter-capacity-dispatch-qualification.log; artifacts:
/private/var/folders/24/j7k2mlqn42l_dhq64jpqslxh0000gp/T/qualify-lifecycle-xS4uQq.
Its tarball SHA256 is b398f953a850844dd60c035e15933468993a1a6109da90cd85b35f8688f9f882;
CLI SHA256 is 452e71ebe984f2236085fa02c53037b006c40164d3744ef193d395aa7fedc638.
This verifies the supervisor change with synthetic providers, not live capacity
dispatch or OOM protection.

The fallback slice reviewer completed the frozen f66b780..fea5a46 range with five
findings. Main verified the findings against current source. Exact reservation
joins now run fresh all-domain admission, with stale, pressured and unknown sample
regressions preserving the retained snapshot. Gauss added a monotonic deadline
check after admission and before dispatch, with a regression proving no worker
launch after expiry. The affected store, queue, worker and lifecycle suites now
have 54 passing cases in aggregate. Typecheck, Biome and Knip pass.

Three findings remain open under main ownership: released reservations leave a
stale version-2 journal binding; stop racing reserve/bind can orphan a replacement
charge; and stop-superseded queue entries cannot retire through their stale fence.
Singer retains read-only ownership of the requested settlement-protocol
clarification. Resolve these with crash-window and stop/resume regressions before
controller dispatch integration or capacity activation. Preserve version-2
capacity enforcement and retained charges whenever cessation is unproven.

Main corrected stop-superseded queue retirement. The journal can acknowledge a
superseded operation only when its current or retained history proves it drained
without dispatch and no worker belongs to that operation. Admission errors check
this proof before retaining an uncertain queue head. Proven supersession retires
the payload and allows overlapping followers to proceed; ordinary admission
failures stay queued. The retirement path never releases capacity charges or
changes newer intent. All 37 affected queue/lifecycle tests pass, along with
TypeScript, Biome and Knip. Reservation settlement and its crash windows remain
open; Singer's requested clarification is still pending.

The released-binding defect now has a source correction. Version-2 journals
support explicit null capacity after settlement; missing capacity remains invalid,
and null never grants effect authority or restores version-1 behavior. After exact
stop proof and reservation release, a fenced journal confirmation clears the old
binding. Preparation reconciles a crash between release and confirmation only
while full stop proof remains present, no worker remains, authority is revoked,
and no environment reservation remains. Stop/resume then obtains a fresh binding.
The 23 lifecycle cases include successful stop/resume, incomplete-route proof and
an injected crash after release. The executor's 11 persistence cases pass, including
null authority denial and malformed version-2 rejection. Main verified its diff.
The late reserve/bind race is still open; this correction does not claim to fence
delayed reservation publication or complete capacity admission qualification.

The reviewer endorsed global snapshot revision fencing instead of a revocation
sidecar, conditional on mandatory revision checks, monotonic writes, and deferred
stop finalization. Main is integrating that protocol. Lifecycle admission reads
the capacity revision before journal validation, establishes unbound version-2
enforcement before initial reservation, and supplies that revision to the atomic
reservation transaction. Stop revokes authority while remaining stopping, then
settles the exact environment with a revision check and publishes full stop proof
only after settlement. Settlement increments the revision even for an absent row.
Only snapshot contention retries, at most three attempts; other failures propagate.

The crash-after-release test now requires stop finalization retry before admission,
superseding the earlier test that exposed full stop proof before settlement.
Initial late-publication and already-published unbound-reservation regressions pass
in the lifecycle suite. Mandatory store revision checks and final integrated
verification are still being completed. No live policy or runtime was activated.

Mandatory revision integration is complete. All 26 lifecycle, 23 real-lock
store/persistence and 30 queue/worker/retired-intent cases pass. TypeScript, Biome,
Knip and diff whitespace checks pass. The store rejects omitted revisions before
mutation; predecessor identity checks remain separate from snapshot revision
checks. Stop retries only the typed snapshot-conflict error, with a three-attempt
regression preserving stopping state and withholding full stop proof on exhaustion.
The combined correction still requires independent review and a fresh packed
lifecycle qualification because settlement ordering changed. Controller capacity
dispatch, real telemetry, phase settlement and consumer qualification remain open.

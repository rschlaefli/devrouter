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

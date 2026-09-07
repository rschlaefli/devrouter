# Controller observation and consumer sessions

Status: approved execution plan under the reliability roadmap. User-authorized fourth focused planning review passed on 2026-09-07; prior review_deadlock is superseded.

Current continuation: consumer prerequisites are delivered in
[startup fixes](https://github.com/rschlaefli/devrouter/pull/60) and
[preparation child drainage](https://github.com/rschlaefli/devrouter/pull/61).
Versions 0.0.58 and 0.0.59 are published; both existing global installations
report 0.0.59 and contain the verified helper. Consumer owner confirms selected
profile startup and same-process warm reuse, then exact stopped state and zero
routes. Its remaining browser launch failure belongs to its pnpm workflow.

Controller work resumes on 328bf79, four commits ahead and two behind main at
4154a148 after remote refresh. Existing changes are preserved; target integration
is deferred until the observation slice is coherent. The existing main-session
collector ownership remains in force after the exhausted worker attempts.

On 2026-09-08 the real Linux observation shell passed exact process-identity
validation and foreign-fingerprint rejection without marker changes. The actual
observeControllerProcess adapter also passed through its bounded Docker exec
path. Both fixtures had no network, read-only roots, 128 MiB memory, one CPU and
64 PIDs; both exited without OOM. Receipts are
/private/tmp/devrouter-controller-process-proof.log and
/private/tmp/devrouter-controller-production-probe.log. The focused controller
suite passes 33 tests across process observation, monitor, probes, server and
journal fencing. These results qualify the process seam, not the unfinished
production collector or packed continuous-observation behavior.

Latest continuation: the production collector now invokes the bounded HTTP seam,
preserves runtime capability during application-contract failure, rejects paused,
restarting or dead container readiness, and detects container/process incarnation
changes during sampling. Configuration and retained state parsing reuse captured
bounded bytes; journal reads reject non-regular files before reading and retain
their byte bound if a file grows. Six collector regressions and four asynchronous
HTTP cases pass. The full Vitest suite passes 1166 tests across 89 files; TypeScript,
changed-file Biome, docs policy and knowledge checks pass. Host process-identity
access is necessary for the lifecycle lock tests. These checks do not complete
the package: required reviews and remaining adversarial qualification remain
outstanding. The subsequent integration wires the production collector into
the foreground command and verifies resolved Compose hashes twice using bounded
read-only subprocesses. Resolved configuration stays transient. Eight collector
cases and six process-probe cases pass; the affected Compose, TLS and HTTP set
passes 63 tests. The qualification executor was closed after repeated planning
and rereads continued beyond its narrowing checkpoint without an edit. Main owns
the harness; no replacement executor is launched. Packed qualification now passes
actual collector READY to APP_ERROR with independent runtime READY, release,
stopped resources and journal, and restart invalidation. It records 52 provider
reads, zero unexpected calls, and a stopped fixture observer. Receipt:
/private/tmp/dr-observe-dpyevu/receipt.json. The two new real asynchronous curl
tests also pass. Delayed stop-race and overload qualification remain open.

Waiting-task coordination: Klicker Runner now launches browsers with the correct
pnpm verification setting and reports no remaining Devrouter blocker; its publish
dialog failure belongs to application behavior. Klicker Chat Roadmap continues its
generator source/reviews for new containers and unchanged package inventory.
Adding a new package-local dependency mount to a retained container remains a
separate lifecycle design; no replacement, reset, postCreate, data deletion or
workspace-layout change is authorized by this coordination.

## Approval summary

Add one bounded host observer that notices when an explicitly enrolled development
environment stops satisfying its declared capabilities after `ensure` exits.
Compatible consumers share observations and receive bounded events. Losing the
observer, its evidence, or its session continuity yields unknown status, never a
new readiness permission. This package has no provider restart, automatic stop,
capacity admission, command replay, or agent-continuation authority.

The user authorized continuing through observation, admission, bounded recovery,
and harness integration after the first release. That prerequisite is complete:
devrouter PR 58 merged as e30236405690d0781d4d396b881024a2c55ad18b; version 0.0.56
is published and globally installed. eLearning MR 233 merged as
174213a27ee02ed5c9c83dfd8d60e5469c4bd2c7. Released canary checks cover automatic
recovery, tooling after an application error, warm preparation, authenticated
retained progress, and stop/resume. The exact canary is stopped with zero routes.
These facts do not claim complete OOM protection or autonomous agent recovery.

Implementation, bounded fixture tests, independent reviews, local commits, ordinary
branch delivery and a draft PR are authorized. No additional service-manager
installation, client/MCP configuration changes, production deployment, paid
infrastructure, data deletion, shared VM restart or host OOM experiment is included.
Foreground observer qualification uses an isolated home and synthetic providers;
one optional read-only observer run may attach only to the exact stopped eLearning canary.

## Execution details

### Baseline and delegation map

Repository base: e30236405690d0781d4d396b881024a2c55ad18b, published 0.0.56.
Branch: rs/controller-observation. Worktree: trees/rs/controller-observation.
Artifacts remain under docs/project. The roadmap authority is the approved
2026-09-06 local-environment reliability roadmap, sections 4–6, 14–16, as amended
by the user's eLearning choice and first-release ordering.

| Slice | Route | Dependency | Paths and acceptance |
| --- | --- | --- | --- |
| Durable foreground sessions | main | Mapper findings accepted and plan approved | src/commands/controller.ts, src/core/controller-{protocol,store,server}.ts, src/cli.ts; private ownership, protocol, durable session and restart tests |
| Coalesced write-free observations | native executor | Session contract fixed | src/core/controller-observation.ts and narrowly scoped journal, route and process read seams with tests; exact ownership, independent readiness, stop fencing and bounded probes |
| Installed qualification and delivery | main | Observation slice accepted | scripts/qualify-controller.ts, scripts/package-smoke.sh, applicable CI wiring and owning docs; packed two-client qualification and complete review gates |

Mapper Maxwell's read-only report is accepted as prerequisite evidence. The main
session retains the first and final slices because of critical-path coupling:
persistence and IPC decisions, integration, and final proof share one contract.
Each slice is committed after focused checks. The dedicated simplifier and one
cross-system slice-reviewer examine each substantive committed slice before the
next dependent slice; final-reviewer examines the integrated committed package.
Review findings are verified and dispositioned; no reviewer grants lifecycle
or publication authority. This is a full-path package with boundary owner self.
Terminal: reviewed draft PR with packed observation qualification. Pause: only a
real unavailable required capability or a material authority/design departure.

Main retains persistence authority and IPC integration because these decisions
are tightly coupled to existing lifecycle fencing. No worker may alter manual
ensure/exec/stop dispatch or reinterpret a manual operation as capacity-managed.

## Proposed minimal contract

The observer is a distinct process entry in the existing npm distribution. It
uses a user-private Unix socket and directory below ~/.config/devrouter. It has
one exclusive process-incarnation owner, a monotonic persisted observer epoch,
bounded input frames, and an explicit protocol/version handshake. No TCP listener
or credential is exposed to containers. Same-user processes are inside the trust
boundary; the socket does not promise same-user hostile-process isolation.

The public command surface is:

```text
devrouter controller run
devrouter controller observe <path> --session <id> --profile <name> --require <selector>... --json
devrouter controller renew --session <id> --store <id> --epoch <n> --generation <id> --json
devrouter controller release --session <id> --store <id> --epoch <n> --generation <id> --json
devrouter controller status [--session <id>] [--cursor <cursor>] --json
devrouter controller watch --session <id> --store <id> --epoch <n> --generation <id> [--after <epoch>:<sequence> --after-store <id>] --timeout <seconds> --json
```

Clients never implicitly start a controller. Foreground `run` owns one process;
service-manager enrollment is deferred. Existing ensure/exec dispatch is unchanged.
Protocol version 1 is independent of reliability contract version 2. Use bounded
NDJSON frames, a mandatory version handshake, request IDs, strict method schemas,
and wire methods handshake, observe, renew, release, status and watch. Host run is not an IPC method. Reject unknown fields, methods, and versions without
reflecting input. JSON commands return one bounded success/error object; UNKNOWN
is a successful status result. Watch streams NDJSON and exits successfully at its
explicit deadline. Status reads committed projections, never probes or renews.
Whole-controller status is paginated to remain within the frame bound. Mutating
requests and snapshot/subscription registration are serialized by the owner.

A session ID identifies one consumer binding. Identical observe retries return the
existing session without renewing it; changed ownership, profile or requirements
conflict. Only renew extends an existing lease. Require the current epoch for
renew, release and watch; old-epoch requests cannot affect a replacement session.
Support existing managed linked checkouts only; reject primary/unmanaged checkouts.
Resolve canonical owner/provider references without claiming or repairing them.
Requirements are runtime and app:<configured-name>. An app must be in the selected
profile and have explicit HTTP readiness. Reject other selectors and translate to
existing valid reliability capability IDs without expanding the model ID grammar.
Coalesce exact checkout, workspace token, provider, provider workspace ID, profile
and configuration fingerprint. Union probes then project per-session requirements.
Configuration/provider drift invalidates the binding until release/reacquisition.

Session acquire uses the supplied session ID as its sole stable opaque consumer ID, exact canonical owner reference,
provider, selected profile and required capabilities. It does not create or start
an environment. Compatible sessions share one environment record and one probe
batch; conflicting profiles are reported without changing resources. Renew and
release affect only that consumer. Release, lease expiry and observer shutdown
never stop a runtime in this stage. Status reads never renew a lease.

Use a coordination snapshot only for active references, session metadata, epoch
and bounded sanitized event records and cursors. Existing repository owner records remain authoritative.
Existing manual operation journals remain untouched and authoritative for stop
intent, dispatch and completion. Do not copy their operation history into a second
ledger. A read failure or incompatible version is unknown, not an empty registry.
The snapshot is not a global repository registry and grants no deletion authority.

Persist changes before acknowledging them, using reviewed atomic-file and locking
primitives where they satisfy the contract. Cap sessions, environments, snapshot
bytes, event retention and subscriber buffers. Corrupt/full/unwritable state
prevents new acknowledgements while preserving existing files and reporting a
bounded error. Never silently overwrite a corrupt snapshot with an empty one.

Observation must be side-effect-free: exact owner/provider/container membership,
managed process status and bounded declared HTTP probes only. Do not invoke
ensure, setup, live verification, helper delivery, certificate refresh, expensive
size walks, browser smoke, configuration repair, or provider mutation. Missing
observation invalidates affected evidence; it does not classify a process as OOM.
Stop intent and journal revisions fence publication. A stale in-flight batch cannot
publish readiness after a manual stop or a changed runtime/profile identity.

Do not call the current generic managed status/helper path unchanged: it opens a
process lock file and can issue synchronous subprocesses without deadlines. Add a
bounded write-free process observation seam. Read existing markers without creating
directories, opening/truncating locks, delivering helpers, or repairing state.
Preserve exact container, process-group and ownership-fingerprint proof; missing,
malformed, changing or unverifiable evidence is unknown. Revalidate marker and
process identities before accepting a batch. Probe subprocesses have parent-owned
cancellation/deadlines and bounded output; cancel only the exact observer-owned
probe. Read-only probes never signal application processes or mutate providers.
Existing journal-lock metadata writes for final publication fencing are a named
coordination allowance, separate from runtime observation and never permission
for generic helper writes. Qualification records filesystem/provider writes and
requires none from the observation seam, including marker races and hung probes.

Use explicit time inputs for session and freshness decisions. Within a controller
incarnation, use monotonic elapsed time. Restart, wall-clock discontinuity, host
sleep/wake and missed event continuity invalidate evidence and require reobservation.
Persisted wall-clock lease timestamps never authorize mass expiry actions. Initial
coalesced reconciliation is five seconds and freshness is fifteen seconds; those
are qualification parameters, not universal latency promises. Bound concurrency
and command deadlines so fair scheduling gives every enrolled environment a bounded turn; freshness may expire under saturation and must honestly become UNKNOWN, without an availability guarantee for all 32 environments.

Event delivery has an epoch/cursor and a bounded replay window. A slow or reconnecting
subscriber receives an explicit gap plus a current snapshot when replay cannot be
proven. Disconnect cancels that subscription, not a session or runtime. Duplicate
events are distinguishable and cannot imply repeated continuation. No model calls
or raw command arguments, output, environment values, cookies or transcripts enter
the observer's state or event stream.

### Storage, timing, and delivery decisions

Use ~/.config/devrouter/controller/{owner.lock,control.sock,snapshot.json}.
The directory is 0700; socket and snapshot are 0600. Reject unexpected ownership,
symlinks, non-directory ancestors within the owned path, and unsafe file types.
Fail on an overlong Unix socket path; no TCP or alternate-directory fallback.
Hold a dedicated PID/birth/nonce owner lock throughout run. A second owner fails
promptly; a late heartbeat never permits live-owner takeover. Clean a stale socket
only after exclusive ownership and exact socket type/ownership validation.

Snapshot version 1 stores a random store identity, monotonically increasing epoch,
revision and next event sequence, active environment/session references, bounded
lease metadata and sanitized event ring. Any stored observation is invalid after
restart. Validate and durably increment epoch before listening; reject unknown
versions, corruption and exhausted safe-integer counters without migration/reset.
Remove environment references after their last session ends; retained events use
opaque IDs, not a historical checkout catalogue. Historical replay requires the
handshake store identity via --after-store; equal epoch numbers in different stores do
not establish continuity.

Commit each transition with its events before acknowledgement or delivery. Failed
pre-rename writes retain the old snapshot. For rename followed by sync failure,
resync the exact intended bytes under ownership using the operation-store precedent,
or terminate with durability unknown. Never continue acknowledgements or cached
READY after an uncertain commit. Durable acknowledgement does not promise lease
survival: restart invalidates all sessions and requires explicit reacquisition.

| Resource | Fixed qualification bound |
| --- | --- |
| Population | 32 environments; 128 sessions; 16 requirements/session |
| Transport | 32 connections; 64 KiB/frame; 5-second handshake |
| Persistence | 1 MiB snapshot; 256 events and 256 KiB retained event payload |
| Subscriber queue | 64 frames or 256 KiB |
| Probes | 2 environment batches concurrently; 1/environment; 10-second batch deadline; 3-second subprocess deadline |

Validate admission to these coordination limits before mutation; never evict active
sessions. Evict oldest events for ring bounds. Schedule environments fairly, skip
overlapping ticks, and expire cached freshness even while a batch is queued.
Use a 30-second session lease, renew every 10 seconds, reconcile every 5 seconds,
and invalidate observations after 15 seconds. These are fixed initial bounds, not
new configuration machinery or universal performance promises.

Use injected integer monotonic time per incarnation; wall time is diagnostic.
Before requests or probe acceptance, compare wall and monotonic deltas. Negative
wall delta, discrepancy over 2 seconds, or scheduling gap over 15 seconds invalidates
observations and pending batches. Affected sessions require renewal/reacquisition
before use. Detect bounded clock/scheduling discontinuities without claiming every
brief sleep is detected. Never feed monotonic values to the manual journal's wall
time floor. Persisted lease timestamps never authorize runtime actions.

Delivery is at least once, identified by store/epoch/sequence. Historical events
are not renewed readiness grants. Wrong epoch/store, expired retention or future
cursor yields an explicit gap and current snapshot. Register snapshot/subscription
atomically with respect to event publication. On bounded queue overflow disconnect
the slow client; a blocked socket cannot be promised even a gap message. Reconnect
gets gap/snapshot. After restart, reacquire via observe before watch with the new request epoch. An old replay cursor may then produce a gap; an old request epoch is rejected. Callers renew separately every ten seconds while watching; watch itself never renews. Lost continuity invalidates that subscriber's cached READY,
not other sessions. Clients discard READY on disconnect or validity expiry.

### Publication fencing and pure projection

Probe without journal/lifecycle locks. Serialize owner mutations, then acquire only
the relevant journal lock for a bounded short critical section. Complete runtime and process revalidation outside the journal lock and capture
the fingerprint and monotonic sample time. Inside the journal lock reread only
bounded persisted ownership, configuration and journal evidence. Compare their
fences, session generations, cancellation and freshness before snapshot commit.
Manual stop is ordered against durable publication; external container/process
changes after the final sample are detected by later observation or freshness
expiry, not atomically prevented. No runtime subprocess runs under the lock. Release the journal
lock before network delivery. No probe/client I/O under that lock, and never update
the manual journal. Lock order is owner lifetime lock, owner mutation serializer,
then one environment journal lock; no inverse acquisition. Lock timeout discards the
batch as UNKNOWN. Add a read-under-lock seam, not updateReliabilityOperation.

Stop wins at durable publication: a pre-stop message may arrive afterward, so emit
journal revision and observation fence and never equate delivery with observation.
Reuse pure readiness classification on a transient projection of requirements and
observations. Never submit acquisition/release/epoch/recovery events to persisted
manual state; preserve executionPolicy=manual and stop intent, keep observer epoch
separate from journal controllerEpoch, and consume no lifecycle effects. Missing or
unreadable journals yield UNKNOWN, never default state. The entire observation batch
is write-free, including route reads via readHostRouteStateReadOnly. Only the named
publication journal-lock metadata writes are permitted outside controller storage.

## Verification and terminal condition

Use the existing deterministic model and installed lifecycle portfolio, extending
only relevant seams. Required cases: two consumers share probes; release preserves
the other session; incompatible profiles do not contract resources; status does
not renew leases; exact manual stop wins against delayed observations; process
incarnation changes invalidate evidence; restart and wake discard stale readiness;
unknown provider evidence stays unknown; event gaps and slow clients are bounded;
invalid versions, oversized frames, corrupt snapshots and failed durable writes
cannot acknowledge success or cause provider mutations.

Installed qualification must launch the packed observer and two IPC clients in an
isolated home, demonstrate continuous detection after startup returns, kill only
the fixture-owned observer to test restart, and prove the provider mutation log
remains empty. Never inject disk-full or OOM on the host; use injected I/O errors
and bounded synthetic counters. Measure observer overhead and event/probe counts.
Packed synthetic qualification is mandatory. Optional read-only attachment to the
exact stopped eLearning canary qualifies stopped-state observation only. A running
canary test requires a separately named lifecycle sequence and is not a completion
dependency here. Do not start or stop it under read-only attachment authority.
Stop the fixture-owned controller after its qualification.

Run affected tests, formatting, typecheck, Knip, docs/knowledge, build and package
checks. Add the installed observer proof to existing qualification/CI only once
the actual producing run passes. Complete substantive simplifier, cross-system
risk review and integrated final review, preserving valid unchanged evidence.
Deliver one coherent draft PR. This package ends at reviewed observation-only
source plus installed fixture evidence; admission, recovery and harness
integration continue as subsequent packages under the same goal.

Additional acceptance groups cover simultaneous owners, live unresponsive owners,
stale sockets/PID reuse, private file checks, crash-before-ack, post-rename failure
and counter exhaustion; retry/conflict/epoch/selector/frame/pagination contracts;
stop between probe and commit, config/container replacement, a hung environment
alongside a healthy one and responsive IPC; clock discontinuity, lease expiry,
future/replay cursors, blocked subscribers and snapshot/subscription races.
Run production observation adapters against isolated fixture executables and prove
zero unexpected filesystem/provider writes, retained exact ownership proof, and
sanitized errors without raw output persistence. Characterize CPU/RSS, detection
delay and counts; fixed byte/concurrency/deadline limits are gates, not thresholds
invented after observing performance.

Extend ADR 0008 for observer authority, sessions and epoch composition. Update the
owning consumer manual, managed-lifecycle knowledge page and bundled devrouter skill.
Release preparation, publishing and global installation are outside this package's
draft-PR terminal condition; future admission/recovery/harness packages remain in
the same authorized goal.

## Provenance and Progress

The user amendment in this task explicitly orders first release, then observation,
capacity admission, bounded recovery and harness integration. The original roadmap
remains at the primary checkout's [roadmap](../../../../../docs/project/2026-09-06-local-environment-reliability-roadmap.md),
sections 4–6 (controller/session/entrypoints), 14–16 (packages/sequence/verification).
The current branch does not silently replace that untracked roadmap.
First release receipts: [published release](https://github.com/rschlaefli/devrouter/releases/tag/v0.0.56),
[merged source](https://github.com/rschlaefli/devrouter/pull/58), and the exact local
[dogfood report](../../../reliability-contract-foundation/docs/project/_local/reviews/2026-09-07-published-056-dogfood.md).
Local receipt links intentionally point to existing ignored evidence, not shipped
product documentation or a claim that those files exist in other clones.

Source mapper completed at base e302364. Accepted exact provider ID in coalescing,
readHostRouteStateReadOnly, separate observer snapshot, read-only canonical owner
resolution, and manual journal invariants. Rejected mapper suggestion to key shared
batches by session: compatible sessions must share probes; session ID belongs in
projection/lease fencing. No PID lease inference: explicit renewal is authoritative.

Planning round 1 REVISE: accepted separate write-free bounded process seam.
Round 2 REVISE: accepted concrete protocol, persistence/ownership, limits, leases,
events, fencing, pure projection, linked-only scope and fixture-only terminal proof.
The complete amended draft awaits the required advisor and final third planner
round. No controller source, service enrollment, or new runtime has been created.

Required advisor completed DONE_WITH_CONCERNS/REVISE after an initial headless
file-read denial. The same advisor received the complete sanitized public draft
inline without permission changes. Accepted explicit wire handshake versus host
run, stable session-as-consumer identity, request/replay epoch distinction and
separate renewal. Scheduling clarification accepted: fair service is not a promise
of freshness under saturation. Rejected increased concurrency or hidden timeout
clamping as unnecessary for truthful observation. Rejected releasing the manual
journal lock before durable snapshot commit: it breaks the approved stop-wins
publication fence. Current controller implementation is deferred while a released
combined-profile validator regression is corrected in its own small task branch.

Third native planner round returned REVISE. Both final findings accepted: use
(store identity, controller epoch, session ID, random generation) on renew/release/
watch and batch/session publication. Acquisition retries preserve generation;
release/expiry followed by reacquisition creates a fresh generation. Clients pass
the returned binding explicitly and never resolve a replacement implicitly. Test
delayed requests and batch completion after replacement, including recreated store
with equal epoch. Runtime/process revalidation occurs outside the journal lock;
only persisted ownership/config/journal fences and freshness are checked within it.
Test manual stop before commit separately from external changes after sampling.

Planning cap reached: review_deadlock. No fourth reviewer or replacement is
authorized merely to reset that cap. Controller source remains unimplemented; the
revised final contract is not recorded as approved. Independent release-regression
work continues. Required remaining capability is a reviewed final session-generation
and sampled-observation contract, rather than another generic proceed.

User explicitly approved the corrective release and one additional focused review.
Round 4 with the same planner returned DONE / VERDICT APPROVED: session generation
and store fencing, external sampling, persisted publication fencing and acceptance
are consistent. Prior deadlock is historical. Continue implementation under the
existing roadmap authority without another proceed gate.

Execution resumed after explicit acceptance of the recommended controller workflow.
The first slice retains main ownership of persistence, session lifecycle and server
integration because they share durability and IPC fences. Native executor Goodall
(01a07d40-534e-7100-9c9c-3d40c8deaaff) owns the disjoint strict protocol parser and
its focused tests. Store and session tests currently pass 13 cases. Socket wiring,
canonical binding resolution, replay/watch and production observation remain
incomplete; these tests do not establish an available CLI or readiness observation.
No runtime has been started. The goal tool still carries the superseded blocked
status and exposes no resume operation; execution continues under user approval.

A separate bounded read-only source investigation examines the reported 0.0.57
retained-full recovery before a requested manage,live-quiz transition. The consumer
owner confirmed canonical stop, empty resource membership, no drift and zero
routes. Its fixture startup message is a catch-all, not an authentication diagnosis.
No consumer checkout or runtime changes belong to this investigation.

Durable-session slice now includes strict protocol parsing, private socket ownership,
canonical linked binding resolution, an epoch-fenced store, explicit leases, bounded
client/watch transport and CLI registration. Status remains UNKNOWN until the next
observation slice. Config fingerprints use an incarnation-local random HMAC key so
persisted fingerprints cannot expose low-entropy configuration values through a
public unkeyed digest; restart already invalidates every binding. No key is stored.

Validation before slice review: 1133 tests across 84 files pass, including 28 new
controller cases; TypeScript, Biome, Knip, docs policy and build pass. Socket tests
require host process-birth access; sandbox ps denial is recorded as an environment
constraint, not a product failure. Isolated fixture controllers terminate during
test cleanup. Native protocol worker completed with 8 focused cases passing.
Production probe qualification, observation publication fencing, overhead measures,
full packed two-client qualification and integrated review remain outstanding.

Both durable-session reviews completed. The simplifier proposed two accepted
behavior-preserving reductions to duplicate parsing and replay. The risk reviewer
passed the slice with regression gaps for mismatching durability recovery, replay
boundaries and IPC limits. Those focused tests are being added with the existing
executor; prior assertions and source evidence remain reusable. The earlier
"reviews running" notes are historical. Continuous observation is the next slice.

The retained-profile mapper verified current all-or-nothing full-profile repair
before switching to a requested narrower profile. Main accepts the ordering
finding, not its recommendation to preserve that blocking behavior as final policy.
Exact ownership must remain proven; successful startup of dropped processes has
not been established as necessary. A safe correction remains open and is not
claimed by the controller package. The consumer remains stopped by its owner.

Durable-session review follow-up complete: executor added divergent post-rename
snapshot, replay retention/cursor, connection-cap and frame-limit regressions.
Host run passes 15 store/server cases. Four probe cases also pass. Renew/release
parser duplication is removed; shared event delivery is combined in the ongoing
observation integration. These changes preserve the reviewed session contract.

Continuous observation implementation is active. Main owns the monitor, transient
per-consumer projection, journal publication fence and server integration. Native
executor Singer (01a07d63-3712-7491-a7b2-5d169cf225fa) owns the production write-free
collector and focused fixture evidence. Four monitor cases pass for coalescing,
independent application readiness, stale-session rejection, revision fencing and
two-batch scheduling; the journal test verifies no manual state writes. No
production collector or packed continuous-observation acceptance is claimed yet.

Observation integration checks now cover eight monitor cases, including explicit
freshness invalidation, proven binding drift, late-failure generation fencing and
retention of concurrency slots for undrained timed-out probes. Five probe cases
cover descendant cancellation. Expanded replay regression exposed duplicated
snapshot payloads overflowing a healthy subscriber; historical events are now
compact and current projection is sent once per delivery batch. All seven socket
cases pass after that fix. Production collector remains pending with its existing
executor; main issued a convergence checkpoint to finish bounded implementation
or return the exact unresolved decision. No review or release acceptance follows
from these intermediate tests.

Continuation recovered the existing collector continuity owner Peirce
(01a07d7d-5850-77d1-9bc2-18a4c2de0954); Singer's terminal transport failure and
the single replacement are recorded in the local verification receipt. Do not
start another collector writer. Remote refresh succeeds with scoped host access;
the task branch is four commits ahead of origin/main with no target drift.

Additional socket integration proof passes: an enrolled application subscriber
receives READY then APP_ERROR while an independent runtime consumer remains READY.
The collector is injected, and the manual journal remains unchanged. An unsupported
watch deadline now fails before a successful snapshot or subscription is emitted.
All nine socket cases, the preceding 28 focused monitor/probe/journal/socket cases,
TypeScript and changed-file Biome pass. Production collection, packed continuous
observation qualification and the observation slice reviews remain outstanding.

Collector continuity attempt closed after the narrowing checkpoint did not
converge: native activity records show continued source reads without an owned
implementation artifact. This is a progress-contract failure, not a timeout
diagnosis. Shutdown is confirmed. Main now owns collector implementation and
integration; no third executor is launched. Both waiting consumer tasks received
the user-authorized status update that their prerequisites remain unreleased.

Main added the bounded process observation seam in
src/core/controller-process-observation.ts. It reads existing markers, rechecks
Linux process start identity and group ownership, and validates the process-name
and fingerprint markers. It creates no marker directories or helper locks and
uses an in-container timeout in addition to the host probe deadline. Three host
contract cases and shell syntax validation pass. Actual Linux process execution
and collector integration remain required; mocked transport is not runtime proof.
The foreground consumer-session manual now records lease and continuity rules;
docs policy and knowledge checks pass.

User reprioritized the blocking consumer fixes ahead of this package. Controller
work is parked intact in this worktree. Active source delivery is
trees/rs/consumer-startup-fixes with its own plan under docs/project, covering host
preparation before Compose and direct requested-profile recovery. Resume this
package after the waiting consumer fixes are delivered; do not claim controller
completion or lose the outstanding collector and qualification work.

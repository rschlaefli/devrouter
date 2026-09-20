# Reliable managed sessions through Devrouter 0.1.0

**Current status (2026-09-20): release delivered; reliability acceptance remains
active.** Versions 0.1.0, 0.1.1 and 0.1.2 are published and installed. The
[post-release review and follow-up backlog](#post-release-reliability-review-and-follow-up-2026-09-20)
records reproduced defects, qualification gaps and the evidence required to close
the original roadmap. Earlier delivered headings describe their bounded source
or release outcomes; they do not establish complete M1–M3 acceptance.

## Approval summary

The user approved execution of the complete consolidated reliability roadmap
through a stable 0.1.0 release on 2026-09-13. This is an **executable batch**.
The outcome is a supported managed session that starts with truthful readiness,
recovers supported infrastructure failures within a finite budget, and waits
without repeated model-driven repair when capacity is unavailable. Unknown
ownership, stopped intent and uncertain command completion remain protected.

We will extend the existing lifecycle, controller, admission and process systems.
Diagnostics and profile intent come first, alongside historical-state diagnosis.
Installed ordinary journeys precede interruption and parking qualification.
Actual harness continuation, a second consumer and harness, and measured resource
improvements complete the roadmap. Passing source tests alone cannot close a
live qualification row or establish that an affected consumer recovered.

Authority covers implementation, internal reviews, tests, ordinary branch
delivery, merges needed for the approved outcome, release publication and the
previously requested local global installation and owner coordination. Existing
consumer owners retain their source and runtime lanes. No destructive faults on
the active host, resource deletion, production work or silent controller
enrollment follows from this plan. Exact new enrollment and fault targets must
be made reviewable before their dependent actions; independent work continues.

Completion requires implemented roadmap contracts, applicable Q01–Q36 evidence,
M0–M3 acceptance, reviewed source and CI, published 0.1.0, verified installed
artifacts, and honest consumer status plus supported recovery instructions.

## Execution details

### Identity, evidence and authority

Owner and boundary owner: main Devrouter maintenance session. Native goal is
active for the complete roadmap; no token budget was requested. Branch:
`rs/reliability-0.1.0`, under `trees/rs/reliability-0.1.0`, target `main`.
Baseline: `e92903a5cc50b5b66006ba20f45b4f37eb1513ba`, published 0.0.78.
The primary checkout and all other worktrees retain their existing owners.

The governing roadmap is [PR #57](https://github.com/rschlaefli/devrouter/pull/57)
at `d2e69e2e5815fb74bf46401bf3cef5a8ab7eaeed`,
`docs/project/2026-09-06-local-environment-reliability-roadmap.md`.
Its W0–W9, S1–S8, M0–M3 and Q01–Q36 contracts remain authoritative.
This plan derives execution; it does not replace them or declare open rows passed.
The user's execution request supersedes that document's direction-only status.

Reuse the delivered contract foundation, lifecycle integration, controller
observation, capacity admission, rollback recovery and installed qualification
plans listed there. Historical headings do not prove implementation is missing.
The first source inventory confirmed existing output bounds, version diagnostics,
repair refusal and profile resolution; extend those seams instead of duplicating them.

Routine source decisions and internal derived-plan reviews do not require another
generic approval. Pause only the dependent action for a material new policy,
data boundary, operational target, destructive effect, cost or incompatible
contract. Preserve required human forge reviews. No new peer task is necessary:
use bounded native children and existing consumer owners.

### Primitive impact and contract decisions

| Product primitive | Disposition | Binding contract and consumers |
| --- | --- | --- |
| Managed environment | Reuse | Exact checkout, provider and retained-resource ownership; no adoption from route absence alone. |
| Lifecycle operation | Extend | Values-free phase and refusal evidence, preserving identity, timeout, stop and uncertain-dispatch semantics. |
| Profile | Reuse initially | Explain reserved managed `full` expansion and named defaults without changing existing selection. A compatibility change requires its own explicit migration decision. |
| Capacity reservation and incident | Extend only missing behavior | Existing durable charges, retry budgets and protected intent govern parking and resume. |
| Consumer session and readiness | Compose | Fresh capability proof plus enforcing harness wait/cancel/reconnect; a prose instruction is not enforcement. |

Existing ADRs govern ownership and profile-plan semantics. The first diagnostic
slice changes no architecture. Later controller/harness contract deltas receive
an internal design and ADR-gate review before implementation, within this batch.
Capacity work retains [ADR 0008](../adr/0008-model-reliability-before-runtime-activation.md)'s
approved declared-budget guarantee, including its physical-memory limitations.
Inventory every parsed scheduling/recovery field against its runtime consumer
before enrollment. Existing dwell and lease constants are observed behavior to
reconcile, not newly selected policy values.

### Delegation map

| Slice | Accountable owner | Dependencies and bounded child contribution |
| --- | --- | --- |
| 1 — diagnostics and profile evidence | main | Published source baseline; executor owns disjoint profile reporting and tests. |
| 2 — historical state | main | Named saved receipts; trusted read-only child may trace producing authority. |
| 3 — ordinary installed journey | main | Slice 1; executor may extend fixture scripts, existing consumer owns semantic smoke. Unresolved slice 2 does not block a clean canary. |
| 4 — controller, capacity and parking | main | Slice 3 before live faults; source inventory/deltas proceed independently of slices 2 and 3. Executor owns settled disjoint deltas and fixture tests. |
| 5 — harness and M1 | main | Slice 4 and qualified API; executor owns the selected adapter. |
| 6 — breadth and measured improvement | main | M1 baseline; executor owns independent fixtures and measurements. |
| 7 — release and reconciliation | main | All required slice acceptances; main owns external effects and final proof. |

Each slice has one accountable owner. Main retains unresolved policy, lifecycle
integration and live proof for critical-path coupling; bounded child assignments
name disjoint files and never share write ownership with main.

### Ordered slices and verification

The sequence below is finite. Each substantive slice is committed and reviewed
before the next coupled slice. Derived implementation detail is internally
hardened as evidence resolves it; this does not reopen the approved batch.
Use one implementation branch for this package. If reviewability requires
sequential milestone PRs, keep this shared plan with their source and progress;
do not create or merge a plan-only PR.
Before coding a derived delta, record exact existing and new paths, one writer,
dependencies, portfolio references, acceptance and stop conditions in this plan.
Internally harden material new contracts before implementation. This is a batch
checkpoint, not a new generic user-approval gate.

1. **Actionable diagnosis (W1/W5/W7).** Extend existing
   `workspace-ensure.ts` repair refusal with bounded machine reason identifiers
   for profile, each desired resource dimension, source/effective configuration
   and generated-file evidence. Preserve exact refusal and short-circuit safety.
   Extend `profile-resolution.ts`, `commands/profile.ts` and existing doctor
   reporting to expose ignored managed `full` dimensions and a named-default
   remedy. Report installed CLI and repo adaptation metadata separately, without
   treating an older repo pin as a runtime failure. Extend lifecycle worker/context
   progress with allowlisted phase and child role, monotonic elapsed duration and
   explicit stale/unknown evidence, never raw argv or environment values.
   Named new module if required: `src/core/lifecycle-progress.ts`, shared by
   ensure/stop and worker reporting, with
   `src/core/__tests__/lifecycle-progress.test.ts`. Existing
   buffer limits and controller output are reused. Route: executor for profile
   report; main for coupled worker/refusal seam. Acceptance: existing profile,
   doctor, ensure, worker/controller output suites and packed CLI output contract.

2. **Historical recovery (W1/W3a/W4, S2).** Inspect only named saved mismatch
   receipts and exact ownership/configuration evidence. Reproduce in the existing
   config-drift qualifier, preserving live-worker/unknown-resource refusals.
   Implement the smallest recovery justified by producing authority; if that
   authority is unavailable, retain the refusal and present a reviewed exact
   recovery design for that cohort. This is not permission to fabricate provenance
   or delete retained state. Route: main because ownership/design is unresolved.
   Acceptance: regression plus failure/partial-stop and stale-receipt rejection.

3. **Ordinary installed session (W2/W4/W5/W7/W8, S3).** Reuse installed package
   qualifiers and the established eLearning canary after owner readback. Select
   exact toolchain/profile and synthetic semantic/retention smoke. Prove cold,
   warm, stop/resume, trusted TLS, failed application readiness without speculative
   infrastructure repair, effective binary/helper compatibility, and exact stop.
   Route: main for live ownership; executor for isolated fixture changes. Record
   first attempts and separate all timing cohorts. This is the prerequisite for
   live fault qualification, not for independent controller source work.

4. **Interruption, admission and parking (W3b/W6a/W8, S4–S6).** Inventory
   executable obligations against existing controller/capacity plans. Close
   uncertainty and residual-charge gaps before adding policy-authorized parking
   and resume. Isolated faults prove stop precedence, same incident budget,
   positive resource release, no safe victim, stale telemetry, crash/sleep,
   protected neighbour and retained synthetic application data. No active-host
   OOM or disk filling. Record exact pressure source and policy guarantee before
   enrollment. Route: main for policy and seam; executor for settled deltas.

5. **Enforcing harness and M1 (W9, S7–S8).** Qualify a real installed harness
   API before choosing adapter files. Compose existing session/operation state
   with no-model waiting, cancellation/redirect fencing, snapshot reconnect and
   deduplicated continuation. Never replay uncertain writes. Run the two-environment
   Q36 journey and disposition every Q01–Q36 row with producing evidence.
   Route: main for support contract, executor for adapter once settled.

6. **Breadth and measured improvement (M2–M3, W4/W5/W6b/W7/W8).** Qualify a
   distinct non-Node consumer and second actual harness. Reuse small synthetic
   fixtures unless an existing consumer owner supplies a suitable isolated lane.
   Measure readiness, preparation reuse, memory and latency before profile or
   artifact optimization. The roadmap's provisional timings are hypotheses.
   Default qualification counts remain twenty routine and ten selected fault
   repetitions; an expensive fixture needs a recorded scoped alternative.
   Route: executor for fixtures/measurements, main for acceptance and optimization.

7. **Release 0.1.0 and adoption.** Review the integrated source and all required
   evidence; resolve CI and human review, merge approved source, create the
   separate release-artifact commit and publish through the repository workflow.
   Verify registry integrity and the installed local executable/helper artifacts.
   Coordinate supported recovery/dogfood with existing task owners, recording
   unresolved application or ownership blockers independently. Route: main.

### Test portfolio and release gates

| Risk | Obligation and stable seam | Distinct failure caught |
| --- | --- | --- |
| Misleading refusal/progress/profile | Extend existing ensure/profile/doctor/worker tests; add protocol coverage only if existing suites cannot protect the progress contract | Hidden resource expansion, indistinguishable mismatch, leaked args, false fresh child evidence. |
| Historical ownership and residual state | Extend existing recovery and config-drift qualifier | Unsafe adoption or stop success while retained resources remain unproven. |
| Readiness and preparation | Extend existing readiness/helper suites plus installed semantic fixture | Root-only false success, dead child, corrupt preparation stamp or lost synthetic record. |
| Capacity, intent and uncertainty | Extend existing model/lifecycle/controller/capacity suites plus isolated provider journey | Early charge release, cancelled resurrection, uncertain write replay, neighbour preemption. |
| Package compatibility | Extend existing package/upgrade/worker suites and installed package smoke | Shadowed binary, helper or state protocol mismatch. |
| Actual harness enforcement | Add new adapter protocol tests and actual installed API/trace qualifier after API selection | Tool gate bypass, duplicate continuation, cancelled task resume. |
| Real-provider safety | Add new live qualifier only if existing scripts cannot express the Q matrix; select its exact path before implementation | Synthetic mocks conceal lost records, survivor charges or neighbour disruption. |
| Documentation and roadmap status | None; existing docs/knowledge policy, links and diff inspection | Conflicting support or completion claims. |

Derived slices consume this portfolio. Any new independent test obligation needs
an internally reviewed amendment. Each receipt links to the complete Q contract
in the governing roadmap; this matrix assigns responsibility and required layers.

| Q rows | Owning slice / workstream | Required evidence and applicability |
| --- | --- | --- |
| Q01–Q06, Q24–Q26 | 3; W2/W4/W5, S3 | Source plus installed fixture and real semantic consumer proof for the selected cell. |
| Q07–Q16, Q21–Q23, Q33–Q35 | 4; W3b/W6a/W8, S4–S6 | Source plus installed qualifier and isolated live-provider faults; host pressure is injected through the qualified test boundary, never host exhaustion. |
| Q17–Q20, Q31–Q32 | 4; W0/W3b, S4 | Source race/clock/storage tests, installed controller restart/event proof and applicable isolated live-provider journey. |
| Q27–Q28 | 1 and 3, with 3 accountable for integrated acceptance; W1/W7 | Source privacy/bounds and installed effective artifact/protocol evidence. |
| Q29–Q30, Q36 | 5; W9/W8, S7–S8 | Actual installed enforcing harness traces and real two-environment semantic proof. |

Slice 5 integrates all Q rows for M1; slice 6 requalifies affected rows for M2/M3.
Every receipt records applicability for its exact selected cell. Unsupported or
skipped evidence cannot waive a required row of that cell. Apply twenty routine
and ten selected deterministic fault repetitions to M1 and subsequent support
qualification; justify any lower sample plan before its producing run.

Run applicable docs-policy, knowledge, Biome, knip, typecheck, tests, build and
package smoke before delivery. Native host source checks apply: this repository
has no own devcontainer. Linux helper/provider behavior needs actual Linux proof.
Routing/devcontainer smoke touches shared services and must use exact lifecycle
ownership with final non-destructive stop. Record every Q row as source, installed
fixture and live evidence separately; unknown/skipped is never a pass.

### Progress

Status: slice 4 (parking/resume integration), the agent-facing status slice and
the production-directive success coverage are delivered; scoped and windowed
recovery budgets are next. Source is reviewed and CI-green at
`2cae3f76145c574601ed438fed9b9d72a768068c` with 2,545 tests in 143 files.
Delivered prerequisites include diagnostics, submission/recovery fences, durable
human pins and consumer consent, controller/capacity history-loss refusals,
pressure-duration evidence, exact-set parking observation, restart-stable bindings
and exact retained-consumer withdrawal. CI 34769082566 also passes Linux helper,
package and installed controller/capacity qualification.

Park/resume model and lifecycle preparation landed in `2f09de0`: resume is an
intent change that earns admission through the ordinary queue instead of
presuming it, park commits settled intent and keeps its charge until physical
cessation, a crashed park is re-proven physically, and a resume that cannot keep
its queued operation returns to parked intent.

The controller capacity pass landed in `b9b0429`. The monitor supplies the exact
same-store, same-epoch, same-parkingRevision consumer set and the live demand for
it; the controller resolves the enrolled target, policy revision and reservation,
commits intent under the journal lock, and drives one non-destructive lifecycle
worker per pass with single-flight per incarnation and five-second spacing.
`34dfbde` gives the two durable-burst controller fixtures the same bounded test
deadline the sibling cursor-replay fixture already carries, keeping every
assertion. 2,557 tests pass in 143 files, and the focused controller and
reliability suites pass with a host context for process-identity inspection.

One pre-existing fixture stays load-sensitive on a contended host: the watch gap
fixture performs 257 synchronous durable renewals, measured at 2.3s in isolation,
against the protocol's own five-second watch client deadline. The test cannot
raise that deadline because the client deliberately refuses a caller deadline
longer than the watch lifetime. It fails only under full-suite parallelism and is
byte-identical to its CI-green revision, so measured optimization owns the real
fix.

Review state: the configured slice-reviewer route returned late with
`DONE_WITH_CONCERNS` and one blocker, so the slice remained open. The configured
simplifier role failed on the account's ChatGPT usage limit, and the
opencodex-routed substitute reviewer then failed with 429 responses; each
substitution is a material difference from its configured role. The simplifier
substitute did complete read-only over `2cae3f7..34dfbde` with no blockers and one
substantive follow-up: the production `capacity` directive had no test, so the
proof covered the monitor side and the reliability model rather than the
controller's own park, parkedStop and resume decisions. `22ff5f5` closes the
refusal half of that. Five tests prove parking refuses before target resolution
while recovery is disabled, refuses an unenrolled environment, and refuses without
sustained pressure evidence; that resume refuses without normal dwell; and that a
parked stop refuses after a policy change. Two assertions pin which gate refused,
so the recovery-disabled case fails if that guard is removed. The success path now
has coverage: `ce7d683` proves a park resting on 2s of tracker-accumulated pressure
commits intent and drives exactly one stop with the exact identity, policy
revision, revision and failed-capability gate, and that a resume resting on 3s of
normal dwell enqueues one automatic resume. Each assertion fails if its pressure
gate is weakened, because the driven samples only reach the window through the
real collector cadence.

`404fc8d` closes the blocker and both should-fix items. Blocker: an incomplete
committed park was re-driven only from the live session snapshot, so a crash after
the park committed but before physical cessation could hold the charge
indefinitely once the controller restarted or the last session expired. The
monitor now enumerates the durable journal for a capacity-managed
`parked-for-capacity` record whose stop proof is incomplete and re-drives it by
identity, independent of the snapshot, with the controller re-proving the record
transactionally under the same policy, controller and worker fences. Should-fix:
an automatic resume that expired in the capacity queue now returns to parked
intent through the same proof the synchronous enqueue-failure path uses, so it can
no longer strand running intent no worker will honor, and the pass now carries the
monitor lifetime signal that `stop()` aborts in place of the inert controller.
Two accepted simplifier findings landed there as well: `environmentIdentity` is
shared across the monitor, controller and server instead of three inline copies,
and the dead abort is gone. The pure-consolidation simplifier items were deferred
deliberately: a shared decision-slot preamble and removing two behaviorally inert
`readPressure` guards would restructure code a review just accepted without a
correctness signal that outweighs the churn.

Regression evidence for `404fc8d`: `controller-monitor` proves the orphan stop is
re-driven when no live session remains, drives exactly one stop per pass with the
exact journal identity, and skips a park whose proof is complete; `capacity-queue`
proves an expired automatic resume returns to parked intent while an operator
ensure in the same state does not, and that a mismatched automatic-resume
reference is rejected. 449 tests pass across the ten capacity, controller and
reliability files with a host context for process-identity inspection; typecheck,
repository Biome, Knip and the docs-policy check are clean.

Slice review of `404fc8d` returned DONE with no blockers. The reviewer confirmed
that the durable re-drive re-proves every policy, controller, worker, revision,
enrollment, drain and physical-cessation fact under the per-journal lock; that
the live loop now resumes only settled parks while the scan is the sole,
throttled re-driver; that the lifetime signal refuses to start a decision after
shutdown yet leaves an already-dispatched stop unsupervised, which the physical
serialization and fence claims make safe; and that the automatic-resume restore
is fence-pinned and lifecycle-tested. Three non-blocking notes remain: a human pin
set after a park commits cannot cancel the owed stop, which matches
commit-then-prove semantics; a transient journal enumeration failure delays the
next scan by ten seconds, which stays fail-closed; and a restore that itself
throws leaves running intent for an operator ensure to supersede.

Focused evidence for the delivered range: `tsc --noEmit` clean, `biome check`
clean over the repository, and 385 tests pass across the eight capacity,
controller and reliability files. The full suite still carries the watch gap
fixture above, so it is not yet a green signal on this host.

Scoped and windowed recovery budgets are delivered at `08c8910`. Policy's
`maxProcessRestarts`, `maxServiceRestarts` and `windowSeconds` now bound one
incident: the recovery write claims the one declared resource the producing
capability names together with the aggregate count, and refuses without a write
when the per-kind allowance, the aggregate cap or the incident window is
exhausted. Section 9.3's meaning is unchanged; the named action-scope contract
is recorded under `Scoped recovery budget (delivered)`.

The installed Devsy harness surface is delivered and live-qualified under
`Installed Devsy harness version policy (delivered)`: a host CLI newer than the
pin is accepted, governs its own agent, and doctor reports the drift as a
non-blocking warning, so managed environments start again on this host. Next
slice: harness enforcement and M1 qualification, with 0.1.0 as the terminal
release. Remaining open items listed with the portfolio
still apply — production park/resume, lost-identity/history reconciliation,
actual harness enforcement, consumer breadth and measured optimization — and the
release has since shipped: 0.0.79 is merged, published and installed, and the
recorded consumer stop settled under live proof (see `0.0.79 release and consumer
dogfood`). Host SSH signing still refuses, so repository pushes use the
authenticated `gh` credential helper over HTTPS.

The agent-facing status gap is implemented (status slice, follow-on to
`404fc8d`). `devrouter status` now attaches a read-only `reliability` block for a
managed environment with a durable journal: desired intent, phase, capacity
admission and charge, the corrective-action budget and, when the recorded intent
cannot progress, a fixed attention reason with the supported `devrouter stop`
and `devrouter ensure` recovery commands for that exact checkout. The reason is
derived only from durable lifecycle state through `reliabilityAttention`, so a
parked, waiting, blocked or mid-operation environment is explainable with no live
session; the block is omitted when provider or journal evidence is unavailable and
never mutates state. `projectReliability` continues to produce
`PARKED_CAPACITY`, `WAITING_CAPACITY`, `BLOCKED` and the admission reason for the
controller, lifecycle and qualification consumers. Regression evidence:
`reliability-output` proves every attention reason and the settled/healthy cases;
`managed-runtime-status` proves the parked recovery command, the
`COMPLETION_UNKNOWN` stop-and-repair path and omission without a provider. 36
tests pass across the status, output, reliability-output and managed-runtime-status
files; typecheck, Biome, Knip and docs policy are clean.

All seven slices retain integrated or live obligations. Production park/resume,
scoped/window recovery budgets, lost-identity/history reconciliation, actual
harness enforcement, consumer breadth and measured optimization remain open.
Codex 0.154.0-alpha.6.2 app-server initialization is unverified: both stdio and
Unix transport probes time out without model turns. Claude 2.1.266 with isolated
SDK 0.2.152 passes actual initialization with zero model turns; tool gating and
continuation remain unverified. Its documented approval callback alone cannot
gate already-approved tools.
Live eLearning canary startup still awaits the explicit approval requested after
automatic review rejected it; no consumer recovery is inferred. Goal remains
active through published and installed 0.1.0 and full roadmap qualification.
Published baseline is 0.0.78; global installation last verified at 0.0.77.

Fresh fetch confirms origin/main `e92903a`; the task worktree uses pinned
Node24.16.0/pnpm11.6.0. Source changes stay in the existing task worktree.
The earlier eLearning owner receipt confirms
the established canary checkout is clean and available; no fresh semantic proof
was supplied. Other owner-retained manual-verification environments are protected.

Planner construction completed. Round 1 requested explicit accountable owners,
portfolio obligations, derived-delta checkpoint, ADR binding and Q evidence
ownership; all five findings were accepted in this revision. The same planner approved the corrected draft in round 3; implementation reviews remain required. Prior roadmap reviews covered direction
only. Current next action: implement the internally hardened
positive legacy-journal loss detection and continue exact-set parking and full-roadmap integration. Historical ownership and live qualification remain open.

Slice 5 now has its two-environment journey. `scripts/qualify-harness-journey.sh`
runs the installed Claude Code harness against a mock Messages API with the
shipped gate as the repository `PreToolUse` hook, and all three scenarios pass
with clean checkouts, an unmoved neighbour and no agent infrastructure repair; the
journey exposed and fixed a phantom wait that counted the gate's own cold identity
resolution against the wait budget. Published baseline and both global installs
are 0.0.79; 0.1.0 remains the terminal condition.

### Pruned managed population stop (delivered)

A consumer checkout proved the next blocking class: Docker pruning removed every
managed container while its Devsy registration survived. `devrouter stop`
re-proved the retained population, found it empty, and refused; the journal stayed
in `stopping`, so admission kept refusing `ensure` and neither command could
advance. Recreating the containers cannot recover this, because a recreate yields
new container IDs that the same identity proof refuses, and `stop --delete`
worked only by discarding the registration.

Delivered at `90c4188`: `proveManagedStop` settles an unchanged registration whose
saved containers, checkout container population and provider runner are positively
absent across two stable observations as proven-absent. The pinned endpoint and
daemon must still match the baseline, the provider must still select the local
Docker command, and the retained generation must be unchanged across inspection.
Every other combination keeps the retained proof and its refusal, including a
partially surviving population, a replacement with a foreign ID and a primary
checkout. The recorded baseline and interrupted history remain; only routes are
freed, and the result reports `runtimeAbsent` without a provider mutation.

Regression evidence: 13 consequential tests in `managed-stop-recovery.test.ts`
cover the pruned positive plus eleven refusals. Full suite 2585 tests in 143 files
passes with two workers; typecheck, repository Biome, Knip, docs policy, knowledge
validation, build and the isolated packed CLI smoke are clean. This is source
evidence only: no consumer runtime was touched, so no affected checkout is
reported as recovered.

### Scoped recovery budget (delivered)

This was the named action-scope contract the slice required before coding.
Originally policy parsed `maxProcessRestarts`, `maxServiceRestarts` and
`windowSeconds` while runtime consumed only `maxCorrectiveActions`, so the parsed
limits were reserved rather than enforced and no consumer could claim otherwise.

Contract. The action unit is the repository-declared resource a corrective
mutation will touch: one logical process from the managed process set, or one
retained service from the resolved service set. Its key and kind come from the
exact prepared resource plan the recovery already resolves, mapped from the
producing failed capability, never from a process listing and never as a
`min(process, service)` proxy. The controller only ever delivers
`controllerCapability(selector)` hashes, so the unit key is recovered inside the
lifecycle layer by recomputing that hash over the repository-declared process and
service selectors and matching the producing capability; no raw selector or
process listing crosses the boundary. The unit is claimed durably under the existing
per-journal file lock immediately before each mutation; the claim increments the
unit counter and the aggregate `correctiveActionsTaken` in the same write,
refuses when `maxProcessRestarts` (process) or `maxServiceRestarts` (service) is
exhausted, refuses when the aggregate limit is exhausted, and refuses an action
older than `windowSeconds` from the incident start. Unknown completion consumes
the claim and never refunds it. Active time excludes capacity waiting and uses
only tracker monotonic duration and `observationsAfterMs`; unobservable worker
time fails conservatively and neither extends nor replenishes a budget. One
bounded half-open trial may run after a sustained healthy interval; a failed
trial returns to exhausted without raising the limit. Window expiry alone never
erases an exhausted incident or a user stop.

Durable shape. `ReliabilityIncident` gains `startedAtMs` and a bounded,
key-unique `units` array of `{ key, kind: "process" | "service", actions,
lastActionAtMs }`. The change is additive; because `assertReliabilityState`
validates a field whitelist rather than exhaustively rejecting unknown keys,
records written before the field exists stay valid with zero actions at the
incident start, so no `contractVersion` bump or migration is needed. A new pure
module `src/core/recovery-budget.ts` owns derivation, claim and window math;
its test is `src/core/__tests__/recovery-budget.test.ts`. Existing paths touched:
`capacity-policy.ts`, `reliability-contract.ts`, `reliability-model.ts`,
`reliability-lifecycle.ts`, `reliability-worker.ts`, `capacity-controller.ts`,
`reliability-output.ts`. One writer: main.

Acceptance. `recovery-budget` proves unit-key derivation, per-unit and aggregate
refusal, inside/outside window boundaries, unknown completion consuming a claim,
capacity-wait exclusion and conservative unobservable time. `reliability-lifecycle`
and `reliability-worker` prove the claim is checked before each mutation and that
a refused claim leaves the environment unchanged. `capacity-controller` and
`reliability-model` prove `maxCorrectiveActions` remains the aggregate ceiling and
that the parsed per-unit fields now have a production consumer. Existing
reliability suites stay green; typecheck, Biome and Knip stay clean.

Stop conditions. Stop and re-present the contract if defining the unit would
require inferring commands from a process listing, if the claim cannot be made
durable under the existing journal lock, if enforcement would weaken any
fail-closed check for live workers, unknown ownership or surviving resources, or
if it would require a contract version bump or a data migration.

Delivered at `08c8910`. `recoverySelectors` splits the repository-declared
`app:<name>` selectors by the plan dimension that backs them — an upstream alias
naming a declared retained service is a service unit, every other ready proxied
app is a process unit — and `deriveRecoveryUnit` recovers the unit key by
recomputing `controllerCapability` over those selectors and matching the
producing failed capability inside the journal transaction. `claimRecoveryUnit`
increments the unit record and `correctiveActionsTaken` in the same write,
refuses `window-closed`, `unit-exhausted` or `budget-exhausted` without mutating
the incident, history or operation slot, and never refunds an unknown completion.
Unattributable capabilities and unreadable configuration keep the aggregate
ceiling alone; `activeElapsedMs` is `null` today because capacity waiting is not
yet observable to the claim, so the window falls back to conservative wall
duration. The dispatch-time increment moved to this claim, so an incident opens
at one action once the recovery it admitted is prepared. The projection carries
`startedAtMs` and bounded unit records with opaque keys only, and
`assertReliabilityState` validates the additive fields without a contract bump.

Regression evidence: 13 `recovery-budget` tests plus updated model, lifecycle,
liveness and capacity-controller suites; the full suite passes 2603 tests in 144
files with two workers; typecheck, repository Biome, Knip, docs policy and
knowledge validation are clean. The capacity-controller suite proves the call
site passes the policy limits and the derived selectors and that an unreadable
configuration degrades to the aggregate ceiling. This is source evidence only;
no consumer runtime was touched, and the branch push is still blocked by the
host SSH agent.

### Installed Devsy harness version policy (delivered)

Problem. Devsy.app updates itself, so the host CLI can move ahead of the
release pin at any time. This host runs Devsy 1.19.0 while
`SUPPORTED_DEVSY_VERSION` is `1.16.2`; `inspectDevsyAgent` compares for equality,
so `global.devsy-agent` is an error and `requireReadyDevsyAgent` throws before
`startDevsyWorkspace` takes the mutation lock. No managed environment can be
created or recovered on this host — the class of failure the 0.1.0 goal calls
out — while stop, delete and ordinary reads still work.

Qualified surface (live, read-only, 2026-09-19, CLI 1.19.0). `devsy --version`
still prints a parseable `v1.19.0`; `devsy workspace list --result-format json
--skip-pro` returns the same array shape with `id`, `uid`, `source.localFolder`,
`provider.name`, `provider.options.DOCKER_PATH.value`, `context` and `lastUsed`;
`workspace up --help` still documents `--devcontainer`, `--id`,
`--provider-option`, `--recreate`, `--workspace-env` and `--ide-launch`;
`workspace delete` keeps `--force` and `--ignore-not-found`; `workspace status`
keeps JSON output. The 1.19.0 binary still references `DEVSY_AGENT_BINARY`, and
the verified v1.16.2 Linux agent is present in the managed cache.

Contract. Three tiers, compared on the numeric version core. A version older
than the pin stays `stale` and refuses: the release does not claim an unverified
older surface. The exact pin keeps today's behavior: the managed, hash-verified
agent is injected through `DEVSY_AGENT_BINARY`. A newer version is `ready` with
an explicit drift record naming both versions; Devrouter injects nothing and the
host CLI governs its own agent, because pairing the newer CLI with the pinned
agent is an unverified splice in either direction. Doctor reports the drift as a
non-blocking `warn` that names both versions and states the agent is not
Devrouter-verified; it never blocks `ensure`. An operator-supplied
`DEVSY_AGENT_BINARY` keeps its authority in every tier and is validated exactly
as today. An unparseable version stays `stale`. No download behavior changes.

Paths. Existing only, one writer: main. `src/core/devsy-agent.ts` (tiering,
drift record, repair text), `src/core/devsy-mutation.ts` (inject only a verified
agent), `src/core/tool-diagnostics.ts` (warn tier), plus
`src/core/__tests__/devsy-agent.test.ts` and
`src/core/__tests__/tool-diagnostics.test.ts`. No new module or dependency.

Acceptance. Unit tests cover the three tiers, an explicit binary in each tier,
an unparseable version, and the repair suggestion. A live synthetic
qualification starts a managed workspace on this host under the drift tier,
proves the runtime reaches the running state, and then stops and deletes it with
the ordinary commands. Stop conditions: if neither agent strategy starts a
workspace under 1.19.0, stop and re-present the policy instead of weakening
verification; if the newer CLI ignores an explicit `DEVSY_AGENT_BINARY`, keep
that tier fail-closed and report it.

Delivered with this change. Live qualification on this host, all in
`/private/tmp/devrouter-devsy-drift-qualify` with the built local CLI: doctor
reports `global.devsy-agent` as `warn` with `state=ready, source=host,
version=1.19.0` instead of the former error; `ensure` started the workspace with
the host-governed agent, reached `ready` with container id `f1715727400e`, and
returned the primary result; `exec` printed `drift-qualified` inside the running
workspace; `stop` returned `stopped: true`; `devsy workspace delete` plus
re-inspection proved the registration and containers absent, and the scratch
paths were removed. Two fixture lessons worth keeping for later harness
qualification: an image-only devcontainer carries no Compose identity, and a
Compose-based one must declare the workspace bind itself. Both failures were the
fixture rather than the CLI version, and devrouter's existing identity proof
surfaced each one precisely.

Related host condition observed during qualification: `doctor` reports
`global.capacity-ledger` as `capacity-history-unprovable` (error) while a primary
legacy `ensure` still starts and stops normally. That residual history gap
belongs to the lost-identity/history reconciliation slice; the qualification
neither cleared nor repaired it.

### 0.0.79 release and consumer dogfood (delivered)

PR #100 merged to `main` as `d34b9c8` after CI run 35467954321 passed on the
release head; [v0.0.79](https://github.com/rschlaefli/devrouter/releases/tag/v0.0.79)
was published through the repository workflow (run 35468199788), and the registry
serves `@devrouter/cli@0.0.79` with `latest` moved. This patch release ships the
delivered reliability contracts. The 0.1.0 milestone keeps its full-roadmap
terminal condition, so harness enforcement (W9), consumer and harness breadth
(M2–M3), production park/resume enrollment and lost-history reconciliation stay
open.

Two global installs exist on this host and both now resolve to 0.0.79: the
Homebrew npm prefix `/opt/homebrew/lib/node_modules/@devrouter/cli`, which is
first on the default PATH, and the Volta image prefix. The stale Homebrew install
resolved the consumer's first stop attempt to 0.0.77, which refused correctly for
its older proof. Upgrade both prefixes after a release and check `devrouter -V`
from the consumer checkout, because a repository Volta pin changes PATH
resolution and can hide a stale install.

Consumer dogfood used the recorded pruned-population case
`/Users/rschlae/Git/klicker/klicker-uzh/trees/rs/custom-chat-modes` (journal
`7b441a9e…`, `desired: stopped-by-user`, phase `stopping`, nine baselined
containers, Devsy registration surviving with `uid default-rs-01923` on pinned
endpoint `unix:///Users/rschlae/.orbstack/run/docker.sock`, daemon `ded85e46…`).
`devrouter stop` on the released CLI settled it as proven-absent: `stopped: true`,
`runtimeAbsent: true`, six routes freed, journal now `idle` with `stopProof
{ workloadsStopped: true, routesRemoved: true }` written by 0.0.79, no workspace
reference left in the Traefik dynamic file or host-route state, zero live routers,
and `devrouter workspace ls` reporting `present devpod:owned 0 route(s)` with
`Runtime status stopped`. No consumer container, volume, worktree or staged
change was touched, and the citation checkout was neither inspected nor modified.

### CLI path shadow diagnosis (delivered)

The stale-install hazard recorded above became a first-class non-blocking
diagnosis on branch `rs/cli-path-diagnosis`: `devrouter doctor` reports
`global.cli-path` by enumerating every executable `devrouter` on `PATH`,
deduplicating by realpath, and comparing each install with the running CLI. It
warns when another install is newer than the CLI that is diagnosing, or when the
shell-resolved install differs; it stays `ok` when every install matches. The
probe is a read-only `-V` that tolerates the non-zero exit version printing
still produces outside a repo, and the whole comparison is skipped for unstamped
source builds. Evidence: 2616 tests pass, and synthetic doctor runs warned for
0.0.70 and 0.0.99 installed first on `PATH` while staying `ok` for the two real
0.0.79 installs on this host. Harness enforcement (W9) remains the next slice
toward 0.1.0.

### Harness gate and hook-contract qualification (delivered source)

Slice 5 opened with the required harness API qualification. The installed Claude
Code 2.1.278 was exercised against a local mock Messages API (its OAuth token is
expired, so a live model turn needs the user to re-authenticate), with a real
`PreToolUse` hook process. Five findings, each reproduced:

1. A `PreToolUse` hook fires even for a pre-approved tool
   (`--allowedTools Bash(echo:*)`), and its `deny` overrides that pre-approval.
2. A sleeping hook blocks the tool call with no model turns: three seconds of
   hook sleep produced a 3.7s gap between the two API calls of the turn.
3. `permissionDecision: "deny"` prevents execution and the reason string reaches
   the model as that tool's result.
4. The hook payload carries `session_id`, `prompt_id`, `tool_use_id`, `cwd`,
   `tool_name`, `tool_input` and `permission_mode`.
5. Hook `timeout` is not a gate: a hook that overran its configured 5s timeout
   was not honored, and the tool proceeded under the harness's normal permission
   rules. The gate must therefore finish inside its hook timeout, and the bundled
   snippet sets a timeout above the wait budget.

Branch `rs/harness-gate` adds `devrouter harness gate`, the deterministic
enforced-wait boundary those findings select. It observes the exact checkout's
durable phase through the existing reliability journal, defers inside the hook
process under a bounded budget, allows the tool once the phase settles, refuses
once with recovery guidance when the budget is exhausted, always passes lifecycle
commands through, and fails open when journal evidence is unreadable because
blocking agent tooling on unreadable devrouter state is the failure mode this
boundary exists to remove. Focused coverage is 16 unit tests: the phase table,
deferral until settlement, budget exhaustion, a zero budget, unknown evidence,
the repo-root walk, passthrough, and both output contracts.

Live chain proof (2026-09-19) wired that build as the real `PreToolUse` hook of
Claude Code 2.1.278 running against the local mock Messages API, with a fixture
checkout and a test-owned journal written through the reliability store. Four
scenarios passed: a settled journal allowed the tool and the model turn finished
in 2.2s; a `stopping` journal that settled after 6s under the 30s budget
returned `deferred-allow` ("settled after 6.0s") with the tool executing
afterwards and no model turns consumed while the hook blocked (the API gap grew
to 6.3s with the same four requests); a `starting` journal under a 5s budget
returned one `deny` naming the phase, which reached the model as an errored
tool result with no execution; and a deleted journal allowed the tool, proving
the fail-open path end to end. The proof also caught that the progress line
announced a deferral for the already-settled `stable` phase; the announcement
now fires only for transitional phases. Reproducible assets sit in
`/private/tmp/dr-harness-probe/chain/` (`run-gate-chain.sh`, `journal.mjs`,
`hook-gate.sh`, `settings-gate.json`) and need no credentials.

Cancellation fencing, continuation dedup, a second harness and the live
two-environment Q36 journey remain open. The mock Messages API qualifier path
stays reusable for them without credentials.

### Harness continuation fencing — frozen derived contract

Slice 5 continues with the missing half of the enforcing wait: cancellation
fencing, snapshot reconnect and one-time continuation. The delivered gate
decides every tool call independently, so a harness that re-delivers the same
call after a grant, or that resumes a call whose deferral it cancelled, can
double-apply a mutating command. The roadmap's S7 acceptance names this
(one-time continuation) and its risk row names the failure (duplicate
continuation, cancelled task resume).

Existing paths: `src/core/harness-gate.ts` (phase observation and wait),
`src/commands/harness.ts` (payload parsing, decisions, output),
`src/core/file-lock.ts` (`withFileLockSync`), `src/core/atomic-file.ts`
(`writeFileAtomically`), `src/core/router.ts` (`DEVROUTER_HOME`),
`src/core/workspace.ts` (`comparableWorkspacePath`). New path:
`src/core/harness-continuation.ts`, the only writer of the ledger, with
`src/core/__tests__/harness-continuation.test.ts`. `commands/harness.ts`
extends its existing single writer; no new command or flag.

Contract. A bounded private ledger under
`$DEVROUTER_HOME/harness/<sha256(realpath)>.json` records at most one entry per
harness `tool_use_id`, and only for calls whose wait actually started. Settled,
unknown, unmanaged, passthrough and invalid-payload decisions stay
side-effect-free.

- The gate claims the call before deferring. A repeat of the same
  `tool_use_id` returns exactly one deny whose reason distinguishes "already
  permitted" from "cancelled mid-wait" and asks the agent to verify whether it
  ran and to issue a new call if it did not. Repeats never wait again, so a
  reconnect cannot extend or restart the wait.
- The claim records the payload SHA-256 (the tool input as delivered), the
  observed phase, the budget and claim time. The entry settles to `granted` or
  `refused` with the waited time when the wait finishes, and to `interrupted`
  when the hook process receives SIGINT or SIGTERM while waiting.
- Entries expire after 24 hours and the ledger keeps the newest 64. Unreadable,
  foreign-schema or oversized evidence is treated as absent; the call then
  proceeds under the ordinary wait contract. Ledger failures never change the
  decision outcome or block the agent.
- A payload without `tool_use_id` cannot be keyed, so it keeps the wait-only
  behavior. The limitation is documented rather than approximated by hashing
  the command, which would collide with deliberate repeats.

Acceptance: unit tests for claim-before-wait, replay deny for `granted` and
`interrupted` entries, expiry and bound pruning, unreadable evidence, missing
`tool_use_id`, signal handling and the unchanged settled, unknown and
passthrough paths; direct-CLI live proof over the built binary (deferred grant,
replay deny, SIGTERM mid-wait then replay, fresh call unaffected); typecheck,
Biome, Knip, full suite and package smoke. Stop condition: if the harness cannot
be observed to re-deliver the same `tool_use_id`, publish the ledger as
hook-replay protection and name the execution-deduplication limitation in the
skill and changelog instead of claiming more.

Live proof (2026-09-19) over the built binary against the fixture journal: a
`stopping` call was claimed, deferred 7.6s and settled `granted` with its
`waitedMs`; replaying that call returned the "already permitted" refusal; a new
call in the settled environment was allowed normally; SIGTERM to the gate
process exited 143 and settled the claim `interrupted`; and replaying the
cancelled call returned the cancellation refusal. The Claude Code chain then
re-ran all four hook scenarios against this build with per-call tool ids and
passed unchanged, so the ledger did not regress the ordinary wait path.

The direct proof found a defect the mocked unit tests could not: the ledger
acquired its file lock before the private `harness/` directory existed, so every
claim failed open and repeat protection was silently off. The module now creates
the directory first, reports an unrecorded claim to the hook's stderr instead of
pretending it was recorded, and carries a regression test that fails if the
directory is not created before the lock is taken.

### Two-environment harness journey (delivered)

Slice 5 closed the Q36 gap with `scripts/qualify-harness-journey.sh` (also
`pnpm qualify:harness-journey`). It builds a fixture repository with two linked
worktrees, commits `.devrouter.yml` into both, and drives the installed Claude
Code harness against a local mock Messages API while the shipped
`devrouter harness gate` serves as that repository's `PreToolUse` hook. No
credentials or model access are needed, and the script skips with a named reason
when the build, the harness CLI, Node or tsx is unavailable. Three scenarios each
print one JSON evidence line and exit nonzero on any failed assertion:

1. Deferral. The gated checkout is `stopping` and settles while the hook waits.
   The gate allowed after an enforced wait (`granted`, `phase: stopping`,
   `budgetMs: 30000`, `waitedMs: 6030`), the single tool call ran afterwards, the
   harness recorded no permission denial, and `duration_ms` 8169 against
   `duration_api_ms` 32 shows the wait consumed no model time.
2. Refusal. The gated checkout stays `starting` past a 3s budget. One `deny`
   named the phase and `devrouter status .`; the harness recorded exactly one
   denial carrying the probe command and never executed it; the entry settled
   `refused` with `waitedMs` 2021, and its positive recorded wait with a
   harness `duration_ms` 3994 at or above it bound the refusal timing
   independently; the checkout stayed `starting`.
3. Protected neighbour. While `starting` persisted on the gated checkout, the
   identical tool call in the neighbour checkout was allowed immediately with
   'environment settled.', wrote its marker, and left the transitional record
   byte-identical (same `sha256`, same revision). That output hides the
   observed phase, so a separate bounded direct probe (`harness gate --json`,
   no tool id) also had to report `reason: settled` and
   `observedPhase: stable` for the neighbour checkout before the scenario
   passed, so a fail-open decision could not pass as a settled one.

The acceptance claim, zero agent infrastructure repair, is asserted rather than
assumed: exactly one model-issued tool call, that call being the synthetic probe,
empty `git status --porcelain` for both checkouts, the gate's ledger keyed by the
exact checkout the harness reported, and the neighbour's lifecycle record hash and
phase unchanged in every scenario. Evidence: three `failures: []` lines from the
2026-09-20 run, with raw artifacts under `/private/tmp/dr-journey-run7`.

The journey found a real defect. The gate measured its wait from before its first
observation, and resolving a checkout's identity against the provider registries
costs about 1.7s on a cold hook process on this host: measurement per step gave
`comparableWorkspacePath` 0ms, `resolveWorktreeWorkspace` 5ms,
`resolveWorkspaceRuntimeOrDefault` 1678ms and `readReliabilityOperation` 6ms, with
every later observation at roughly 5ms. A call under a 3s budget was therefore
refused as 'still starting after waiting 1.7s' without ever deferring, and because
the claim precedes the first sleep, that refusal left no continuation entry. The
wait clock now starts at the first observation, so the budget bounds the actual
wait and `waitedMs` reports it; the same call defers 2.0s, refuses once and
settles `refused`. `harness-gate.test.ts` carries the regression.

One earlier attempt misread the harness: a fixture whose worktrees were created
before `.devrouter.yml` was committed made the gate's walk-up find no managed
checkout, which read as the harness reporting the git repository root. The hook
payload carries the worktree the harness runs in, and the journey now proves that
through `payload.cwd` together with the ledger key.

Residual scope: the journey covers the ordinary wait and the budget refusal in a
real harness. Cancellation and redirect fencing (Q30) stays covered by the direct
signal proof recorded above, because this harness cannot be observed to cancel a
wait; a second harness and the non-Node consumer remain slice 6.

The journey has since grown from these first scenarios to twelve cells for
Claude Code and eleven decided cells for Codex, including the budget refusal,
the cancelled wait, the non-shell MCP call, two overlapping calls, a subagent
call, a cancellation that the CLI itself initiates, a settled call's own id
returning under a changed command and a hook timeout short enough to abandon
the gating wait. The current cell set, the pinned harness facts
and the retained evidence are recorded under "Harness gate breadth and lifecycle
passthrough (2026-09-20)" and in the fault matrix.

### Live consumer dogfood findings (2026-09-19)

The original consumer task re-ran the recorded recovery path on the released
0.0.79 CLI and reported live proof: cold `ensure` succeeded with 11 routes,
`devrouter stop` returned `stopped: true` with `freedRoutes: 11`, the
workspace left no containers or routes behind, and the checkout's staged merge
and worktree Git state were untouched. The pre-registration stop blocker is
therefore closed under live proof from its owner; this task only recorded it.
The same report names three follow-ups:

1. A warm re-ensure exited 1 while the identical cold run passed: the
   repository-owned post-start adapter started `klicker-dev` and then waited
   its own 90-second auth readiness contract, timing out with `curl 7` while
   `/tmp/dev.log` stayed empty; every other phase those runs printed was the
   adapter's or the application's. `ensure --repair` restarted
   `klicker-local-mcp` and `klicker-dev` and passed. The devrouter process
   helper had verified its own start (PID and ownership), so no devrouter
   source defect is claimed: the adapter's start path does not check that the
   process stays alive, and the application died silently. Disposition: handed
   back to the consumer task as its repository's adapter/app defect, with the
   contract reminder that the adapter owns post-start liveness and log-tail
   reporting. If a future run shows a devrouter process-helper start that is
   not actually alive, this reopens as a helper defect.
2. `devrouter stop <primary checkout>` returned exit 0 with
   `{"stopped": false, "freedRoutes": 0}` while, per the report, a
   stop-incomplete attention cleared afterwards. The result is honest for a
   primary checkout with no exact registration (nothing was stopped and no
   routes matched), and no state-clearing path exists on that branch of
   `environment-stop.ts`; the observation is not reproduced and no source
   change is made. A reproducer with the before/after `status --json` is
   requested before treating this as a defect.
3. `repo.host-port-claims` reported an error because the consumer declares a
   fixed Postgres binding on `5432`, which the shared `devrouter-traefik`
   container legitimately owns. The conflict is real and stays an error, but
   the remediation was wrong: it told the agent to stop or reconfigure the
   holding container, which for the platform router is never correct.

The router-holder remediation is fixed here. `remediationFor` in
`src/core/host-port-claims.ts` and the `repo.host-port-claims` suggestion in
`devcontainer-diagnostics.ts` now name the consumer's own published binding as
the side to change and say the router must keep running. Existing paths and one
writer; no new module. Acceptance: the new router-held conflict test asserts the
consumer-binding remediation and the absence of the stop-the-holder wording in
both the ensure refusal and the doctor check, and the existing foreign-holder,
standalone-holder and attribution tests stay unchanged.

### Worktree-owned upstream acceptance (delivered)

An unmerged draft, PR #101, carried a bounded `ensure` acceptance fix with a
stale 0.0.79 release commit on top. The source change is rebased onto current
main without the release artifacts: a linked managed checkout may serve a
declared devnet upstream from any Compose project owned by the exact worktree,
not only the `.devcontainer` overlay `ensure` drives. The workspace app
container keeps the strict overlay proof, and containers owned by another
worktree or by a shared project outside the checkout are still refused with the
existing message.

Existing paths: `src/core/workspace-ensure.ts` (`assertWorktreeOwnership`
replaces `assertOverlay` for linked-upstream aliases; one writer, no new
module), `src/core/__tests__/workspace-ensure.test.ts`, `docs/DEVCONTAINER.md`,
`docs/knowledge/managed-environment-lifecycle.md`, `CHANGELOG.md`. Portfolio:
readiness and preparation row, refusal/progress row for the unchanged app
container proof. Acceptance: the new same-worktree dependency-overlay case
passes, a foreign-worktree upstream still refuses, and the existing overlay,
alias and mount refusals are unchanged. The superseded draft is closed with a
comment pointing at this landed change.

### Capacity lost-history forward reconciliation — frozen derived contract (rev 2, delivered)

The delivered diagnosis slices prove loss and refuse; nothing yet lets an
operator end the state. An environment whose stop proof succeeded against a
positively absent ledger stays in `stopping` forever, its journal keeps a
capacity binding no durable row can satisfy, and every admission and controller
pass refuses, so agents can neither start new work nor finish the stop. The
roadmap's Q32 row ("no invented clean state") and the legacy-slice obligation
("explicit operator forward recovery remains required Q32 work") own this slice.

Two coupled halves with one writer each; no fabricated provenance, no charge
release for anything that may still run, no schema or policy change.

Planner round 1 (2026-09-20) returned REVISE. All three blockers and the
should-fix note are accepted and folded into this revision:

- **B1 — absence is not the same as loss.** The store throws
  `capacity-ledger-lost` both for a positively absent ledger
  (`capacity-store.ts:246-250`) and for one present below the journal floor
  (`:269`), while corrupt markers, unsafe owner or mode, invalid bytes and
  enumeration failures throw other errors. The store gains one classification
  used by both halves: `inspect()` returns `pristine` (no file, no evidence),
  `absent` (file positively absent, evidence exists), `stale` (present, below
  the floor) or `intact`, and `read()` becomes a thin projection over it so
  every existing caller, error code and message is unchanged. Only `absent`
  permits stop completion; every other outcome refuses as it does today.
- **B2 — clearing the last binding erases the floor.** The floor is the
  highest `capacity.snapshotRevision ?? 1` among records that still carry a
  binding (`reliability-operation-store.ts:688-697`), and the
  `capacity-ledger.established` marker is written only by a ledger commit, so
  clearing the last binding on a markerless store would read as a fresh
  install (`capacity-store.ts:246-250`). Completion therefore writes that
  marker as a durable loss witness through the store's own fsynced write path,
  under the capacity file lock, and only after re-proving absence inside that
  lock. Order is explicit: journal stop-proof retains the binding with
  `validUntilMs = 0` (the existing v2 branch), then the witness, then the
  journal confirmation clears the binding. A crash between witness and clear
  leaves marker plus binding, and a retried stop re-proves and re-witnesses; a
  crash after the clear still leaves the marker, so every later read refuses
  as lost until reconciliation. No new field and no schema change.
- **B3 — a reset revision can match pre-reconciliation work.** Zero bindings
  imply floor 0, so a baseline written at `floor` would reset the revision to
  0 and could match a holder that read 0 earlier: pool collection holds its
  revision across the whole observation window (`capacity-controller.ts:191-201`
  read, `:237` merge) and admission commits only after its journal transaction
  (`reliability-lifecycle.ts:1060-1087`). The baseline is written at
  `revision = floor + 1`, strictly greater than any revision observable before
  reconciliation, so every pre-reconciliation holder fails the equality fence.
  Both authoritative checks — the journal re-enumeration of unsettled bindings
  and the ledger re-proof — run inside the one capacity-lock transaction
  (`reconcileLostHistory`), because reads are lock-free while every commit
  re-reads under the lock. Lock order is unchanged and now stated: lifecycle
  transactions take the journal lock and only read the ledger; reconciliation
  takes the capacity lock and only reads journal files; neither nests the
  other.
- **Should-fix — zero bindings is not zero charges.** Admission commits its
  ledger reservation (`capacity.reserve`) before it writes the journal binding
  (`bindLifecycleCapacity`), and a stop settlement releases the ledger row
  before the journal confirmation clears the binding
  (`reliability-lifecycle.ts:1650-1675`). Reconciliation therefore claims only
  that no journal-visible charge remains; a charge that was never
  journal-bound, or was already ledger-released, is exactly what the lost
  ledger destroyed. That wording goes into the command output, the changelog
  and the knowledge concept, and acceptance gains the interleavings and crash
  orderings named above.

Planner round 2 (2026-09-20) returned REVISE on those corrections. Verified
against source; three findings accepted with one narrowed and two
should-fixes taken:

- **Revision reuse (accepted, corrected).** The floor is a lower bound, not a
  historical maximum, so `floor + 1` can still equal a revision a pre-loss
  holder legitimately carries — pool observation commits revisions with no
  journal binding at all (`capacity-controller.ts:191-237`), and the fresh
  baseline for a marker-only loss is revision 1. Correction: every locked
  mutation also fences the *ledger generation*. `inspect()` records the
  snapshot file identity (`dev:ino` from the already-open descriptor) of the
  read that produced the caller's revision, every mutator compares that
  recorded identity with the one it re-reads under the lock and throws the
  existing `CapacitySnapshotChangedError` on replacement, and `commit()`
  refreshes it after a successful write. Because every commit replaces the file
  atomically, a replacement covers both deletion-and-recreation and any
  concurrent commit, so a numeric collision can no longer match. No schema or
  signature change: the identity lives in the store instance, and a caller that
  never read falls back to the numeric fence it has today.
- **Pool ceilings (accepted, corrected).** `evaluateCapacity` defaults pools to
  `[]` and only supplied ceilings enter the sum (`capacity-accounting.ts:43,96-103`),
  `mergePools` only ever adds or raises a ceiling (`capacity-store.ts:157-181`),
  and the controller can serve cached samples without a fresh observation
  (`capacity-controller.ts:252-263`). A baseline with no pools would therefore
  remove the only host protection for a running runtime domain until a later
  observation. Correction: reconciliation performs its own pool observation
  inside the lock, through the same probe the controller uses, and writes the
  positively observed ceilings into the baseline; a declared runtime domain
  that cannot be observed refuses the whole reconciliation as
  `capacity-pools-unresolved` without a write. No ceiling is invented: values
  come from the active policy exactly as the controller writes them. A machine
  whose runtime is gone removes that domain from the policy first; pool
  cessation proofs remain follow-up work because `settlePoolAfterCessation` has
  no production caller.
- **Journal publication during reconciliation (accepted as a bounded residual,
  narrowed).** A binder could in principle publish a binding after the
  reconciliation enumeration. Source check: `updateReliabilityOperation` runs
  the caller callback and `persist()` inside one synchronous journal critical
  section and rejects async callbacks (`reliability-operation-store.ts:899-936`),
  and `bindLifecycleCapacity` validates against the ledger inside that same
  section (`reliability-lifecycle.ts:1365-1403`), so publication after
  validation requires a process suspension that spans the entire loss and
  recovery. Serializing validation-through-publication would require taking the
  capacity lock inside a journal transaction, the reverse of the ordering the
  lifecycle deliberately keeps; that is a larger change than this slice and
  carries its own risk. Correction taken instead: after writing the baseline,
  one more journal enumeration runs inside the same lock and, if any binding
  appeared, the fresh snapshot is withdrawn (deleted, marker kept) and the
  command refuses with the ordinary `capacity-charges-pending` list, so the
  race lands on the normal stop-then-retry path. The remaining suspension-scale
  window is stated in Limits with its fail-closed consequence.
- **Marker-only durability (accepted).** `establish()` opens and fsyncs the
  snapshot before the marker and directory, so it cannot serve a witness write
  when the snapshot is absent. Correction: a dedicated witness path writes the
  marker atomically, then fsyncs marker and directory, and re-fsyncs both when
  the marker already exists, covering the retry after a failed directory sync.
  Journal confirmation follows only after that sync succeeds.
- **Command contract (accepted).** Refusals follow `ensure`
  (`src/commands/ensure.ts:21-24`, its test at `:46-91`): one newline-terminated
  structured object on stdout, `process.exitCode = 1`, success leaves the exit
  code unset. Expected refusals are `{version:1, ok:false, reason, ...}` with
  the blocking environment identities and repo paths, and human recovery
  commands rendered as quoted argv a shell can run; success stays
  `{version:1, ok:true, reconciled:true, revision, unresolved:0}`. `stale` and
  unsafe evidence refuse without overwriting anything. The doctor suggestion
  recommends reconciliation only when the store classifies the ledger as
  positively absent and keeps the preserve-and-restore wording otherwise.

1. **Stop completion when the ledger is positively absent.**
   `src/core/reliability-lifecycle.ts` proves physical cessation first and only
   then settles anything. After the journal stop-proof, the settlement step
   asks the store's classification: `absent` writes the loss witness and
   completes without a ledger write, and the journal confirmation then nulls
   the capacity binding exactly as a settled stop does. `intact` keeps today's
   `settleEnvironmentAfterStop` path with its revision fence and bounded
   retry. `stale`, `pristine`, `capacity-history-unprovable` and every
   evidence failure (enumeration, unsafe marker, permissions, symlink,
   invalid bytes) refuse, as do live workers, changed evidence and unsettled
   fences. No new record field: the completed stop proof, the journal binding
   and the writable controller state are the evidence.

2. **Baseline reconciliation once no charge remains.**
   `devrouter capacity reconcile --yes --json`, a local command that never
   needs a running controller and only touches machines-local files under the
  existing locks.

   It refuses, with fixed typed reasons and no mutation, when journal
   enumeration is invalid or unsafe (`capacity-history-unprovable`), when any
   enumerated record still carries a non-null capacity binding — including one
   already under settlement with `validUntilMs = 0` — as
   `capacity-charges-pending`, naming the exact blocking environments in their
   ordinary `devrouter stop <path>` recovery form; when the ledger reads
   `intact` or `pristine`, meaning there is no loss to reconcile, as
   `capacity-history-intact`; and without `--yes` as
   `capacity-reconcile-confirmation-required`.

  Otherwise one `reconcileLostHistory` transaction under the existing capacity
  file lock re-enumerates the journals, re-proves the ledger positively absent
   at that instant, observes the declared runtime pools, and writes a fresh
   `{version:1, revision:<floor+1>, reservations:[], pools:<observed>}`
   snapshot plus the existing established marker through the store's own commit
   path, then re-enumerates the journals once more inside the same lock and
   withdraws the snapshot again if a binding appeared. It reports
   `{reconciled:true, revision, unresolved:0}`. The floor is the existing
   journal-derived minimum revision; nothing claims reservations, pools or
   history were restored, and the report says only that no journal-visible
   charge remained. A concurrent controller pass cannot lose a write: pool
   observation and admission already fail closed on the lost ledger, they
   commit under the same lock, and the baseline revision is strictly greater
   than any pre-reconciliation revision, so every holder of earlier state
   fails its equality fence instead of matching the baseline.

Paths: `src/core/capacity-store.ts` (`inspect()`, the write path for the loss
witness and `reconcileLostHistory`, each following the existing lock/commit
pattern), `src/core/reliability-operation-store.ts` (extend the existing floor
enumeration with one read of unsettled capacity bindings shared by both halves
and by the CLI), `src/core/reliability-lifecycle.ts` (stop settlement branch),
`src/commands/capacity.ts` (new local command handler) and `src/cli.ts` (new
`capacity` group with the single `reconcile` subcommand; no other module),
`src/core/capacity-docker-probe.ts` (reused read-only during reconciliation to
positively observe the declared pool ceilings),
`src/core/doctor.ts` (the `global.capacity-ledger` suggestion names
the reconcile command), their existing test files plus
`src/commands/__tests__/capacity.test.ts`,
`docs/knowledge/managed-environment-lifecycle.md`, `docs/DEVCONTAINER.md` if
its diagnostics paragraph changes, `CHANGELOG.md`, this plan. No new schema,
IPC method, policy field, dependency or default behavior change.

Limits, stated in output and documentation: journals are bounded and rolled
over, so an environment whose records were rolled away or deleted cannot be
enumerated; a total loss of journals is not distinguishable from first use;
reconciliation reconstructs no charges, pools or provenance and is not
disaster recovery. A runtime domain that cannot be observed blocks
reconciliation rather than being assumed absent. One residual race remains: a
binding whose validation already succeeded and whose publication is delayed by
a process suspension spanning the whole recovery can still appear after the
post-write confirmation. That leaves a fail-closed refusal and a blocked
reconciliation attempt, never a false clean state, and the slice names it
instead of claiming serialization it does not have.

Acceptance. Red regression: an environment whose stop proof succeeded against a
positively absent ledger stays `stopping` today and completes after the
change. An intact ledger keeps today's settlement semantics, including
revision fencing and `CapacitySnapshotChangedError` retries. Corrupt marker,
wrong owner or mode, symlink, oversized or invalid bytes, and enumeration
failures keep refusing in both halves. Reconcile refuses while any binding
remains and lists the exact blocking environments; refuses as
`capacity-history-intact` once a valid or pristine ledger exists; refuses
without `--yes`; after reconciliation admission works and the first new
reservation is admitted exactly once at revision floor+2, above the baseline.
The crash orderings and interleavings are covered: a completion whose witness
write lands and whose journal clear does not leaves both marker and binding so
a retried stop completes it; a holder that read revision 0 before
reconciliation fails its fence against the floor+1 baseline; a charge whose
journal binding appears during the reconciliation lock makes the journal
re-enumeration refuse, and one committed after it lands at floor+2 without
resurrecting a pre-loss row. Tests extend the existing capacity store,
reliability operation store, reliability lifecycle and command suites with
synthetic stores; no prose pinning.

Route: main. The required planner challenge preceded source as rev 1 (REVISE)
and rev 2 carries the corrections; one planner round-2 challenge on this
revision precedes source, and the immutable simplifier and slice review follow
on the committed range.

Implementation notes (2026-09-20). Three details of the frozen text are
recorded as delivered, because the executable artifacts differ from a literal
reading: (1) a pristine store keeps today's settlement, so the stop publishes
the empty revision fence it always published, and only an absent ledger takes
the new witness path; stale and every evidence failure still refuse. (2) The
declared-runtime pool probe is asynchronous and runs immediately before the
locked transaction rather than inside it; its only write inputs are the
policy's domain identity and ceiling, an unobservable domain still refuses
without a write, and the locked plan re-proves absence and the journal floor
regardless. (3) The command preflights the store classification and the journal
bindings before that probe, so a reachability failure cannot mask a pending
charge or a nothing-to-reconcile state; the authoritative checks stay inside
the transaction.

### Active diagnostic deltas

Main owns `src/core/workspace-ensure.ts`, its existing test suite, the affected failure-rule paragraph in `docs/knowledge/managed-environment-lifecycle.md`, and the unreleased changelog entry. Add fixed
`MANAGED_REPAIR_BASELINE_MISMATCH` reason identifiers to the existing error,
with profile, resource dimension, source/effective config and generated evidence
classification. No new recovery permission or worker protocol is introduced;
fixed identifiers survive the existing string error transport. Preserve refusal
before runtime/config/route mutations and preserve early mismatch short-circuit.
Acceptance: failing baseline then passing stateful repair regressions; no values
or fingerprints in the new reason identifiers. Stop this delta if identifying
a reason would require runtime mutation or weakening a comparison.

Executor owns `src/core/profile-resolution.ts`, `src/commands/profile.ts`, their
existing tests, and the selective-profile section of `docs/REPO_ONBOARDING.md`.
Add optional fixed-code notices only for dimensions actually replaced by managed
full expansion. Single/default and combined selections keep current membership;
combined explicit arrays must not be reported as ignored. Expose notices in JSON
and human summaries, with a named non-full default remedy. No resolver semantics
or doctor edits in this child. Acceptance: focused profile/command tests and
typecheck; no new runtime effects, dependencies, or prose-pinning assertions.
Both deltas consume the diagnosis portfolio and depend only on the verified baseline.

Diagnostic progress: plan committed at `5de5fb5`; 136 baseline tests passed.
Nine new mismatch cases failed on the baseline and pass after classification.
Generated-unavailable and multiple-dimension short-circuit cases extend that
coverage. Full ensure suite passes 140 tests; typecheck, focused Biome, docs policy and knowledge checks pass. Profile child Hilbert
`01a09a43-8449-7a61-af82-bf072f8e9925` owns the disjoint profile delta.
No runtime was started by these source tests. Required source reviews remain open.

### Lifecycle progress contract (diagnosis continuation)

Main is the sole writer for this delta: `src/core/lifecycle-progress.ts`,
`src/core/__tests__/lifecycle-progress.test.ts`, `src/core/reliability-worker.ts`,
its existing tests, `src/lifecycle-worker.ts`, and phase call sites in
`src/core/workspace-ensure.ts` and `src/core/environment-stop.ts`. Owning lifecycle
knowledge and unreleased changelog are updated together. No new dependency.

Reuse the existing parent/worker IPC and bounded controller output buffer. Worker
reports fixed allowlisted phases only: validation, preparation, provider, service
start/stop, process start/stop, route publication/removal, readiness, rollback and
stop. The parent owns a monotonic receipt timestamp and emits bounded fixed-shape
progress on stderr at phase changes and every ten seconds during ensure/stop.
After thirty seconds without a phase receipt, report phase evidence as stale,
not a dead worker; lifecycle/child liveness stays unknown unless independently
proven. Fixed child roles identify the responsible stage, not raw process argv.
Before first receipt report phase/child unknown. No application output is parsed.

Do not change stdout JSON, exec output, journal schema, timeout, cancellation,
provider queue order or worker ownership. Progress never grants mutation or ready
authority. Unknown IPC values are ignored and cannot leak extra fields. Errors in
the best-effort progress channel cannot turn a safe operation into a mutation.
Timer cleanup is mandatory on success, failure and cancellation. The existing
worker monitor and result remain authoritative.

Acceptance consumes the diagnosis portfolio: deterministic phase allowlist and
fresh/stale duration tests; existing worker output tests verify stderr forwarding,
unknown-message rejection, no impact on exec, and no timer/output after close.
Ensure phase call sites must sit before potentially blocking preparation/provider
or process operations, and readiness only after observed route proof. Reuse
passing repair classification evidence. No runtime startup needed for this delta.
Stop and internally revise the delta if it requires a new durable protocol, raw
process identity discovery, or any lifecycle authority change.

Progress hardening round 1 corrections accepted: phases describe the last observed
stage, never current child liveness. Fixed role mapping: validation/readiness/route
proof/rollback = lifecycle worker; preparation = repository preparation; provider =
provider operation; process start/stop = repository process adapter; service
start/stop = service reconciliation; coarse stop = lifecycle stop. `readiness`
means checking, never achieved readiness. Linked stop exposes coarse stop only
because its internal delegated phases are outside this delta's write scope.

Use a distinct `lifecycleProgress` IPC discriminator checked before ready/ok.
Malformed/mixed progress envelopes are discarded, never dispatch acknowledgments
or results. Suppress the entire progress sender, timer and sink for exec. Worker
sends best-effort with one outstanding send maximum; while blocked, retain at
most the newest fixed phase. Never await delivery. Ignore synchronous throws,
callback errors and disconnects; none affects dispatch, result or cancellation.
Parent writes to the invocation's existing LifecycleOutput as stderr when
supervised, and parent stderr otherwise. Drop best-effort direct progress when
the stream signals backpressure; catch synchronous sink failures. No new output
queue, persistence, or stream ownership. Async send failure is absorbed.

Progress-specific portfolio detail: add new deterministic protocol/role/monotonic
age/exact stale-boundary tests. Extend existing worker tests for both sinks,
mixed envelopes, send failures, cancellation and late-message/timer cleanup.
Extend existing ensure/stop tests for phase placement before blocking operations,
route-proof failure, rollback, and coarse linked stop. New runtime tests: none;
this is observational and current installed output qualification remains later.

Current verified source: repair `e215f8c`, profile notices `e299f1c`. Repair
simplifier/slice review completed without blocking findings. Profile slice review
passed; verified simplifier reduction removes a single-use helper without behavior
change (22 affected tests pass). Reviews are retained under `_local/reviews/`.
Lifecycle progress derived plan approved by Euclid in round 2; implementation and
focused regression checks are in progress. Both prior reviewer children closed.

### Installed diagnostics and remaining source inventory

Lifecycle progress committed at `734414d76a8e2658bc0ed0be894919e473a34321`;
189 focused tests and typecheck/Biome/knip/docs-policy/knowledge passed. Profile
simplifier reduction committed separately at `207edd2`. The progress simplifier
found no justified reduction; IPC safety review is running on that exact range.
The installed lifecycle qualifier's first attempt failed because its harness
parsed merged stdout/stderr as JSON. Main owns the bounded correction in existing
`scripts/qualify-lifecycle.ts`: retain merged error diagnostics, parse only stdout,
and verify installed progress separately. This extends the package compatibility
portfolio without changing CLI behavior or adding a new fixture.

A read-only capacity inventory found runtime-unwired park/resume events and
unbound recovery policy dimensions. Main verified the hardcoded false dwell input
and aggregate-only recovery dispatch. Do not implement the explorer's proposed
simple wiring: pressure provenance, exact stop effects, durable charge settlement,
consumer pins, cancellation and restart clocks need a derived design first.
Existing reserved scheduler knobs stay distinguished from recovery obligations.
The recorded citation consumer owner reports no new ensure after its historical
mismatch and only a previous stopped/zero-routes checkpoint; recovery remains
unknown pending exact runtime and provenance evidence.

Executor owns the final existing doctor seam: `src/core/doctor.ts` and its current
test suite. Reuse committed profile-report notices for warning-only full expansion
with fixed dimensions and the named-default remedy; preserve resolver membership.
Existing version compatibility levels stay unchanged, with installed and repo
metadata shown separately in diagnostic details. Missing version is unknown;
an older repo pin is not a runtime failure. No new schema or module. Acceptance:
focused doctor tests/typecheck and unchanged profile resolution evidence. Main
retains all worker/qualifier paths, so writes remain disjoint.

### Diagnostic package delivery checkpoint

Current draft: [PR #100](https://github.com/rschlaefli/devrouter/pull/100),
head `de22e1a25ccd9bd9e42d52a139ecc98ae98fa119`. Main progress IPC review passed;
doctor review passed. Installed protocol qualifier passed with30 evidence
claims, separate stdout/stderr assertions and no live provider. Receipt records
source `734414d` plus dirty qualifier changes; CLI/worker bytes match that source.
The test-only correction is committed at `27fd113`. Doctor/profile38 tests pass.
Full default-concurrency suite:2298 passed,5 timing failures across4 suites.
Those4 suites pass53 tests at maxWorkers=2; full bounded-concurrency confirmation
passed all 2,303 tests in 143 files. Linux CI also passed the process-helper
reconciliation suite, package smoke and controller/capacity qualifiers. No test timeout or production behavior was changed to hide failures.

Live ordinary canary qualification is approval-blocked: automatic approval review
rejected exact startup under the original other-workspace restriction. Pending
explicit user question names the existing eLearning canary, start/warm/stop/resume,
retained synthetic verification and final non-destructive stop. No startup ran.
Read-only exact registration/container proof found Stopped, zero routes, and
6GiB/512MiB/256MiB memory-plus-swap limits. Citation has zero exact routes only;
its runtime recovery remains unknown. Unaffected source and installed fixtures
continue. No global0.1.0 installation or release has occurred.

Main identified another prerequisite before parking: capacity submissions persist
a generic unpinned controller consumer, while live session leases/requirements
are owned by ControllerSessions. Parking cannot safely trust that synthetic
consumer as a live task or pin. The derived controller design must bridge exact
session generation/lease and stop fences before adding automatic stop/resume.
The read-only advisor completed; dispositions are recorded in the next section.

### Session submission fencing prerequisite

Doctor review and simplifier passed at `de22e1a25ccd9bd9e42d52a139ecc98ae98fa119`.
The full bounded suite passed 2,303 tests; Linux CI run 34752913310 passed source,
process-helper, package, controller and capacity checks on that exact head.
The advisor's proposed stop-settlement repair already exists: the lifecycle test
suite reproduces crash-after-release and re-proves physical stop before clearing
the binding. Reuse it; automatic park-stop continuation remains a later obligation.
Do not clear a missing reservation merely from its absence.

Next delta extends the existing consumer-session and operation primitives. The
server validates a session before asynchronous enrollment, but the submission
can outlive that lease or generation. Main owns the design; executor owns existing
`src/core/controller-server.ts`, `src/core/capacity-controller.ts`, and their
`controller-server.test.ts`, `capacity-controller.test.ts`, and
`capacity-controller-integration.test.ts` suites. No new files or wire schema.

Pass a required synchronous session-validation callback as the fourth internal
submit argument. It ticks current monotonic/wall clocks, validates exact store,
epoch, generation and environment binding, and returns a bounded consumer with
an ID hashed from the complete binding and requirements mapped through the
existing controllerCapability function. Its consumer is unpinned because the
current public observation contract grants no pin; a separate explicit pin
contract remains required before automatic parking. Replace the synthetic
controller consumer only for new submitted operations.

Capacity submission calls the callback before enrollment, again immediately
before journal preparation after asynchronous resolution, and after awaited
startup-witness publication immediately before enqueue. No await occurs between
the final validation and enqueue. On failure after new preparation, retire that
exact undispatched request. Preserve durable idempotency of already accepted
operations and uncertain-completion rules. Session release after accepted enqueue
does not cancel or replay it; cancellation of accepted work belongs to the later
harness contract. Enrollment remains the existing operator-approved stopped
conversion; this delta fences operation creation and enqueue, not provider mutation.

Acceptance extends the capacity/intent portfolio: hold enrollment then expire or
release the exact session and assert no preparation/enqueue; hold witness then
invalidate generation and assert exact retirement/no enqueue; a current session
submits normally with its mapped requirements; reconnect returns the accepted
operation. Server protocol tests exercise the real callback against release and
same-ID reacquisition; integration fixtures supply an explicit synthetic validator.
Run focused three suites, typecheck, Biome and Knip. No live runtime is needed.
This prerequisite does not claim complete parking, live lease-to-journal sync,
human pins, or actual harness enforcement. Review this derived delta internally
before implementation and continue the approved batch.


### Recovery observation prerequisite

Main owns existing `src/core/controller-monitor.ts` and
`src/core/__tests__/controller-monitor.test.ts`; executor retains submission paths.
The callback after serialized observation publication currently cannot tell that
publication rejected a stale or changed batch, or every observed consumer expired.
Reuse observation freshness, exact session binding and journal publication proof.
Recovery receives only failed capabilities still required by live matching batch
consumers after a successful publication. Reject future timestamps as unknown.
Never recover from released/reacquired consumers, stale/environment-changed batches,
failed persistence, or unavailable journal proof. Keep valid remaining consumers
independent: releasing one consumer does not suppress another's required recovery.

This is an extension of the existing observation/recovery composition, with no new
schema, policy, pin behavior or mutation permission. Pass the original batch abort
signal, never a newer batch's signal. Recovery still revalidates its own operation
and policy; full asynchronous recovery-session fencing remains in the later bridge.
Acceptance: failing-then-passing existing monitor suite regressions for stale,
future, released, reacquired and environment-changed batches; remaining live
consumer filtering, source typecheck and formatter. No runtime or new test file.


Recovery observation planner approved the derived delta. Five new baseline cases
failed as expected; after the fix all sixteen monitor tests pass. The sixth new
case proves that releasing one consumer filters only its required capabilities.
Typecheck, focused Biome and Knip pass. Exact immutable slice review follows commit.


### Recovery preparation fencing

After submission and observation slices, main owns existing
`src/core/controller-monitor.ts`, `src/core/capacity-controller.ts`,
`src/core/reliability-lifecycle.ts` and their three current suites, plus existing
`src/core/__tests__/capacity-controller-integration.test.ts`. No concurrent
writer touches them during implementation. Reuse consumer-session and lifecycle
fences; no new persistent schema or runtime policy.

Extend the internal ControllerRecovery callback with a required synchronous
`revalidate` closure supplied by the producing observation. It ticks clocks,
rejects stale/future evidence, stop/abort and changed store/epoch/session generation,
revalidates the observation's exact journal revision and persisted ownership/config,
and returns only positively failed capabilities required by still-live original
consumers. An empty set forbids a new recovery. Keep closure invocation outside
journal transactions; do not nest journal locks.

Capacity recovery uses existing side-effect-free resolveCapacityEnrollment instead
of enrollCapacityLifecycle: the latter rewrites even unchanged enrollment and
invalidates the producing journal revision. No capacity-enrollment.ts edit is
needed. Compare every durable enrollment field with the resolved policy binding,
including provider, exact path/common-dir, policy revision, daemon/endpoint,
domains and estimates digest. Never convert or repair enrollment in recovery.
Invoke the proof before asynchronous resolution and immediately before
prepareRecoveryLifecycleOperation, then queue synchronously without another await.
Pass the producing journal revision as an explicit recovery input and require that
revision inside prepare's transaction before reconciliation or mutation. This
prevents an explicit stop followed by a new start from inheriting an older failed
observation during enrollment. Changed consumer requirements may narrow failure
selection; no new consumer or generation may adopt old evidence. Joined normal
operation and queue ownership guards remain authoritative. After accepted enqueue,
worker/queue intent checks continue to govern; later automatic dispatch and full
session-lease synchronization remain the parking/harness slice's responsibility.

Acceptance extends the same capacity/intent portfolio: held enrollment then last
consumer release, same-ID reacquisition, evidence expiry or journal revision change
must produce no recovery preparation/enqueue; one surviving matching consumer can
recover its required failed capability. Direct lifecycle test rejects changed
revision without mutation. Extend the integration suite with real journal and
prepare transitions while resolving only external provider facts synthetically:
unchanged existing enrollment allows recovery without an intermediate revision
write, whereas an intervening explicit stop/new start rejects the old observation.
Mocking both enrollment and preparation is insufficient for this seam. Preserve original incident and existing action budget.
Run affected monitor, capacity-controller and lifecycle suites, typecheck, Biome,
Knip. No live runtime needed. Internal review precedes implementation.

### Submission and recovery fencing verification

Submission fencing committed at `a81bd58c4103fd65aeb6e44071d391538354d612`.
The worker passed 80 focused tests, typecheck and Knip. Parent strengthened the
server regression to release through a second real Unix socket and assert fresh
binding identity; all 20 server tests passed. Native slice reviewer Russell
returned DONE with no qualifying findings. Native simplifier Ptolemy recommended
removing the validator's redundant wrapper; accepted with unchanged 20-test pass.
Monitor pre-tick correction committed at `85f7532210ef2ebc5c6f00a4184029ad373b506a`;
Fermat's focused correction review closed the prior concern. All 17 tests passed.

Recovery preparation is in progress. Parent's seven new monitor cases failed
against the old three-argument callback. Its revalidation closure now passes all
24 monitor tests, including release, reacquisition, expiry, changed journal,
persisted evidence, stop and one surviving consumer. Worker Feynman owns capacity
and lifecycle preparation plus the three existing suites; parent retains monitor
files. Source remains unreleased. Original consumer owner received a progress
notice without any request to start or mutate its runtime.

The exact eLearning canary permission question is pending after the previous
automatic approval review rejection. Independent source and harness protocol
qualification continue; no consumer recovery or complete 0.1.0 guarantee is claimed.

Recovery preparation implementation now passes 124 capacity/lifecycle unit tests,
24 capacity integration tests and 24 monitor tests (172 total). Typecheck, Knip
and whole-repository Biome pass; Biome reports two pre-existing informational
findings outside this slice. The unchanged-enrollment integration verifies exactly
one recovery preparation write; stop/new-start during resolution prevents recovery.
A stale journal revision throws before any write. Live runtimes were not required.
The redundant submission wrapper correction is `ce700797f34c7488d492872715b66a159dab802f`.
Independent immutable recovery review follows this commit.


Recovery fencing committed at `4f2ae539f4ec3608046c985bfe8a56fb5b42e7c3`.
Noether's immutable eight-path slice review returned DONE without qualifying
findings. Raman's accepted simplification collapses four identical mocked
invalidations into one; actual invalidation seams remain separately covered.
The corrected capacity suite passes 41 tests (169 focused tests across the
recovery portfolio after removing duplicate executions).
[CI run 34755018015](https://github.com/rschlaefli/devrouter/actions/runs/34755018015)
passed all 2,331 source tests in 143 files at the committed head, Linux process
helper reconciliation, package smoke and controller/capacity qualifiers.
Live canary authority and actual harness qualification remain pending.


### Pressure-duration evidence draft (not yet implemented)

Extend the capacity evidence primitive with incarnation-local duration tracking.
The current queue samples only while work is queued/running, so it cannot establish
resume dwell for a parked idle environment. Recovery-enabled controller ticks
must observe declared domains at the existing configured sample interval, sharing
the same bounded collector with queue admission. Keep at most one collection in
flight; a timed-out collector retains its slot until drained. Collection failure
or changed policy/controller identity invalidates duration evidence. No new
provider mutation, background service, machine enrollment or pressure source.

The state per declared domain is normal, pressured or unknown, with the first
continuous observation time and last source sample time. Compare sample age using
its existing wall timestamp, but accumulate elapsed duration only with monotonic
time. A stale, future, missing, malformed or unknown sample resets that domain.
A backward clock, wall/monotonic divergence over two seconds, or scheduling gap
over fifteen seconds resets all domains. Restart starts with no duration evidence.
No wall time or saved JSON can restore duration after sleep/restart.

Repeated reads do not advance an evidence window or freshen its sample. A new
sample must extend the already-observed interval without a gap beyond sample
validity. A domain change resets the affected evidence. For a target's exact host
and runtime domains, normal dwell requires every domain continuously normal;
sustained pressure requires positive continuous pressure in an affected domain.
Unknown pressure can neither justify parking nor allow resume. Reports distinguish
these evidence predicates from full action eligibility, which additionally needs
consumer protection, ownership, policy, intent, budget and durable admission.

Tentative existing seams: `capacity-accounting.ts` and its current suite for
deterministic duration accounting; `capacity-controller.ts` and current suite for
single collection ownership and idle sampling; `controller-server.ts` and current
suite only if exposing bounded per-session evidence in status. No new files are
needed. Main retains the design while the consumer-protection planner owns a
read-only disjoint question. The final API and exact paths require internal plan
hardening before implementation.

Acceptance consumes the capacity/intent portfolio: exact duration boundary,
alternating pressure, stale/future/unknown input, repeated sample, cross-domain
normality, wall-clock jump, monotonic discontinuity, restart and an unresponsive
collector retaining its concurrency slot. Source tests inject clocks and samples;
physical OOM prevention and live parking remain separate qualification.


### Durable human protection and live-demand bridge — frozen draft

Main accepts the construction planner's separation of durable operator pin, live
session demand and continuity uncertainty. Do not synchronize live sessions into
operation consumers: their request-deduplication semantics differ. The existing
private controller socket establishes local-user authority, not human identity;
`humanPinned` records an explicit operator instruction and is never set implicitly.

Add optional `consumerProtection: {version: 1, revision: number, humanPinned: boolean}`
to existing version-1/2 journals. Absence means revision zero and no recorded pin,
never permission to park. The narrow synchronous setter requires existing exact
identity, expected journal revision, expected pin revision and a required final
session-validation callback. Under the existing journal lock, check revisions
and invoke the callback before persistence. Never initialize a missing journal.
Increment pin and journal revisions on a new accepted write; retain false records.
A retry with matching value at exactly expected pin revision plus one returns the
existing receipt without another write. Other stale values/revisions refuse.
Exhausted counters and uncertain persistence never acknowledge an unproven update.

Ordinary lifecycle writers preserve the complete extension and reject adding,
deleting or changing it through their generic callback. Pins survive enrollment,
stop, new ensure, operation replacement and observer/controller restart. Existing
strict old readers refuse the new field; never delete pin state to downgrade.
Reuse durable atomic publication and its post-rename resync path.

Add strict protocol methods `protection-status` and `protection-pin`, with the
existing exact session binding; pin additionally requires `pinned: boolean` and
`expectedProtectionRevision`. Resolve the exact original environment afresh with
bounded cancellation outside the server serializer, so release on another socket
can invalidate a held resolution. Capture the journal revision before resolution;
after resolution, compare the complete environment, validate the original session
and enter the journal fence synchronously. Revalidate sessions after any lock
wait. Cancelled requests and changed owner/config/profile fail closed. Neither
method enrolls, starts, stops or claims an environment.

Return bounded aggregate evidence: journal revision, pin revision/value, number
of live matching consumers and continuity classification. Do not serialize all
consumer requirements or IDs into a potentially oversized response. Current demand
and current legacy protection derive from validated sessions, never stale journal
consumers. Every live existing observer remains protected. No parking consent is
introduced by an omitted field or the current synthetic `pinned: false` value.

ControllerSessions records incarnation-local continuity uncertainty: startup is
continuity-unknown; expiry marks orphan-suspected; clock discontinuity resets
uncertainty. A sixty-second continuous monotonic grace changes only the diagnostic
classification to revalidation-required. It never grants action eligibility.
Reacquisition does not prove other consumers absent; status does not renew leases.
Bound tracking by using one conservative controller-wide uncertainty marker rather
than an unbounded expired-environment map. Live matching demand remains independent.

Expose both methods through existing controller CLI registration and command
forwarder. Require explicit true/false value and nonnegative integer revision for
the write; no default pin mutation. Update the existing lifecycle knowledge and
ADR 0008 extension, with the downgrade limitation in Unreleased changelog.

Ownership: executor writes only reliability-operation-store.ts and its existing
test suite after hardening. Main owns controller-sessions.ts, controller-protocol.ts,
controller-server.ts, src/cli.ts, commands/controller.ts and their existing suites,
plus active plan, docs/adr/0008-model-reliability-before-runtime-activation.md,
docs/knowledge/managed-environment-lifecycle.md if that is the owning concept,
and CHANGELOG.md. Verify the actual knowledge path before editing. No new module
or dependency. Session/store schema for observer snapshots stays unchanged.

Acceptance extends existing store, sessions, protocol and server suites: legacy
read; pin/unpin CAS/idempotent retry; counter exhaustion; strict fields; failed
persistence; generic writer preservation; second-socket release/reacquire during
held resolution; exact-owner mismatch; restart readback; grace/clock gaps and
multiple current consumers. Add real-journal ensure/stop preservation in the
existing lifecycle suite if store transitions do not cover the production seam.
Old-reader refusal is verified against the prior committed reader in an isolated
fixture, not a duplicate implementation of its validator. Reuse reviewed
submission/recovery tests and run typecheck, Biome, Knip, docs checks and package CI.

This slice ends with source and protocol proof of protection. Park/resume still
requires explicit consent, complete consumer reconciliation, fresh pressure,
protected-operation proof, intent-fenced stop and real durable resume admission.
No live runtime or global installation is required for this source slice.


Protection hardening round 1: all three findings accepted. After async resolution,
re-enter the same server serializer for final validation and transaction. Carry
an absolute monotonic three-second request deadline; check it after the synchronous
lock wait, because timers/socket callbacks may not run during that wait. Check
shutdown, observed cancellation, socket state, exact session and expected binding
inside the locked callback before every success, including status and replay.
Durable commit wins over later cancellation; lost responses reconcile through CAS.

Check the captured journal revision first, then evaluate pin revision/value or
exact-next-revision replay. A successful replay returns current validated journal
revision and unchanged bytes. Aggregate demand is read after locked validation.

Extend the existing ControllerResolver with an optional third internal argument
that receives a synchronous persisted-evidence validator. Existing callers and
wire requests stay unchanged. The canonical resolver supplies the validator only
after successful provider/owner resolution; it captures the exact .git pointer,
workspace token, owner record and .devrouter.yml bytes used for that result. It
rechecks bounded files and exact canonical paths. Protection requires the callback;
a resolver that cannot provide it refuses protection rather than granting weaker
proof. Invoke it inside the locked session callback after the lock wait. Provider
registry evidence remains the bounded fresh resolver observation; the pin itself
gives no provider mutation authority. Add controller-binding.ts and its existing
suite to main's exact paths. No functions enter persisted observer snapshots.

Extend existing tests for queued cancellation, deadline crossing during simulated
lock contention, expired session on status/replay, and changed captured ownership
or configuration after resolution. Every refusal asserts unchanged journal bytes.


Consumer-protection hardening approved in round2. Implementation uses the existing
operation store directly for pin read/write; no lifecycle module wrapper was
needed. Baseline108 tests passed. Initial new server tests prove real-journal
pin/retry/restart readback, independent-socket release/reacquisition refusal and
post-lock deadline/ownership refusal. The prior committed reader at5f683615
accepts the synthetic baseline and refuses its pinned record; current reader
preserves it. Compatibility receipt: /private/tmp/devrouter-pin-compat-NkmVOe.
No provider or user runtime was involved. Source review and remaining regression
coverage continue before delivery.

The owning foreground-session manual `docs/DEVCONTAINER.md` is updated with
the explicit CLI pin/read procedure; this is the same documented protocol,
not another authority or runtime change. Existing lifecycle preparation test
now verifies explicit stop preserves a previously recorded durable pin.


Consumer protection verification: 223 focused tests in seven existing suites
passed with pinned Node24.16.0. One additional cancellation case initially failed
because the test assumed a client-side disconnect had already reached the server.
An explicit server-side abort receipt and resolver-entry barrier remove that
assumption; the corrected case passes, bringing the applicable portfolio to224.
Typecheck, Biome, Knip, docs policy and knowledge checks pass. Build and isolated
packed-CLI smoke pass, including installed protection command registration. Two
pre-existing Biome informational findings remain outside this change.


Consumer protection committed at `b086a99f53476de7ae7f10cf41193e108a4f68b3`.
Carver reviewed the complete nineteen-path immutable slice and returned DONE with
no qualifying findings. Popper recommended removing four unused fixture target
parameters; main verified that every call used the suite identity and accepted
the reduction. [CI run 34756501873](https://github.com/rschlaefli/devrouter/actions/runs/34756501873)
passed source checks, package smoke and controller/capacity qualifiers. No live
consumer recovery, park/resume or 0.1.0 readiness follows from this source result.
Pressure-duration planning continues with Planck; the draft remains unimplemented.


### Pressure-duration frozen implementation contract

Refines the preceding draft within slice4; no runtime action or policy change.
Extend `capacity-accounting.ts` with `CapacityPressureTracker`, constructed with
exact declared domain IDs and maxSampleAgeMs. Its `observe(samples, clock)`,
`read(domainIds, clock)` and `invalidate()` methods own ephemeral windows, timestamp
watermarks and clock continuity. Clock is wallMs plus monotonicMs. Return bounded
per-domain pressure and observedDurationMs only; reads never accrue duration.
Keep evaluateCapacity's instantaneous admission semantics unchanged.

Each valid distinct source timestamp extends a same-pressure window only while
its predecessor remains valid. Start at zero on transition or a coverage gap.
Validate the entire sample shape, including numeric fields and ownedBytes.
Missing, malformed, stale, future, unknown or timestamp regression invalidates
the domain window. Equal timestamps never rebuild or extend a window; contradictory
equal-timestamp samples invalidate it. Preserve valid timestamp watermarks across
invalidation. At exact maxSampleAgeMs age a sample is still valid.

Clock checking runs at tick, collection start/completion and evidence read.
Invalid or backward clocks, divergence above2000ms, or monotonic gap above15000ms
clear all windows. A collection crossing an anomaly cannot publish. Restart begins
empty. Duration uses last accepted monotonic observation minus first; no saved
state or wall-time extrapolation. No new module or persisted format.

Extend `capacity-controller.ts` with optional injected clock and internal
`pressureEvidence({hostDomain,runtimeDomain})`. Validate the pair against frozen
policy. Both domains must be known: normalDwellSatisfied requires both normal
for resumeDwellSeconds; sustainedPressure requires positive pressure in at least
one for observationSeconds. These are evidence predicates only, with no consent,
admission, recovery, stop, park or resume authority. No server/wire exposure.

The controller owns a single collection slot, cache and cadence. Queue uses its
shared collect wrapper. Add `CapacityQueue.tick({observeIdle?: boolean})` in
`capacity-queue.ts`; only bypass the empty-queue return, preserving all lifecycle
ordering. Controller tick passes observeIdle only when recovery is enabled.
Collection rejection pauses queued requests with collection-unavailable and
retains charges; existing queue lifecycle tests remain required.

Launch at most once per sampleIntervalSeconds between monotonic starts. Within
cadence, reuse only still-valid cached samples; no tracker observation on reuse.
Concurrent callers share one bounded result. The raw slot covers pool probes,
caller collector and drain. Preserve four pool probes and their3s sub-deadline.
A whole deadline of maxSampleAgeMs aborts the combined signal, invalidates evidence
and rejects callers, but retains the raw slot until settled. While draining,
refuse new collection. Discard late results and handle late rejection. Close also
aborts and clears evidence. Revalidate authority and clocks after awaits and before
pool merge/cache/tracker publication. An observed policy content/revision or
controller store/epoch mismatch permanently invalidates this instance. Collection
failure clears cache/windows; per-domain invalid input leaves valid neighbours
available. Unknown overlays from failed pool probes remain authoritative.

Main owns controller/queue source and existing suites, plus this plan and affected
lifecycle knowledge. A trusted bounded worker may own only accounting source and
its existing tests after the frozen challenge approves. No shared writes or new
files. Acceptance consumes the existing capacity/intent portfolio: exact/below
threshold, repeated/contradictory/regressing samples, alternating/cross-domain
pressure, expired predecessor, unknown/malformed/stale/future data, clock boundaries,
restart, watermark replay, cadence/shared collection, never-settling and delayed
collector drain, late success/rejection, close, policy/incarnation drift and idle
queue wiring. Existing policy schema/defaults remain unchanged; focused four suites
plus relevant capacity integration and required static/package checks apply.

Pressure provenance remains the current collector's host-pressure evidence;
this does not prove guest OOM prevention. Slow sequential collectors may miss the
existing validity deadline; do not relax it or add probe parallelism here. Stop
the dependent delta if it requires policy/schema/provenance changes, server wire
changes, runtime actions, consent/enrollment or additional modules. Live proof and
harness qualification remain outstanding beyond this source slice.

Pressure hardening round1: both findings accepted. Add
`checkpoint(clock): number` to the tracker, returning a generation incremented
on every global invalidation. Controller captures generation at collection start,
compares it after awaits and before publication, and clears its admission cache
plus aborts any active collection when it observes a generation change. Keep the
raw slot until drain. An anomaly detected by an intervening read/tick invalidates
an already-running collection even if its completion clocks later look normal.

`read()` expires windows against current wall time without extending duration.
`pressureEvidence()` revalidates live policy and controller identity before every
report; after invalidation it returns unknown/false or refuses, never old predicates.
Every invalidate retains timestamp watermarks; only a new tracker forgets them.
Test completed dwell expiring without collection, policy drift before a tick,
replayed last timestamps after global invalidation, and an intervening read anomaly
followed by late successful collection with no pool/cache/tracker publication.

Pure accounting API boundary for the disjoint worker: export CapacityEvidenceClock
with wallMs/monotonicMs, and per-domain evidence with pressure (normal, pressured,
unknown), observedDurationMs and sampledAtMs (number or null). `read(domainIds,clock)`
returns a record of that evidence. `observe(samples,clock)` returns independently
cloned, structurally valid and fresh declared-domain samples for admission reuse;
unknown-pressure samples may remain in this result so existing admission refusal
and pool-failure diagnostics remain unchanged. They never establish duration.
Malformed, stale, future and regressing samples are omitted. Constructor validates
nonempty unique declared IDs within the existing256-domain bound and a positive
safe maxSampleAgeMs. All other tracker methods are synchronous. No thresholds or
runtime policy enter the tracker; controller derives the two predicates.


Pressure integration scope refinement: main also updates the existing
`capacity-controller-integration.test.ts` assertions for the approved queue
collection-failure contract. Three real-journal/socket cases previously expected
tick rejection; they must now verify a queued collection-unavailable refusal,
unchanged pool/reservation evidence and no worker dispatch. This preserves their
risk seam and adds no new fixture or source surface. Baseline103 tests passed;
parent controller/queue78 tests now pass. Required reviews remain after commit.

Pressure source integration now passes150 tests across accounting, controller,
queue, policy and real-journal controller integration. Typecheck, whole-repository
Biome, Knip, docs policy and knowledge pass. Two pre-existing Biome informational
findings remain unchanged. The worker's full-sample replay correction prevents
same-timestamp changed memory charges from replacing accepted admission evidence.
Main preserved queue expiry handling when policy evidence becomes unavailable;
collection remains fenced. Integration drift cases now assert queued refusal or
invalidated-controller watch refusal plus unchanged pool/reservation evidence and
no worker launch. Build/package and scoped static scan run before commit.

Package size at this checkpoint:4083 additions153 deletions (4236 substantive
lines across source/scripts against origin/main; project docs excluded). This is
an early draft for one controller reliability capability under the approved single
branch, with pending roadmap obligations clearly stated. No ready/merge/release
claim. Main will reassess package boundaries before integrated final readiness.


Pressure CI atd013ae9 passed source tests, build, package and controller qualifier,
but the installed capacity qualifier expected a stale admission reason. The
reviewed tracker now discards stale samples before admission, which reports
unknown for missing trustworthy evidence. Main adds the existing
`scripts/qualify-capacity.ts` to the correction scope and changes only that expected
reason; producing stale-telemetry observations, zero provider starts, absent
launch markers and queued durable intent remain required. No timeout increased
and no failed safety assertion was removed. The qualifier is rerun locally.

Zeno's simplifier result accepted: remove the redundant timestamp watermark
field and derive it from the retained accepted sample. The68 accounting/controller
tests remain passing without fixture changes. Correctness review completed; see the disposition below.


Pressure review disposition: Leibniz completed the immutable646f721..d013ae9
slice with one concern: the installed qualifier still expected stale after the
tracker deliberately omitted stale samples. The assertion-only correction keeps
queued identity, zero starts and launch-marker checks, and fresh exactly-once
launch. The reviewer confirmed this preserves the frozen safety contract and
that the accepted watermark simplification preserves behavior. No additional
source finding remains from this slice; integrated final review is still due.

The corrected installed capacity qualifier passed with receipt
`/private/tmp/dr-cap-v3T7VS/receipt.json`: sourceRevisiond013ae9, dirtytrue,
tarball SHA256ad86348cb2de1882ec8fcccafbb79986e6eeb8748175f942c8305f6c92d1b5e4.
Both provider start counts stayed zero before fresh telemetry and became one
afterward; operation identity survived, disconnect did not cancel, and positive
preparation settlement passed. This is fixture-injected coordinator plus actual
installed worker proof, not ordinary live CLI, harness or OOM qualification.


Pressure correction31e05609b1ebd25a9e52820ba3b0aba1d4534c00 passed
CI34758262340: docs/knowledge, Biome, Knip, typecheck, source and Linux helper
tests, build, packed distribution and both installed controller/capacity
qualifiers. No live consumer or final integrated readiness proof follows.

### Automatic recovery history rollover (frozen derived delta)

Slice4 prerequisite; existing capacity/intent/uncertainty portfolio. Baseline at
31e0560:128 complete managed ensure/admit/dispatch/persist/launch/complete/drain
cycles followed by recover with3available actions returns blocked, leaves op127
and128entries, but creates a zero-action incident. Ordinary requests already
retire settled entries; recovery must not require an operator ensure solely to
make journal space.

Extract one private retirement-candidate selector in reliability-model.ts shared
by handleOperationRequest and handleRecover. Select the first drained COMPLETED,
NOT_LAUNCHED or INTERRUPTED entry excluding current operation and latest ensure.
Preserve ordinary request behavior. At128entries an accepted recovery removes
exactly one eligible entry and appends one ensure; no candidate refuses unchanged.

Preflight before mutation: intent/policy and possible-dispatch, incident identity,
pending/current completed deduplication, remaining budget, history ID/key collision,
profile/consumer, drained replacement proof, runtime-generation headroom and
retirement availability. Preserve same-incident pending NOT_STARTED joins and
completed-current joins before replacement checks. A drained stranded preparation
requires a fresh ID. Reject retained history ID/key reuse even when colliding with
the candidate victim. Interrupted ensure may be superseded after drain; uncertain
exec and live/undrained operations remain protected. Stopping, stopped or parked
intent cannot acquire recovery authority through rollover.

Reuse recovery's runtimeGeneration increment for the fresh rollover fence; keep
intentRevision unchanged. Preserve existing incident ID, action limit and count.
Create an initial incident only after successful preflight. Preparation/dispatch
consume no action; accepted dispatch-persisted consumes one, exactly once. Exhausted
counters or budget refuse unchanged and old-fence completion/dispatch/observation
remain stale. Historical retirement never grants command replay or releases charge.

Keep transaction semantics: existing prepareRecoveryLifecycleOperation may
reconcile proven worker loss and ordinary undefined returns persist a new record
revision. No store implementation change. A blocked preparation can retain that
existing reconciliation but cannot retire history, open an incident, consume a
budget, clear result/witness or return a request. Stale authority throws before
reconciliation; failed persistence must yield no launchable request.

Changed paths:src/core/reliability-model.ts; existing reliability-model.test.ts,
reliability-liveness.test.ts and reliability-lifecycle.test.ts; this plan and
managed-environment-lifecycle.md. Read-only dependencies:reliability-contract.ts,
reliability-lifecycle.ts, operation store, and existing recovery decision suite.
Route:executor owns model source plus model/liveness tests after frozen challenge;
main owns real-journal lifecycle tests, docs, integration and external effects.
Acceptance:baseline failing reproduction; saturated initial/continuing/repeated
bounded recovery, protected entries/no candidate, pending/current deduplication,
ID/key/victim collisions, uncertain/live/undrained operations, stale fences,
exhausted generation and budget, unchanged incident limit/count until persistence.
Real-journal tests verify persisted fence, refused authority/reconciliation and
failed persistence. Run four existing reliability suites and required static and
package checks; add no duplicate policy or prose tests. No live runtime proof.

Stop this delta for schema/policy changes, broader transaction semantics, new
modules or runtime effects. No material user decision is open. Planner construction
DONE; main froze this contract for the same child's challenge before implementation.


Rollover planner Ohm approved frozen round1. Executor Dirac owns the model and
model/liveness tests; main added three real-journal lifecycle cases. Baseline
real-journal saturation fails to produce a request; no-candidate refusal and
failed-persistence protections pass. Evidence:
`/private/tmp/devrouter-recovery-rollover-baseline.log`. Unlike the raw model,
blocked lifecycle preparation does not persist the model's partially changed
incident because it returns before assigning transition.state.

Original citation owner fresh readback: installed CLI0.0.77, repo adaptation
pin0.0.51, no current Devrouter-specific blocker; no ensure/stop or new runtime
proof in that owner's current session. Historical all-stopped/zero-route receipts
are inherited, not current proof. Preserve staged merge and consumer ownership.


### Parking consent integration investigation (not frozen)

Primitive impact:extend existing consumer sessions with explicit capacity-parking
consent; compose durable operator pin, exact enrollment, incident and parked intent.
No new product object. Existing observers remain protected by default. Session
release, lease expiry, missing human pin and pressure alone grant no consent.
Current ControllerSessions has only protected observers and retains continuity
uncertainty; operation consumers are deduplication evidence, not live demand.

Before an emitter can be designed, qualify one current consumer proof across the
server serializer, asynchronous observation and journal lock. Every live consumer
must explicitly permit parking of an already-unusable environment; healthy active
work, APP_ERROR and nonpreemptible/unknown operations veto. Consumer set changes,
release/reacquisition, controller restart and wall/monotonic gaps invalidate old
proofs. A new opt-in cannot clear uncertainty about an expired protected observer.
A transient startup grace expiring means revalidation-required, never safe absence.

Existing seams to extend after design review:controller sessions/protocol/server
and their suites for consent; controller-monitor producing proof and capacity
controller for consumption. Existing source has no parking emitter, so a consent
prerequisite must remain inert until durable resume admission and intent-preserving
single-flight stop are implemented together. No implicit enrollment or policy write.

Remaining design problem:how to preserve a parked task's demand across controller
restart without treating old journal request consumers as live authorization. A
launcher reattach may establish a fresh consumer but cannot erase uncertain old
consumer protection. Resolve in the integration contract before code; no defaults
or compatibility claims are changed by this investigation.


Rollover integration:main took over the bounded worker patch after a fixture-driven
guard relaxation. Final source requires completed operations to be drained, allows
completed exec recovery, and refuses interrupted exec even after drain. Existing
three recovery fixtures now emit actual drain before requesting replacement.
The stale-event regression targets the new state with the old fence; pending
deduplication uses an actual NOT_STARTED record. Repeated recovery preserves the
original3-action limit despite later supplied9, and each persisted dispatch spends
exactly one. Main preserves original surrounding comments and removes redundant
new selector arguments/checks.187 tests pass across four reliability suites.
Typecheck, docs/knowledge, Knip and build pass; final formatting, focused scan and
packed smoke are recorded before commit. Sandbox-only ps and Opengrep log-write
failures are rerun in the permitted host context; no ownership bypass or runtime
mutation. New implementation still requires immutable simplifier/slice reviews.


Final rollover source verification before commit:187tests across four suites
passed; the added completed-exec retention assertion then passed all76modeltests.
Whole typecheck/Biome, Knip, docs/knowledge, build and isolated package smoke pass.
Focused Opengrep210rules on the one source module reports0findings. Source has
no runtime authority additions. Main owns all six paths after worker convergence;
staged material is source, synthetic fixtures and values-free project evidence.


Rollover convergence at ece78339675185ec30b5ba4affdb5818b62379d4:
independent slice review DONE with no qualifying findings; simplifier found no
worthwhile reduction. CI34759169929 passed at that exact head. Reports reside in
the ignored review directory. This closes the source delta only. Parking/resume,
scoped recovery budgets, live qualification and harness acceptance remain open.


### Durable consumer consent and reconnect — frozen derived contract

Scope A extends consumer session protection only. It adds no park/resume emitter,
provider mutation, reservation or journal-authority change. Scope B will add the
exact-set observation proof; actual parking and resume must integrate together.
Existing default observers and every reconnect start protected. Explicit release
acknowledges only its current binding; expiry, restart, clock discontinuity and
binding drift preserve unresolved protection. Journal request consumers remain
idempotency history, never live demand. Missing pin, elapsed grace and pressure
are not consent. Existing ordinary observation remains usable after config drift.

Primitive impact: extend consumer session with per-binding consent and retained
uncertainty; compose exact environment identity and operator protection. Reuse
current private atomic controller storage, session leases and serializer. No new
product object, module, policy default or process is introduced.

Controller snapshot becomes strict version2 with existing fields plus
parkingRevision (safe nonnegative counter), history (complete|legacy-unknown), and
retainedSessions. Active sessions add parkingConsent (protected|allow-unusable)
and consentRevision (safe counter). A retained entry carries id, generation,
epoch, requirements, parkingConsent, consentRevision, reason
(expired|restart|discontinuity|binding-changed), and the complete embedded
ControllerEnvironment. It carries no lease, timestamp or observation. Active
environments[] retains its existing active-only meaning. Unknown retained records
match by logical environment ID/path even when fingerprint/profile drifted; their
old fingerprint cannot block a fresh ordinary acquisition for that logical path.
Incompatible logical ID/path mappings still refuse.

At most128combined active/retained entries,32distinct logical environments,
256events and1MiB snapshot. Multiple generations of one session name may be
retained; the complete binding tuple must remain unique. No eviction of unresolved
protection on exhaustion. Every material membership, consent, reconciliation or
continuity change increments parkingRevision. Ordinary renewal/publication need
not increment it. Counter exhaustion and persistence failure refuse; preserve
existing poisoned-owner and exact-byte resync behavior.

Validate legacy version1 before migration; absent new fields never imply consent.
A version1 store becomes legacy-unknown, surviving active sessions become retained
protected entries on startup, and missing historical sessions stay unknown.
Preserve store identity and counters, advance epoch and persist before startup
acknowledgement. Version2 startup retains active sessions with their old epoch,
clears active bindings/leases/observations, retains prior uncertainty and history.
A genuinely first-created store starts complete. Missing/corrupt established
storage is never an authorized reset procedure. Strict older readers reject v2;
migration guidance forbids deleting state to downgrade or bypass uncertainty.
The read API may normalize validated v1 bytes to the current in-memory shape;
normalization alone cannot acknowledge a durable migration or new epoch.

Wire version1 existing methods stay compatible. Add strict parking-consent with
existing header and exact binding fields plus expectedConsentRevision and
parkingConsent. Mutation validates a live binding and CAS; an immediate matching
next-revision retry may acknowledge without another write; stale/revoked/generation
mismatches refuse. No-op at the expected revision returns current without consuming
a revision. Record a consent event only for a changed value. Existing observe
response binding shape stays unchanged; status exposes current consent revision.

Observe may carry an optional reconnect object containing previous complete
session/store/epoch/generation. Its session name must equal the requested session.
Fresh ownership resolution must equal the retained complete environment; validate
captured persisted ownership again immediately before the synchronous commit.
Atomically replace only that exact retained generation with a new protected
active generation and fresh lease. Never reuse its consent or operational authority.
Refuse an already-active session, a missing retained tuple, changed profile or
fingerprint, cancelled/deadline-expired request or failed persisted proof. A new
ordinary acquisition with the same name does not consume retained entries.
Old bindings cannot renew, release, submit operations or mutate consent.

Preserve unresolved sessions before expiry/discontinuity/binding invalidation
removes them; every such change invalidates prior parking evidence. Explicit
live release removes only that validated active record without creating a retained
record. It invalidates prior proof and grants no consent to remaining consumers.
Protection diagnostics add complete/legacy history, unresolved and consenting
counts, plus consentSatisfied. That boolean means only nonempty all-consenting
live demand with complete history and zero unresolved records; it is never a
runtime permission. Existing grace remains advisory and cannot make it true.

Known bounded limitation: controller-binding uses an incarnation-local HMAC key,
so exact equality can prevent reconnect after a real process restart. Do not weaken
fingerprint comparison or persist its key in this prerequisite. Full roadmap
must resolve identity continuity and explicit operator reconciliation of lost or
legacy identities before seamless restart or release acceptance. Pending work
cannot be bypassed by erasing retained protection. Scoped recovery/time budgets
also remain in full scope.

Paths for A: controller-store.ts, controller-sessions.ts, controller-protocol.ts,
controller-server.ts and their four existing test files, this plan, CHANGELOG.md,
and managed-environment-lifecycle.md. No new code files. Executor owns only store
and its existing tests after challenge approval; main owns sessions, protocol,
server, tests and documentation. All other code read-only. B separately extends
monitor/current-set proof and existing tests after A convergence.

Acceptance A: legacy migration and fresh-store distinction; restart retention;
default protection; consent CAS/idempotency/revocation/stale binding; expiry vs
explicit release; unrelated retained consumer remains; exact reconnect and failed
persisted proof; drifted ordinary acquisition succeeds but cannot clear uncertainty;
combined bounds/counter exhaustion/pre- and post-rename failure; controller Unix
socket reconnect/consent invoke zero lifecycle operations. Extend existing focused
suites, then static/docs/knowledge, typecheck, build, package and CI. No prose tests
or new live runtime. Run baseline failures before source implementation.

Stop A for any need to relax ownership, discard history, reset storage, introduce
runtime actions or change default consent. Main has dispositioned construction
corrections; same planner challenges this frozen contract before source changes.


Frozen challenge round1 corrections (accepted): reconnect also requires exact
sorted requirements equality; changing requirements cannot consume retained
protection. A new independent observe may request another set but leaves the
retained consumer intact. Legacy read normalization preserves old epoch and
surviving sessions, performs no retention or write, and repeats without changes.
Startup alone retains those sessions and advances epoch exactly once. Persistence
error recovery must compare actual stored version/content against intended bytes;
a normalized legacy view is not evidence that v2 bytes reached disk. Add focused
legacy tests for repeated read, pre-replacement failure retaining original v1,
and post-replacement error acknowledging only exact v2 after verified resync.


Consent A integration: planner round2 APPROVED. Executor owned only store and
store tests; main integrated session/protocol/server semantics. Baseline new cases
failed (sessions5, protocol2, store10). Final focused portfolio includes103tests
across five suites, with subsequent boundary/persistence assertions passing.
Full source suite2413tests/143files passed with2workers after the default parallel
run hit two existing filesystem-heavy test deadlines. Main then extended the
existing counter test to three exhausted counters and the128session test to
prove exact reconnect still progresses at the combined retention cap; all38store
and session tests pass. No timeout or ownership fallback was changed.

Whole typecheck/Biome/Knip/docs/knowledge/build/package and focused Opengrep
210rules/4files/0findings pass. Two unrelated Biome infos persist. Linux process
helper tests correctly skip on macOS and remain CI's Linux obligation. True
prior-reader compatibility was checked against the original committed validator:
v1 accepted, v2 refused. No consumer runtime, controller enrollment or global
installation changed. Lost/legacy identity reconciliation, cross-process HMAC
continuity, exact-set parking proof and full park/resume integration remain open.


### Store-loss correction — frozen derived contract

Faraday's consent review found that missing snapshot bytes invent complete history.
Both new store and host socket regressions reproduce the issue at d72600d. Route:
main for this same-slice correction (critical-path coupling; original executor's
correction budget was consumed). Acceptance: lost-history refuses before any
startup acknowledgment or operation factory; normal first creation, migration,
and durable restart continue with retained consumer protection.

Add private bounded write-once store-identity.json in the existing controller
directory, exact version1/store fields. Read validates both artifacts and exact
identity; missing snapshot with marker, mismatched IDs, or unsafe/corrupt marker
refuses. Read remains non-mutating; a valid snapshot without marker remains
readable and enrolls only at startup, preserving its existing complete or
legacy-unknown history. The live writer caches enrolled identity and refuses
marker disappearance or identity replacement. It never repairs missing history.

For first initialization persist the snapshot, then the marker, and acknowledge
only after both are durable. Interrupted marker creation leaves a valid snapshot
that the next startup can enroll. With a previous valid snapshot, persist its
marker before advancing incarnation. Exact raw bytes plus successful file and
directory sync may resolve a reported post-rename error; other failures refuse.
Marker creation reuses the existing atomic-write implementation; no new module.

Before acquiring its own owner lock, the server performs a read-only startup
preflight: missing history with any prior artifact, including owner.lock, refuses
immediately without reclaiming the lock. Cache any observed store identity in
this Store instance so disappearance during acquisition also refuses. Under the
lock revalidate surviving artifacts before initialization, ignoring only the
newly acquired own lock, and preserve the socket until store startup succeeds.
A missing snapshot plus preexisting/ambiguous runtime artifacts refuses; the
newly acquired owner lock and operator-provisioned capacity-policy.json alone
do not prevent a genuine first start. Unknown leftover files also refuse fresh
initialization. Ordinary restarts with a valid snapshot are unaffected.

Total deletion of snapshot, identity, and every surviving local lifecycle
artifact cannot be distinguished from first use. No total-loss guarantee is
claimed. Do not offer metadata deletion as a recovery procedure: restore a
verified matching snapshot; explicit reconciliation remains a roadmap obligation.

Paths: controller-store.ts, controller-server.ts, their existing test files,
this plan and managed-environment-lifecycle.md. No snapshot schema or IPC extension,
provider/runtime effects or relaxed ownership. Existing store/server loss
regressions must turn green. Extend tests for marker safety/mismatch, first use
with policy, legacy and interrupted enrollment, exact-byte sync uncertainty,
existing writer marker loss, and refusal before socket replacement. Then focused
controller suites, static/docs/knowledge, whole bounded suite, build/package,
and the same Faraday correction pass. Advisor Claude Opus5/xhigh consultation
completed DONE_WITH_CONCERNS; main accepts preservation and loss-limit notes,
adds pre-lock owner/unknown-artifact proof, rejects deletion as routine recovery.
Required planner challenge precedes source implementation.

Planner round1 REVISE accepted: in-memory prior-artifact evidence alone would
consume a stale owner-lock-only directory through lock reclaim/release; a second
attempt could initialize. Read-only preflight must refuse BEFORE acquiring that
lock, and both consecutive attempts must retain the original lock bytes and
invoke neither operations nor listening. Under-lock recheck remains required.
No mutation is needed to preserve refusal evidence. Planner round2 APPROVED.

Store-loss correction verification: both baseline regressions failed before the
fix; final36store,31server and17session cases pass. Full2433tests/143files pass
with2workers. Biome, typecheck, Knip, docs-policy, knowledge, build and packed CLI
smoke pass; focused Opengrep210rules/2files reports0findings. Existing2Biome
informational messages remain unchanged. No consumer runtime/global install.
Correction review and CI remain pending at this commit. Added18tests protecting
loss, marker integrity, crash enrollment and repeated-refusal boundaries; changed
one previous fault injection to target the snapshot after marker enrollment.

Independent Q32 source mapping also confirms capacity-reservations.json loss
returns revision0/empty and can permit new admission; effect-time old bindings
still refuse. This needs a separately derived bounded ledger-loss correction
before parking integration. No external deletion likelihood or live incident is
claimed; the current controller correction does not close that capacity gap.


### Capacity ledger loss — frozen derived contract

Consent correction78ddda0 passed Faraday's focused verification, simplifier,
and CI34761988066 (all source/Linux helper/build/package/installed qualifiers).
PR100 now includes consent and store-loss behavior, evidence and remaining gaps.
The separate capacity loss regression fails at that revision: after a successful
reservation, deleting the temporary ledger lets another reservation succeed.

Extend only CapacityStore and its existing tests for this bounded correction;
main owns this plan and the lifecycle knowledge explanation. No controller-store
or journal schema change, runtime action, new module, dependency or user config.
Route: executor for the settled two-file implementation; main for integration
and remaining Q32 legacy/forward-recovery policy. The store supports standalone
capacity CLI and worker stop settlement without a live controller, so it owns a
separate capacity-ledger.established file in the same existing private directory.
Its exact content is version1 metadata; it carries no controller or store UUID.

Read the bounded private marker before the ledger. Unsafe, symlinked, oversized,
foreign-owned or corrupt metadata refuses. A marker plus missing ledger refuses
and never recreates the ledger. Valid unmarked snapshots remain readable without
writes. Both absent retain the existing pristine revision0 view. Cache observed
ledger presence within an instance so subsequent disappearance cannot erase
positive local evidence, including a read before lock acquisition.

All five mutations still serialize on the existing ledger lock. Their in-lock
read validates state first and establishes the marker for any existing valid
ledger before returning mutation success, including idempotent reservation joins
and unchanged observation results. Marker-only enrollment of valid legacy bytes
is allowed during a mutation request, even if later admission/CAS refuses; it
changes no reservation, pool or revision. This closes the advisor draft's retry
gap: a marker write can fail after a reservation commits, and an identical retry
must arm the marker before acknowledging the joined reservation.

For genuinely absent state, commit the ledger snapshot first, then the marker,
and return success only after both writes are durable. Use the existing atomic
writer; report uncertain write failure without acknowledgment or rollback.
A valid snapshot left after interrupted marker creation remains recoverable via
the next locked mutation. Validate and bound snapshot contents before its write.
Do not recreate a ledger after loss, clear charges, reconstruct missing rows,
relax stop/effect authority, or use marker deletion as recovery. Keep identity
proof and capacity revision fencing distinct.

This detects ledger loss after successful enrollment and loss witnessed by the
same instance. Pre-marker historical loss and loss of every evidence artifact
remain unproved. Journal-derived positive legacy-loss detection and an explicit
operator recovery/diagnostic path remain REQUIRED full-roadmap Q32 work after
this bounded slice; the advisor's recommendation to exclude them is only a slice
boundary, not a waiver for0.1.0. A missing ledger may now refuse manual preparation
or stop settlement, rather than silently clearing retained capacity.

Acceptance extends the red regression unchanged, pristine use, read-only legacy
preservation plus mutation enrollment, every mutation after established loss,
marker safety, first snapshot/marker write failures and exact retry join, and
loss after an observed legacy read. Use existing synthetic stores; no host runtime
or fault injection outside temporary fixtures. Static/docs/knowledge, focused
capacity/lifecycle/controller suites, build/package and CI follow. No prose-pinning
tests. Advisor consultation DONE_WITH_CONCERNS accepted with join-retry correction
and explicitly retained operator/legacy obligations. Required planner challenge
precedes source implementation; stopped intent and existing charges remain gated.

Capacity planner round1 REVISE accepted: a visible marker after failed directory
sync is not durable evidence. Before any successful mutation acknowledgment,
including a joined reservation or unchanged observation from a fresh Store
instance, sync the validated ledger and marker files and their directory.
An existing marker cannot skip that durability proof. Persistent synchronization
failure refuses and preserves charges/revision; a later successful sync permits
the same idempotent retry. Add post-rename fsync-failure regressions for both
retry paths. Ordinary file existence or parse success is not the acceptance proof.

Capacity planner round2 APPROVED. Executor route failed before edits; main owns
the two-file correction under unhealthy-route continuity, retaining independent
reviews. A pristine unchanged observation now durably establishes the empty
revision0 ledger without changing its revision, so even that successful mutation
acknowledgment satisfies the frozen durability rule. Plain reads remain empty and
non-mutating. No business charges are invented by that initialization.

Capacity ledger verification: red deletion regression failed before source fix.
All65capacity-store tests pass, adding19consequential cases across loss, every
mutation, marker integrity, legacy read/enrollment and actual post-rename directory
fsync failure with both fresh-instance no-op retry paths. Full2452tests/143files
pass with2workers. Static checks/docs/knowledge/build/packed CLI smoke pass;
Opengrep210rules/1sourcefile reports0findings. Existing2Biome infos unchanged.
No consumer runtime or global install; no remaining shell watchers at commit.
Independent simplification/correctness review and exact CI are next. Positive
legacy history and explicit operator forward recovery remain required Q32 work.

Capacity slice review found no current defect and requested direct first-snapshot
post-rename directory-sync failure coverage. Extend the existing join/observation
retry cases across snapshot and marker stages; no production behavior change.
The two new cases must reject acknowledgment under persistent sync failure and
then preserve exact charges/revision on a durable retry. CI34763207992 passed
at001548c, including installed controller/capacity qualification. Next legacy
regression is separately uncommitted and excluded from this correction receipt.

### Legacy capacity history and diagnosis (frozen draft)

Primitive impact: extend the existing machine capacity ledger with positive
history validation; compose validated lifecycle journals as evidence. No new
product object, persisted field, policy or recovery permission. Main owns this
derived slice because architecture/integration is coupled and the configured
executor route has an unrecovered pre-work failure. Required independent planner
and slice review remain. Existing capacity/uncertainty portfolio, Q32.

Named existing paths: capacity-store.ts, reliability-operation-store.ts,
reliability-lifecycle.ts, capacity-controller.ts, capacity-queue.ts, doctor.ts
under src/core; their six existing tests except capacity-controller's integration
suite may replace its isolated test for the real-journal seam. Owning lifecycle
knowledge, docs/DEVCONTAINER.md diagnostics paragraph and this plan. No new files
or dependencies. Uncommitted lifecycle test reproduces unrelated admission after
a legacy ledger disappears; it fails at001548c before source correction.

Add one production factory in reliability-operation-store.ts (which already
imports CapacityStore) to inject a read-only revision-floor callback into the
store. Replace every production CapacityStore construction with this factory,
including effect checks, all lifecycle settlement/admission and controller pool
observation. Keep pure standalone CapacityStore construction in fixture tests.
The callback enumerates all bounded validated lifecycle journals without taking
journal locks. It returns the maximum retained capacity.snapshotRevision; any
non-null legacy binding without snapshotRevision contributes minimum1. Null
bindings and controller/policy presence contribute nothing. Never use receipt
maxima to reconstruct reservations or pools.

CapacityStore.read invokes the callback BEFORE reading marker/ledger, on every
read including inside its existing mutation lock. Journal-first ordering ensures
a concurrent legitimate admission cannot make a later journal appear ahead of
an earlier sampled ledger. Refuse a ledger revision below the observed floor;
missing with positive floor is lost history. Existing marker/observed loss also
uses the same stable loss code. Existing valid empty ledger at or above floor
passes, including fully settled history. First use and controller-only prior use
stay valid. No journal locks or runtime calls inside the capacity lock. Callback
errors refuse as history-unprovable, never as empty evidence. The floor callback
never calls CapacityStore or effect validation, so recursion is forbidden.

Guard pool observation before it can initialize or increment an empty ledger;
an admission-only check is insufficient when the surviving binding has revision1.
Do not hard-refuse controller startup: it may revoke binding validity but preserves
positive capacity evidence; collection and dispatch refuse through the factory.
Manual prepare must not clear a binding when history read refuses. Keep existing
stop settlement semantics and established-loss refusal; independent stop forward
reconciliation remains required before0.1.0. No successful-stop claim from a
failed settlement, metadata deletion, current-policy charge reconstruction or
forged historical provenance.

Add typed fixed reasons capacity-ledger-lost and capacity-history-unprovable.
Queue collection/admission catches preserve these reasons while keeping existing
expiry, supersession, retained charge, command and domain-wait behavior. Other
errors retain current generic classifications. Unknown historical ownership is
machine-wide because no trustworthy domain can scope it; no collateral journal
mutation follows. Values-free global.capacity-ledger doctor check uses the same
factory and reports health or these fixed reasons without identifiers, paths,
totals, raw exceptions or policy values. Documentation explains diagnosis and
verified-history restoration only; forward recovery remains an explicit release
obligation, not an accepted permanent agent dead end.

Acceptance: preserve the failing unrelated-admission regression; minimum floor
from multiple journals and legacy binding, first use/null bindings/settled empty
ledger, corrupt or unsafe enumeration, a concurrent journal/ledger revision
advance with journal-first ordering, pool observation before first-reservation
loss can be laundered, no manual binding clearing, both queue reason codes at
collection/admission, and doctor values-free classification. Extend existing
fixtures and tests; do not pin prose. All mutations inherit the guard through
existing readForMutation; add one representative mutation race proving loss
between outer read and in-lock read refuses. Review static/typecheck/docs,
focused lifecycle/store/controller/queue/doctor tests then full suite and package.

Limit: deletion of every artifact, historical pool-only use with no surviving
binding and rollback to a revision at/above every surviving binding cannot be
detected from these records. This slice claims only positive evidence, never
complete disaster recovery. No live fault, consumer runtime or installation.
Advisor completed; high-water and ordering accepted, unfenced pool-observation
recommendation rejected because revision1 evidence would be laundered. Required
planner challenge precedes source; correction review for previous slice must
converge before coupled implementation.

Planner round1 REVISE accepted: typed history failures must be handled before
the generic admission catch's mutating retireQueuedLifecycle(request,true).
For these typed failures, use readReliabilityOperation and a pure predicate
matching the existing superseded-only condition; if not positively superseded
(or reading fails), retain the queued entry and fixed reason without writing any
journal. Only positively superseded requests call existing retirement to complete
their own journal transaction, revalidating there as today. Queue expiry behavior
remains unchanged and separately allowed. Extend real-journal or seam tests to
prove loss/unprovable reasons preserve unrelated bytes/revisions and dispatch
nothing, while superseded requests retire. Do not refactor ordinary admission
errors or blanket-suppress authorized expiry retirement.

Planner round2 APPROVED. Main refined typed-history supersession handling to
finish only transient queue state after positive drained/superseded/no-worker
proof, because superseded-only retirement changes no journal semantics. The same
planner explicitly APPROVED this narrow equivalence in round3. No journal write
is needed; expiry retains its original separate behavior. All prior capacity
correction reviews/CI are complete. Main implements under recorded unhealthy
executor route; no new route probes.

Verification found one directly coupled mock in existing
src/core/__tests__/capacity-retired-intent.test.ts: the fixture mocked the old
constructor and must now mock the production factory. This eighth existing test
path is included for behavior-preserving adaptation, with all four intent refusal
assertions retained. No new module or obligation. Shared temporary lifecycle
fixtures now clear journals together with their per-test ledger; previously they
manufactured the exact historical-loss state between unrelated cases.

Legacy verification: baseline unrelated admission failed; corrected regression
passes. Focused7suites passed372tests before the final stopped-binding test.
Full suite with actual Vitest2workers passed2470tests and exposed4failures in
one constructor mock; that mock was corrected and all4intent-refusal tests pass.
Earlier unbounded package-script invocation mis-forwarded maxWorkers and hit two
unrelated5s timeouts; those pass with2workers. Static/docs/knowledge/typecheck/Knip
pass; build and isolated packed CLI smoke pass. Scan210rules/6sourcefiles yields
0findings. Linux process-helper tests explicitly skip on macOS and remain a CI
requirement. Final full-suite readback follows the fixture correction. No consumer
runtime or global artifacts changed.

Final legacy verification passes2474tests/143files with2workers, adding20
consequential tests. All prior failures resolved with test isolation and the
constructor mock adaptation, without weakening runtime guards. Packed CLI/build,
static/docs/knowledge/typecheck/Knip and bounded scan pass. Immutable reviews and
exact CI follow this source commit; no full-roadmap or live completion claim.


### Exact consumer parking observation — frozen derived draft

Primitive impact: compose existing consumer consent, observer capability evidence
and lifecycle intent for one bounded prerequisite. No new product object,
persistence schema, policy, emitter or capacity permission. Later pressure-driven
parking must revalidate this prerequisite inside its already-held journal lock,
in addition to exact capacity reservations, policy, stop and resume authority.
Restart intentionally requires a new observation; no observation crosses epochs.

Scope: src/core/controller-monitor.ts and controller-server.ts plus their two
existing test files, docs/DEVCONTAINER.md, managed-environment-lifecycle.md and this
plan. Main owns the coupled synchronous publication/server seam under the recorded
unhealthy executor route; planner then immutable simplifier/risk review apply.
No runtime actions, installed updates, dependencies, new module or IPC method.

Retain one latest successfully published batch per current environment in the
monitor (maximum32, cleared on stop/removal). Capture original store/epoch,
parkingRevision and the exact sorted binding tuples (id, generation, requirements,
consent and consentRevision), full environment, sample/start time, journal identity
and revision, capabilities, runtime fingerprint and persisted-read callback.
Copy data into the retained entry. Write only after successful session publication
inside the existing journal fence. Ordinary recovery retains surviving-subset
semantics and its present callback unchanged.

Add synchronous parkingObservation(environment,journal) for callers already
holding the journal fence. It acquires no locks, uses bounded persisted reads,
and ticks sessions with actual monotonic/wall time before evaluating. Tick may
persist lease expiry or discontinuity through the existing session store;
read-only here means no runtime or lifecycle mutation, as current protection-status.
Never reacquire the journal fence. Returns one closed fixed reason, with negative
default. Expose it only in existing protection-status as parkingObservation;
it is explicitly one prerequisite, never an overall eligible/safe-to-park claim.
No monitor yields observation-unavailable. Pin responses retain their current shape.

Evaluation order: monitor stopped/missing -> observation-unavailable; current
store/epoch/parkingRevision/full environment/original consumer tuple mismatch ->
consumer-set-changed; incomplete history -> history-unproven; retained consumers
for this environment -> unresolved-consumers; no live consumers or any withheld
consent -> consent-withheld; sample ahead of clock, before collection start,
expired at15000ms or no matching current projection for every consumer (sample,
journal revision, runtime fingerprint and validUntil) -> observation-stale;
mismatched journal identity/revision -> journal-changed; human pin -> human-pinned;
desired other than running -> intent-protected; phase outside stable/recovering,
any worker or any current/historical operation not drained and terminal ->
lifecycle-unsettled. Interrupted exec vetoes even if drained; drained interrupted
ensure may pass. Terminal means COMPLETED, NOT_LAUNCHED or INTERRUPTED ensure.
No command result is replayed or reclassified by this proof.

Every required selector must have exactly one batch capability. Missing, duplicate
or infrastructure unknown -> capability-unknown. Any required application unready
-> application-error. Every consumer needs at least one required infrastructure
failure, otherwise consumer-usable. A healthy sibling requirement can coexist with
positive failure, but unknown/unready siblings veto. Only then invoke the retained
persisted callback; false/throw -> ownership-unproven. Successful prerequisite
returns unusable-consumers-proven. Reason order is stable; reasons reveal no
consumer IDs, paths, capability names, raw configuration or exceptions.

Acceptance through real temporary ControllerSessions/Store and actual monitor
publication, never direct private-map construction: two consumers with distinct
requirements, positive failure for each; healthy/APP_ERROR/unknown/missing/duplicate
requirements; consent/set/reacquire/release/expiry/clock/epoch/environment changes;
new failed probe invalidates old still-fresh projection; stale or superseded sample;
persisted callback false/throw; changed journal/pin/intent/worker/undrained/uncertain
exec; no recursive fence; stopped monitor and bounded removal. Reuse existing
surviving-subset recovery tests. One real socket/journal protection-status journey
must expose the fixed reason without invoking lifecycle operations and preserve
pin/status contracts. Baseline failing test, focused monitor/server/sessions suites,
static/docs/knowledge/typecheck/Knip, full suite, build/package and CI. No prose tests.

Advisor DONE_WITH_CONCERNS accepted with latest-publication anchor and deliberate
conservative APP_ERROR predicate. Planner challenge precedes implementation.
This source prerequisite does not close parking/resume, lost-history forward
recovery, fingerprint continuity, scoped recovery, harness or live qualification.


Parking-observation planner APPROVED round1. The red test fails at the missing
method before source. Existing publication validation rejects duplicate capability
records before retention, producing observation-unavailable; preserve that stronger
earlier refusal. The post-publication cache prunes against current environments
and skips a removed environment, preserving the32-environment bound even when
collection outlives release. All changes remain within the frozen seven paths.


Parking-observation verification:65monitor tests and32socket tests pass; full
2516tests/143files pass with2workers. The first concurrent full run hit one existing
5s cursor-replay timeout (2515pass); its unchanged isolated check passed and the
full rerun without package/scan contention passed. Added42behavior cases cover
per-consumer evidence, current projections, async membership, ownership, live
socket reporting and journal immutability. Typecheck/static/docs/knowledge/Knip,
build and packed CLI smoke pass; the sandbox smoke first refused psEPERM, then
host smoke passed preserving fail-closed identity. Linux helper explicitly skips
macOS and requires CI. Scan210rules/2sourcefiles0findings. No consumer runtime
or global artifact changes. Exact immutable review and CI are next.

### Binding continuity across controller restarts — frozen derived draft

The preceding parking-observation slice is complete at5fa92a2: immutable
simplifier and risk review report no findings; CI34766071767 passes. It remains
one prerequisite, not permission to park or a complete0.1.0 result.

Identical synthetic input produced different fingerprints in two pinned Node
processes, with zero provider calls. A module-local random HMAC key prevents the
approved exact reconnect contract across restarts. Preserve opaque HMAC binding,
full environment equality, retained uncertainty, fresh generations and default
protection. Make the key durable and private to one controller store.

Route: main; execution-tier skip reason: recorded unhealthy executor route and
coupled persistence/composition migration. Planner construction and advisor advice
were verified against executable callers. One frozen planner challenge precedes
source. Immutable simplifier and slice-reviewer follow the integrated commit.

Use two existing artifacts. store-identity.json version2 holds store, a32-byte
random hex key and immutable positive enrollment epoch. snapshot.json version3
holds the matching domain-separated SHA256 digest of key and store, and enrollment
epoch, never the key. Epoch must not exceed the snapshot epoch. Strict version1/2
snapshot readers normalize without fabricating key provenance; existing version1
identity remains readable. Upgraded readers reject downgraded or mismatched bytes
once observed. Older readers reject new schemas, including the migration window.
No new module, storage artifact, dependency, IPC method or startup metadata field.

Bootstrap writes a durable empty legacy-compatible epoch0 snapshot, then a private
version2 identity enrolled at epoch1, then version3 startup before callbacks,
listen or acknowledgement. Valid old snapshots with absent/version1 identity
first validate history, write the identity at previous epoch+1, then version3.
A version2 identity beside an old snapshot resumes the same key only when its
enrollment epoch equals previous epoch+1. Version3 requires exact matching private
identity, digest and epoch; missing, unsafe, replaced or malformed identity fails
closed, never regenerates. Missing snapshot with surviving history remains refused
before acquiring the lifetime lock. Existing atomic write and exact-byte/fsync
retry handle crashes; no alternate persistence abstraction.

Every persist and fingerprint callback revalidates durable provenance. Fingerprint
closures capture the incarnation and refuse after epoch changes. Raw key stays
inside store implementation and closure: no getter, event, snapshot, IPC, error,
ControllerStartup or capacity metadata. Retained bindings from epochs before key
enrollment cannot reconnect even if supplied fingerprints accidentally match;
they remain uncertainty requiring later explicit reconciliation. Whole-artifact
rollback or deletion remains an undetectable limitation, not a recovery permission.

Replace module random key with createControllerBindingResolver(fingerprint?).
An omitted callback creates one closure-local ephemeral key. A matching observation
collector factory receives the same resolver and fingerprint callback for initial,
captured-byte and final probes. Server creates this pair through createBindings
after durable start under its lifetime lock; explicit injected test resolver and
collector retain their existing mode. Do not publish migration without production
wiring. createOperations(startup, resolver) receives the same resolver separately
from unchanged startup metadata. Command forwards it to createCapacityController
through optional bindingResolver. Standalone capacity controller creates one
factory-local ephemeral resolver; production always injects durable resolver.

resolveCapacityEnrollment accepts an optional fourth resolver argument, selects
once per call, and shares it across both probes. enrollCapacityLifecycle retains
the existing directory argument and accepts optional resolver fifth; it passes
through the chosen resolver. resolveCapacityOwnership creates one ephemeral
resolver for its entire initial/revalidate lifetime and passes it through every
resolve call. Keep exact full comparisons in capacity-controller recovery and
capacity-ownership-resolver revalidation unchanged. Standalone enrollment never
creates controller storage or starts a controller.

Scope is22 existing paths: nine production files controller-store,
controller-binding, controller-observation, controller-sessions, controller-server,
commands/controller, capacity-enrollment, capacity-controller and
capacity-ownership-resolver; their existing store/binding/observation/sessions/
server/command/enrollment/integration/ownership test files; qualify-controller.ts;
ADR0008, managed-environment-lifecycle.md and this plan. No new modules. Account
for any additional test fixture adaptation before editing it.

Acceptance portfolio: extend existing persistence tests for pristine/legacy
migration, marker/snapshot write and post-rename sync failures, safe retry with
same key, loss/corruption/permissions/symlink/wrong-store/wrong-key/downgrade,
old-reader refusal and no raw-key exposure. Extend resolver/collector composition
for same-key stability, changed bytes/identity refusal and matching all probes.
Extend session tests for newer exact reconnect with fresh protected generation,
legacy-epoch refusal and unrelated retained uncertainty. Extend actual packed
controller qualifier with two separate processes preserving private history;
reconnect after restart without provider mutation, stale generation rejection,
and changed binding refusal. Module-reset-only proof is insufficient. Extend
server/command/capacity caller tests to prove identical resolver forwarding,
standalone lifetime stability and changed config/provider refusal; real fingerprint
behavior with synthetic evidence, not constant environment mocks alone.

Run the smallest failing baseline first, focused suites, repository static/docs/
knowledge/typecheck/Knip, full tests with2workers, build/package and the actual
packed controller qualifier. Preserve Linux-only helper qualification in CI.
No consumer runtime or global install for this slice. This does not close explicit
lost-consumer reconciliation, actual parking/resume, scoped recovery, harness
continuation, live breadth or release gates. Continue the existing release goal.

Frozen challenge round1 correction accepted: both resolver and collector persisted
proof closures synchronously re-run their captured fingerprint callback when
invoked, comparing against their captured fingerprint. That callback revalidates
store, incarnation, digest and enrollment epoch through bounded private reads.
Missing, changed, downgraded or unreadable provenance returns false or throws,
without locks or mutation. This closes the held-work gap before any later store
write. Extend held-proof negatives for lost/replaced provenance; reuse existing
changed-consumer-generation publication/recovery refusal coverage. No recovery
may dispatch from held proof after provenance loss, and retained uncertainty stays.

Full-suite discovery adds one existing fixture path: capacity-controller.test.ts
mocks the whole binding module and must retain the new resolver factory export.
This is a test composition adaptation within the same contract (23paths total),
not a new source behavior. First full run2483pass/50fail all stem from this missing
mock export; source and narrower capacity integration pass.

Binding-continuity implementation matches the frozen contract. Two independent
packed controller processes reconnect an unchanged app:web consumer with a fresh
protected generation; stale renewals refuse. A third process refuses changed
configuration and retains the consumer. Actual provider mutation count0; all
fixture controllers stopped. Packed receipt /private/tmp/dr-observe-PC4Wxw/receipt.json
records source baseline5fa92a2 plus dirty source and artifact hashes; CI will bind
this qualification to the immutable commit. Prior packed attempt changed the
consumer requirement and correctly refused; fixture corrected without source fix.

Verification passes2533tests/143files with2workers; two additional held recovery
negatives pass in the28-test capacity integration suite, preserving both controller
snapshot and lifecycle journal after key loss/configuration drift with no dispatch.
First full run's50failures were one missing mock factory, now fixed. Typecheck,
Biome (two pre-existing infos), Knip, docs/knowledge checks and build pass. Old
5fa92a2 validator/startup both refuse upgraded artifacts in an isolated actual-code
probe. Opengrep210rules/9sourcefiles0findings; sandbox log-write refusal resolved
by host scan. Linux process helper explicitly skipsmacOS; CI owns its proof.
Packed smoke remains in progress; no consumer runtime, global install or release
changes.23existingpaths, no new source modules or artifacts. Immutable review/CI
follow before the next coupled source slice.

Packed smoke passes with system Bash after the Homebrew Bash helper --help probe
hung in two exact fixture processes. Those owned probes were terminated and the
original watcher reaped; no runtime process was targeted. Source helper unchanged.
Final typecheck and28capacity integration tests pass.2533full tests plus two new
focused negatives cover2535current cases. Exact source review, CI and the next
roadmap slice remain pending. Diff is23paths with formatter indentation required
by the resolver/collector closure factories; substantive behavior inspection used
both normal and whitespace-insensitive diff. No unrelated comment cleanup or data.

CI34767873826 passes static/typecheck/full2535tests, Linux helper, package and
packed controller but fails capacity qualification at first operation-submit.
The qualifier's custom operations factory omitted the second shared resolver
argument, unlike production wiring. Add only forwarding in the generated entry
in existing scripts/qualify-capacity.ts (24paths total). Local existing qualifier
passes with that correction at /private/tmp/dr-cap-2bgmpq/receipt.json. No capacity
equality or production guard changed. Risk reviewer notified; correction commit
and exact CI will follow. This is fixture composition, not a new product slice.

Risk review Bohr completed the cumulative5fa92a2..8f30a1b24-path range with no
qualifying findings; simplifier also complete. CI34768173037 passed2534tests and
failed only the known cursor replay fixture's five-second deadline. That fixture
performs256sequential socket renewals with durable fsync. Give this one integration
test15seconds, retaining every cursor and boundary assertion; no global timeout
or product behavior changes. Revalidate focused fixture and exact-head CI.


### Explicit retained-consumer withdrawal — frozen derived contract

The existing release command must let a caller withdraw one exact old consumer
intent after lease loss, restart or configuration drift. This closes a bounded
128-record exhaustion path without acquiring a replacement runtime session.
It does not resolve unknown history or lost caller bindings; those remain required
roadmap work. Route: main; execution-tier skip reason: recorded unhealthy executor
route and coupled session/parking authority. Existing full-package reviews apply.

Primitive impact: extend consumer-session release to exact retained intent. Reuse
the store/session/epoch/generation tuple in the existing same-uid controller trust
boundary. Live status already discloses binding tuples to same-uid clients; this is
not a claim of isolation between same-uid processes. Withdrawal grants no live
binding, parking consent, pin change, lifecycle request or capacity permission.
Configuration equality and fingerprint enrollment are reconnect prerequisites,
not withdrawal prerequisites. The old tuple cannot affect a newer generation.

Implementation in controller-sessions.ts: tick as before, read healthy snapshot,
match a live tuple against current store and epoch and exact generation; otherwise
match only an exact retained store/session/epoch/generation. Refuse absent/foreign
or mismatched tuples. Remove only the matching record, emit the existing released
event and advance parkingRevision before durable commit/acknowledgement. Only the
live branch removes its lease map entry and unused live environment metadata;
the retained branch leaves those unchanged. Narrow the private event helper input
to the id/generation it consumes if necessary. No new field, module, schema or API.
All retained reasons are eligible. Preserve legacy-unknown and failure poisoning.
Duplicate/lost-ack release remains refusal-on-retry: existing events lack epoch and
must not be used to infer a receipt. Reconnect semantics remain unchanged.

Consequential evidence in existing suites: drift/restart release with newer
same-name live lease surviving a subsequent tick and renewal; expiry and binding
invalidation; pre-enrollment release with reconnect refusal and legacy-unknown
remaining; foreign store/wrong epoch/generation/unknown and repeated tuple refusals;
128 retained consumers admit exactly one replacement after one release; durable
write failure never acknowledges and poisons subsequent access. Failure before
publication leaves the retained record for restart; a write-then-throw with failed
re-sync may persist the withdrawal and restart must not resurrect it. Existing
store logic can acknowledge after exact-byte readback and successful re-sync;
retain that proven success path. Monitor
coverage checks a held complete-set parking proof rejects the release revision.
Real socket release proves unchanged IPC command path and generation isolation.
No provider operations or consumer runtime required for this pure intent change.

Paths: src/core/controller-sessions.ts; existing controller-sessions, controller-
server and controller-monitor test files; docs/DEVCONTAINER.md; docs/knowledge/
managed-environment-lifecycle.md; docs/adr/0008-model-reliability-before-runtime-
activation.md; CHANGELOG.md; this active plan. Update only affected authority.
Versioned prompt remains in the separate final release commit. Baseline regression
at b4a7f67254aabe5062cd0db9bf43f7b7c860d749 fails stale-or-absent on exact retained
release; /private/tmp/devrouter-retained-release-red.log. Planner challenge precedes
source; focused tests then static/typecheck/docs/knowledge/Knip and full suite,
immutable simplifier/risk pass and CI before continuing the next roadmap slice.

Retained-withdrawal implementation uses exact retained lookup followed by existing
live validation; store tuple uniqueness makes branch order equivalent to the
frozen contract.18source lines change, nine existing paths total. Baseline exact
retained release reproduced; all2545tests/143files pass with2workers, including
real socket generation and pin preservation. Typecheck, Biome (two existing infos),
Knip, docs/knowledge and build pass; Opengrep210rules1file0findings. The first
post-write failure test overlooked existing successful exact-byte re-sync. It now
injects failed re-sync as well and passes; store source remains unchanged. Planner
Volta approved the bounded correction and is closed. Optional AGY rival remains
unpassed because discovery lacked authentication and hit sandbox cache/log errors.
Linux helper skipsmacOS; CI owns that check. Immutable slice reviews and exact CI
follow. Previous binding-continuity CI34768531727 is green at b4a7f67.

### Second harness and non-Node consumer (slice 6, delivered)

Slice 6 opened with the two breadth obligations the plan names. Both are fixture
work with no runtime ownership of another task: nothing here starts, stops or
reconfigures a consumer environment, and the shared router keeps running.

**Second actual harness.** The installed Codex CLI accepts a `PreToolUse` hook
but not the envelope Claude Code uses. `harness gate` now identifies the
requesting harness from its payload (`turn_id` present means Codex) and answers
in that harness's accepted shape: a refusal stays one `deny` in both, an allowed
Claude call keeps `permissionDecision: allow`, and an allowed Codex call returns a
plain completion whose guidance travels as `additionalContext`. The Codex CLI
reports an `allow` decision as unsupported hook output while still running the
tool, so serving the Claude envelope there would have left the gate advisory
while looking successful.

`scripts/qualify-harness-journey.sh` now runs either harness through the same
three scenarios (`DR_JOURNEY_HARNESS=claude|codex`, `pnpm qualify:codex-journey`).
The Codex path adds evidence the first harness cannot produce: the client itself
must report the hook as completed or blocked and never failed, which is the only
proof that the envelope was accepted rather than ignored. Evidence for both
harnesses, with `failures: []` on all six scenario lines:

| Scenario | Codex | Claude |
| --- | --- | --- |
| Deferral | allowed after `waitedMs` 6058 in `stopping`, tool executed, 2 turns, hook outcomes completed 1 / blocked 0 / failed 0 | allowed after the enforced wait, tool executed, no denial |
| Budget refusal | one `deny` naming the phase, tool never executed, hook outcomes completed 0 / blocked 1 / failed 0 | one `deny`, tool never executed, entry settled `refused` |
| Protected neighbour | allowed immediately as settled, transitional record byte-identical | same |

Codex evidence is `/private/tmp/dr-codex-journey-3`, the Claude re-run under the
shared script is `/private/tmp/dr-claude-journey-1`. The Codex client is
0.155.0-alpha.9.2 through the `codex.opencodex-real` binary, because
`/opt/homebrew/bin/codex` is an opencodex shim. The model provider is a local
mock Responses API, so no credentials or model access are involved. Source
changes: `src/commands/harness.ts` (harness detection plus per-harness
envelope), `src/commands/__tests__/harness.test.ts` (two new tests: the Codex
allow envelope carries no `permissionDecision`; an exhausted Codex wait still
denies), the journey script, the bundled skill and its embedded copy in
`src/core/agents-md.ts`, the onboarding prompt and `package.json`. Committed as
`f6f5163`.

**Non-Node consumer.** `scripts/qualify-non-node-consumer.sh`
(`pnpm qualify:non-node`) builds a synthetic Python consumer whose only
dependency is the standard library: one `.devrouter.yml` declaring a routed host
application and a routed Postgres dependency, a Compose project for the
dependency, and a service that answers `/healthz` and reports the dependency
environment it actually received. It asserts, from artifacts the fixture itself
produced, that `repo inspect` validates the config with no error-level issue
(the missing Node manifest stays a warning), that the route resolves over TLS
through the URL `devrouter ls --json` publishes, that the consumer process
reports a Python runtime with `DB_HOST`, `DB_PORT`, `DB_URL`,
`DB_SHADOW_URL` and the `envMap` alias `DATABASE_URL` equal to `DB_URL`, that
the route is gone after a non-destructive stop, and that the fixture's own
Compose project and synthetic volume are released.

Measured evidence from `/private/tmp/dr-non-node-6` (three cold and three warm
rounds, `failed: false`, exit 0; the raw per-round logs stay in that directory):

| Cohort | min | median | max |
| --- | --- | --- | --- |
| Cold (dependency stopped first) | 6696ms | 6827ms | 6909ms |
| Warm (dependency inherited) | 2291ms | 2291ms | 2524ms |

Both cohorts reused one dependency container identity across all six rounds
(`571d6c9de1a8`), so the warm cohort measures real reuse rather than a
recreated database, and the cold cohort measures a dependency start on an
existing container instead of an image pull or volume initialization. The ready
consumer reported a peak resident memory of 22.1–22.3MB, and its dependency
container held 17.1–27.0MiB at readiness. Two defects the fixture found in
itself were fixed before this evidence: readiness was first probed over plain
HTTP, which redirects to TLS and produced a false sub-100ms "ready", and the
fixture drove its dependency under a Compose project name devrouter does not
use, so its stop and leftover assertions were vacuous while a container
survived. The fixture now derives the same project name devrouter does, and its
teardown assertion is meaningful.

Sample size: three rounds per cohort instead of the roadmap default of twenty,
because each round stops and starts a real Postgres and a real host process.
The fixture is deterministic in its assertions and the cohorts differ only in
whether the dependency is inherited; the recorded spread (cold 213ms, warm
233ms across three rounds) is narrow enough that more repetitions would refine
the median, not the conclusion. This is a recorded scoped alternative for an
expensive fixture, not a waiver of the M1 qualification counts.

Q rows affected by this slice: Q01 and Q02 are requalified for the non-Node
cell by the cold and warm cohorts above, Q29 is requalified in a second claimed
harness mode by the Codex journey, and Q24 is requalified for a consumer with
no Node toolchain at all. Nothing here changes Q30: cancellation and redirect
fencing stay covered by the direct signal proof, because this harness cannot be
observed to cancel a wait.

Residual slice 6 work: the measured baseline now exists for readiness and
memory, and profile or artifact optimization must cite it. Q01-Q36 disposition
and the 0.1.0 release remain.

### Q01-Q36 disposition (slice 6)

Slice 5 owed a disposition of every row of the roadmap's acceptance matrix; slice 6
requalifies the rows its breadth work touches. This is that disposition. It names
the layer that produced each result, because a source test proves the contract and
its failure handling while an installed or live run proves behaviour on this host:

- **source** - a deterministic test in this repository's suite.
- **installed** - a qualifier that drives the packed or installed CLI.
- **live** - a run against real host processes, the shared router, real Docker
  state, a real agent harness or a real consumer checkout.

A row is open when no producing evidence exists for the layer it needs. The
repository has no OOM classifier at all: memory pressure is modelled as declared
headroom, dwell and reservations rather than as a kill reason, which is why the
two OOM-labelled rows are dispositioned as not applicable instead of unproven.

| Q | Evidence | Layer | Status |
| --- | --- | --- | --- |
| Q01 | non-Node cold cohort (`scripts/qualify-non-node-consumer.sh`); installed synthetic lifecycle fixture (`scripts/qualify-lifecycle.ts`); recorded consumer cold `ensure` with 11 routes | live, installed | Proven for the non-Node fixture and the recorded consumer cell |
| Q02 | non-Node warm cohort, one dependency container identity reused across all six rounds | live | Proven |
| Q03 | `controller-http-readiness.test.ts` propagates cancellation instead of classifying it as an application failure and preserves the readiness status classification; `workspace-ensure.test.ts` carries captured ownership through final readiness under the provider lock | source | Proven at source |
| Q04 | `reliability-recovery.test.ts` opens an incident when a required capability fails; `controller-monitor.test.ts` asks the operations owner to recover it | source | Proven at source |
| Q05 | `reliability-model.test.ts` keeps consumers independently ready when another requires a failing capability; `controller-monitor.test.ts` stays idle for a capability outside the required set | source | Proven at source |
| Q06 | `controller-monitor.test.ts` does not replace timed-out batches whose probes have not drained and keeps only two batches active; `capacity-accounting.test.ts` never extends a duration on read and ends a window at its wall-age boundary; `scripts/qualify-slow-dependency-recovery.sh` produces the row's four provider outcomes against a synthetic consumer | source, live | Proven: the 2026-09-20 run waited 41.9s for a slow dependency, failed in 7.5s on a never-healthy one, left an unchanged unhealthy container untouched and started an exited one once, with RestartCount 0 throughout |
| Q07 | `scripts/qualify-killed-runtime-recovery.sh` ends a routed container under a 64 MB limit and asserts the kernel's OOM kill (exit 137, OOMKilled true) retains the container and its published route instead of silently recreating either; the equivalent admission mechanism is declared headroom plus dwell, covered under Q10 and Q12 | live | Not applicable as an OOM-classification question; the container-local OOM cell is qualified at `bb72cb6` |
| Q08 | `controller-process-observation.test.ts` reports the probe's positive absence as a missing process and refuses ambiguous evidence; `reliability-recovery.test.ts` requires an incident and an allowance before acting | source, live | Not applicable as an OOM question; proven as process-absence evidence, and the SIGKILL cell of `scripts/qualify-killed-runtime-recovery.sh` shows a real kill is reported at exit 137 with `oom=false` and no devrouter statement classifying it as an OOM kill |
| Q09 | `capacity-request.test.ts` rejects undersized default operation authority; `capacity-policy.test.ts` allows an allowance at the boundary and reserves it from runtime budgets | source | Proven at source |
| Q10 | `capacity-accounting.test.ts` accrues dwell only across continuous same-pressure samples; `capacity-controller.test.ts` parks a pressured environment by committing intent and driving one stop | source | Proven at source; pressure is injected through the qualified boundary, never host exhaustion |
| Q11 | `capacity-store.test.ts` denies competing pools without persisting either reservation; `network-capacity.test.ts` never double counts overlapping pool declarations | source | Proven at source |
| Q12 | `capacity-accounting.test.ts` retains occupied startup and heavy slots independently of observed bytes; `capacity-request.test.ts` uses the conservative heavy class for unknown operation names | source | Proven at source |
| Q13 | `capacity-queue.test.ts` cancels only the caller wait while the accepted worker continues once; `reliability-lifecycle.test.ts` persists explicit stop intent before the worker supervisor waits | source | Proven at source |
| Q14 | `capacity-queue.test.ts` rejects changed retained payloads without replacing the queued entry and joins an identical payload once; `reliability-model.test.ts` joins parked consumers without restart | source | Proven at source |
| Q15 | `capacity-controller.test.ts` refuses to resume while headroom has not dwelled normal; `reliability-recovery.test.ts` resumes a parked environment only once every condition holds | source | Proven at source |
| Q16 | `reliability-model.test.ts` and `reliability-output.test.ts` carry the explicit unadmittable result | source | Proven at source |
| Q17 | `reliability-model.test.ts` stops before late readiness so attach can never undo a stop; `reliability-lifecycle.test.ts` persists an operation reference without dispatch and lets stop supersede it | source | Proven at source |
| Q18 | `reliability-model.test.ts` shares consumers, respects every pin and releases without stopping; `controller-sessions.test.ts` releases only the selected consumer | source | Proven at source |
| Q19 | `reliability-liveness.test.ts` admits ensure after a completed stop against a saturated journal and keeps progress across 200 seeded rounds; `controller-store.test.ts` advances the epoch with stable identity and retains sessions on restart; `scripts/qualify-controller.ts` | source, installed | Proven at source and in the installed controller qualifier |
| Q20 | `controller-sessions.test.ts` invalidates sessions on scheduling and wall-clock discontinuities and resets protection grace on sleep; `capacity-accounting.test.ts` clears every window on a clock discontinuity | source | Proven at source; a real host suspend was never exercised |
| Q21 | `capacity-ownership-resolver.test.ts` rejects provider drift before publication and does not probe the daemon after cancellation; `controller-monitor.test.ts` does not replace timed-out batches whose probes have not drained | source | Proven at source |
| Q22 | `reliability-worker.test.ts` records interruption on worker loss while retaining an active process group and never forks an already-cancelled request; `devpod-exec.test.ts` does not classify a transport error after spawn as safe to replay | source | Proven at source |
| Q23 | `managed-stop-recovery.test.ts` fails on changed membership after partial cessation and never adopts replacements; `environment-stop.test.ts` fails closed when Traefik does not unload a removed route | source | Proven at source |
| Q24 | both harness journeys assert zero infrastructure repair per scenario; the non-Node fixture starts its own application outside devrouter's control | live | Proven |
| Q25 | `managed-host-preparation.test.ts` kills the inherited process group of a bounded foreground command; `reliability-lifecycle.test.ts` does not resurrect interrupted preparation when settled tooling history rolls over; `file-lock.test.ts` never displaces the same live process instance and reclaims a record whose PID belongs to a different process birth | source | Proven at source |
| Q26 | `profile-plan.test.ts` atomically replaces an output symlink without changing its target; `managed-post-start.test.ts` does not follow a repository adapter symlink on the host; `paths.test.ts` refuses repo-relative traversal; `reliability-operation-store.test.ts` rejects symlinked journal entries | source | Partial: no quarantine subsystem exists to test, the symlink half is proven |
| Q27 | `reliability-worker.test.ts` forwards only allowlisted last-stage evidence and pages output within a byte bound; `reliability-lifecycle.test.ts` keeps command args, environment and output out of the persisted record | source | Proven at source |
| Q28 | `tool-diagnostics.test.ts` warns when another install on PATH is newer than the running CLI or when the shell resolves a different one; `reliability-operation-store.test.ts` refuses records from a newer CLI; `scripts/package-smoke.sh` and `scripts/qualify-network-package.cjs` | source, installed | Proven at source and in the installed package qualifiers |
| Q29 | `harness-gate.test.ts` and `commands/__tests__/harness.test.ts` cover the phase table, the continuation ledger, the non-shell decision path and both harness payload shapes for the lifecycle passthrough; `scripts/qualify-harness-journey.sh` runs twelve cells for Claude Code and eleven decided cells for Codex, whose `nonshell-allow`/`nonshell` cells drive a real MCP server tool through the hook, whose `parallel`/`concurrent` cells decide two calls that overlap one checkout with the same payload twice under distinct ids, whose Claude-only `nested` cell refuses a subagent's shell call once the checkout turns transitional, whose `cancelled` cell interrupts each CLI while its own hook is still waiting, whose `redirect` cell re-delivers one settled call's own id under a changed command and records that both real clients do deliver the repeated id, and whose `hook-timeout` cell inverts the shipped wiring on purpose (a 3s hook timeout under an 8s budget) so the harness abandons the wait before the gate decides; `agents-md.test.ts` asserts that every shipped `devrouter harness gate` hook declares at least twice the 30s default wait budget | source, live | Proven in both claimed harness modes at `134a992` (Claude Code 2.1.278 12/12, Codex 0.155.0-alpha.9.2 11/11 with `nested` recorded not-run because the Codex CLI exposes no subagent tool); a tool whose result depends on the live environment stays open |
| Q30 | `harness-continuation.test.ts` replays an existing gated call instead of claiming it again and settles a waiting claim once; `reliability-model.test.ts` never overturns an explicit stop; `scripts/qualify-harness-journey.sh` kills the shipped gate mid-wait at 1.5s of a 30s budget, records `interrupted` with no duration, refuses the identical re-delivery as `continuation-replay`, leaves the command unexecuted, records the same refusal for a non-shell MCP call, grants two overlapping claims keyed by call identity, settles a refused subagent call, records a harness-initiated cancellation in each harness so the resend is refused, records a hook timeout that abandons the gating wait before any decision, after which the call runs under the harness's own permission rules while its claim never becomes `granted`, and re-delivers one settled call's own id under a changed command once the checkout is settled, so the granted id must refuse as a replay while the same command under a fresh id is still allowed | source, live | Live layer proven for a cancelled gate wait at `7467786`, for the non-shell replay at `40b23f0`, for two overlapping calls at `72f14db`, for the nested refusal at `ca2483b` and for interrupting the real CLI mid-wait at `1af4680`, where Claude Code settles the claim `interrupted` while the Codex CLI kills its hook so the claim stays `waiting` and the identical re-delivery maps it to `interrupted`, for a hook timeout below the wait budget at `ff7efc4`, where both harnesses ran the command under their own permission rules while the abandoned claim stayed short of `granted` (`interrupted` for Claude Code, `waiting` for Codex), and for a settled grant whose own id returned under a changed command at `134a992`, where both harnesses delivered the repeated id and the gate refused it as `continuation-replay` against the recorded `granted` state while the changed command never ran and the same command under a fresh id was allowed on the settled checkout; a runtime-dependent browser or MCP tool remains open |
| Q31 | `controller-server.test.ts` replays valid cursors, gaps a replaced store and disconnects a subscriber at the output bound while other clients stay responsive; `controller-protocol.test.ts` fences reconnects | source | Proven at source |
| Q32 | `controller-store.test.ts` preserves corruption and refuses startup; `capacity-store.test.ts` refuses new admission after an established ledger disappears and fences a snapshot rewritten in place under the revision a caller already read; `host-routes-state.test.ts` fails closed on corrupt canonical metadata; `devrouter capacity reconcile --yes` is the delivered operator forward recovery | source, installed | Proven at source with the forward-recovery command covered in the installed capacity qualifier; the in-place fence replaced a `dev:ino` identity whose inode reuse CI reproduced at `7467786` on PR #121 and at `ce65d5c`, `14be44d`, `53c11df` and `a46eea7` on the main-based PR #120, while other runs of the same revisions passed |
| Q33 | `controller-monitor.test.ts` refuses to park when the environment proved a usable consumer and vetoes a usable second consumer; `reliability-recovery.test.ts` never recommends an action for unmanaged or user-stopped environments | source | Proven at source |
| Q34 | `recovery-budget.test.ts` bounds each kind separately, keeps the aggregate ceiling and never refunds a claim; `reliability-recovery.test.ts` blocks once the incident budget is exhausted | source | Proven at source |
| Q35 | `capacity-host-probe.test.ts` adds declared host allowance and one shared pool independently and rejects late or cancelled evidence; `capacity-accounting.test.ts` drops only the domains a collection omits or contradicts | source | Proven at source |
| Q36 | `scripts/qualify-harness-journey.sh` for both harnesses, each with an unmoved protected neighbour and byte-identical transitional record; recorded consumer cold `ensure` and stop with 11 routes freed | live | Proven |

Open or partial rows and what they mean for the release claim:

- Q20 has source coverage for clock discontinuity, sleep and grace resets, and no
  real host-suspend observation.
- Q26 is half not applicable: resources are discovered from Docker and Git rather
  than through a quarantining watcher chain, so there is no quarantine path to
  qualify.
- Q30 is proven live for a cancelled gate wait (the journey kills the shipped
  gate mid-wait and its re-delivery is refused), for parallel and nested calls,
  and for a real harness-initiated cancellation in both harnesses: interrupting
  the Claude CLI settles the claim as `interrupted`, while the Codex CLI kills
  its hook process outright so the claim stays `waiting` and the identical
  re-delivery maps it to `interrupted` and refuses it. A hook timeout below
  the wait budget is now observed rather than assumed: the harness abandons the
  gate, no decision of devrouter's reaches the call, and the shipped wiring
  carries a guard that fails when a recommended timeout stops leaving headroom
  above the 30s default budget. A settled grant is now observed as well: both
  harnesses re-delivered the call's own id under a changed command, the gate
  refused it as `continuation-replay` against the recorded `granted` state, the
  changed command never ran, and the same command under a fresh id was allowed
  once the checkout was settled. Only a runtime-dependent browser or MCP tool
  stays open.
- Q07 and Q08 are not applicable as OOM questions because no OOM classifier
  exists; the underlying requirements are carried by the headroom, dwell and
  admission contracts above and by process-absence evidence.

PR #121 adds `scripts/qualify-killed-runtime-recovery.sh`
(`pnpm qualify:killed-runtime`) for the container-local death cells of RF09. At
`bb72cb6` it produced both deaths against a routed, 64 MB-limited container:
SIGKILL left `status=exited exit=137 oom=false restarts=0` and the kernel's OOM
kill left `status=exited exit=137 oom=true restarts=0`. In both cells the
container and its published route stayed as inspectable evidence, the route
stopped serving instead of reporting success, no devrouter statement classified
the death as an OOM kill, and the same container restarted with the route
serving again. The cell needs Docker and the mkcert root CA; host suspend (Q20)
and the harness-initiated cancellation seams stay open.

Source rows prove the contract and its failure handling in this repository's
suite and are not claims about an installed artifact. The installed and live
columns carry the release's behavioural claim. Q06 was requalified after the
release by the slow-dependency fixture recorded below. Q29, Q30 and Q32 gained
their 2026-09-20 evidence from PR #121, including the hook-timeout cell that
records what a harness does when it abandons the gate and the redirect cell that
records what both harnesses do when a settled call's own id returns under a
changed command. Requalifying Q20 still
needs a bounded observation harness that does not exist yet, so it stays open rather than
approximated.

### Release 0.1.0 preparation (slice 7)

Slice 6 is merged as `d724096` (`feat(harness): qualify a second agent harness and a
non-Node consumer`), integrated with the concurrently released 0.0.80 (`ff91850`,
Devsy version range). The integration merge kept the released 0.0.80 section intact
and returned this branch's two entries to `[Unreleased]`, and the bundled skill and
its embedded copy in `src/core/agents-md.ts` were re-verified as identical after
the merge (they differ only by the escaped backticks the embedded literal needs).

This is the separate release-artifact commit the plan requires: `package.json` and
both released example pins move to 0.1.0, `CHANGELOG.md` gains the `[0.1.0]`
section with its single adaptation-prompt reference, and `upgrade-prompts/0.1.0.md`
carries the adaptation guidance. No source, schema, command, flag or journal
change is part of this commit.

Local validation for the release commit: docs policy, knowledge validation, Biome,
Knip and `tsc --noEmit` are clean; the build succeeds; `scripts/package-smoke.sh`
packs `@devrouter/cli 0.1.0`, passes the negative member check and the closed
network qualification (`networkPackageQualification: passed`, 16 Docker calls, 1
retained-container inspection, 0 mutations), and verifies the installed package
from a temporary cwd. `doctor --repo ./examples/routing` and `repo inspect` run
clean against the example, and both report the installed 0.0.79 CLI against the
example's pin, which the 0.1.0 installation resolves.

Publication stayed a separate, explicitly approved effect and ran in that order:
the release commit merged first, and the GitHub release published through the
repository workflow.

### Release 0.1.0 publication, artifact and installation (slice 7)

Tag `v0.1.0` points at main `25a9ec3` and is published, not draft and not
prerelease. The release event ran workflow 35503145787: the `check` job passed
the full validation list and the `publish` job published
`@devrouter/cli@0.1.0` with provenance.

Artifact verification: the registry tarball's sha512
(`sha512-BcaGmUico2AVva23HxhNnX/TrvRBkd8AWF09po01nsP4agedu2nPMC5ohJnMYoRDtq3i9I7CK/c8EKcj9I9aog==`)
and sha1 (`c16db1e798e58ef892e42988140fa09af56fd6d8`) equal the `dist.integrity`
and `dist.shasum` the registry records for the version, and the tarball's
`dist/devrouter.js` and `dist/devrouter-lifecycle-worker.js` are sha256-identical
to a local build of the tagged revision, whose tree is identical to the merge
commit. Publication does not reach every reader at once: for the first minutes
the packument on this machine's edge still reported 0.0.80 and the tarball path
returned `{"error":"Not found"}`, so an initial install failed with `ETARGET`
while the artifact was already live elsewhere. Re-read the packument before
concluding anything from a version-lookup failure.

Installs: both global installs moved from 0.0.79 to 0.1.0, the Homebrew npm
prefix at `/opt/homebrew/lib/node_modules/@devrouter/cli` and the Volta node
24.17.0 image copy at
`~/.volta/tools/image/node/24.17.0/lib/node_modules/@devrouter/cli`.
`volta install @devrouter/cli@0.1.0` additionally registers the package with
Volta and shims it at `~/.volta/bin/devrouter`. `devrouter -V` run against the
released example reports installed 0.1.0, `doctor --repo ./examples/routing`
reports `global.cli-path` OK with all three PATH entries at 0.1.0 and
`runningVersion` 0.1.0, and `repo.cli-outdated` OK with
`installedVersion` 0.1.0 equal to `repoVersion` 0.1.0, which closes the
example-pin gap the preparation slice recorded. Two live findings are unchanged
and stay operator-owned: `global.capacity-ledger` reports
`capacity-history-unprovable` and `global.network-capacity` reports unknown
allocation readiness, while `global.devsy-agent` keeps its warning that Devsy
1.19.0 governs its own agent.

Consumer coordination: task `01a06930-fdea-70f1-bebf-9514b07e23a0` was notified
with the 0.1.0 changes, the read-only first checks, the recorded recovery path
(`workspace journal settle` → `status` → `stop`/`ensure`, each requiring its
own terminal evidence) and the two items it owns, the before/after
`status --json` reproducer for the `{"stopped": false, "freedRoutes": 0}`
observation and the post-start liveness contract of its repository adapter. No
recovery is claimed from this side: the pre-registration blocker stays closed
only under the consumer's own live proof, and its staged merge and worktree Git
state were not touched.

Consumer response: the notified task ran one completed turn after the message and
returned to idle. Its report text is not relayed between tasks, so its own
transcript remains the evidence for its environment; this record carries the
notification, the observed turn and the recovery path only.
### Slow and failing dependency lifecycle — Q06 live qualification (2026-09-20)

Q06 was the one applicable acceptance row whose behavioural half stayed unmeasured
at the 0.1.0 release: its deadline and no-amplification contracts were covered at
source, but no run had produced a dependency that recovers slowly.
`scripts/qualify-slow-dependency-recovery.sh` (`pnpm qualify:slow-dependency`)
now produces the row's four outcomes against a synthetic consumer whose only
dependency is a container the fixture itself controls, and it asserts the contract
rather than only printing measurements.

The 2026-09-20 run against the installed 0.1.0 CLI (fixture `devrouter-q06-fixture`,
`DR_Q06_SLOW_SECONDS=40`, cap 90s, `failed: false`):

- slow: the dependency became healthy only after the 40s budget. The start waited
  and published the route after 41896ms with the dependency's `RestartCount` at 0,
  so grace is honoured instead of failing early.
- never: a dependency that never becomes healthy failed in 7548ms with the
  provider's own verdict naming the unhealthy container, published no route and
  left the container exactly as created — a bounded deadline with an actionable
  message rather than an open-ended block.
- unchanged: the same unhealthy dependency already running was not recreated; the
  start reused container `4c7fb1544975` with its original start timestamp after
  1403ms.
- stopped: an exited dependency was started exactly once, with the same container
  identity and a new start timestamp, and the wait ended in a bounded failure after
  7507ms.
- Across all four rounds the dependency's `RestartCount` stayed 0 and the route was
  released by the fixture's own teardown, which is the row's no-amplification
  evidence.

Two observations are recorded rather than fixed. A start that waits for a slow
dependency prints no progress line while it waits; the provider's output appears
when the wait fails. And an already-running dependency is accepted on its running
state alone, so a running-but-unhealthy dependency does not block the
application's start. Neither changes an authority or a readiness claim: the route
a start publishes is still proved by the application's own readiness contract, and
the consumer that declares a dependency healthcheck owns what that healthcheck
means.

### Admission-refused managed start and consumer dogfood status (2026-09-20)

The live consumer's fixed Postgres binding on 5432 is a real conflict with the
shared `devrouter-traefik`, so a managed `ensure` correctly refuses before any
provider mutation. The refusal was silent afterwards: the journal records the
intent as `running` while no runtime exists, so `devrouter status` returned
`desired: running`, stable phase, `admission: not-applicable`, empty `active`
and no drift, and `stop` refused for want of a registration. An agent had a
blocked environment with no attention reason and no supported next step.

Reproduced live on the released 0.1.0 CLI with a synthetic fixture whose compose
file publishes `127.0.0.1:5432` while the shared Traefik container holds it.
The refused ensure wrote `operation.status = COMPLETED`, `exitCode = 1` and the
`hostPortConflicts` entries into `~/.config/devrouter/reliability/<hash>.json`,
and the following `status --json` was the silent block above; `stop . --json`
returned `{"stopped": false, "freedRoutes": 0}` and only then cleared the intent.
The durable refusal evidence existed and nothing read it.

Implemented in `src/core/managed-runtime-status.ts` (`refusedManagedStart` plus a
new `start-refused` branch of `reliabilityRecovery`) and `src/types.ts`
(`ManagedReliabilityReason`): status reads the persisted ensure result and
reports `start-refused` when a refused operation left the running intent in
place. Recovery names the read-only `devrouter doctor <repo>` check and the
consumer-side fix, an explicit `stop` releases the intent and the reason, and an
admitted ensure clears it. One writer per file and no new module; the existing
journal-derived reasons keep precedence, and the lifecycle block is still
omitted whenever provider or journal evidence is unavailable. Live-worker,
unknown-ownership and surviving-resource refusals are unchanged.

Evidence: three new `managed-runtime-status` cases (refused start, released
intent, admitted start); 44 tests across the affected suites and the full suite
(2684 tests, 148 files) pass; `biome`, `knip`, `tsc --noEmit`,
`check-docs-policy` and `check-knowledge` pass. Live, with the branch CLI:
refused ensure → `attention.reason = start-refused` with both recovery commands
in JSON and human output; `doctor` `repo.host-port-claims` names the consumer
binding; after `stop` the reason is gone.

Consumer version report: the "0.0.51" that the consumer observed is not an
installation defect. `~/.volta/bin/devrouter` is a Volta shim, and from inside
the Klicker checkout it resolves the repository's own devDependency
`@devrouter/cli@0.0.51`; from a directory outside the checkout the same shim
reports 0.1.0. Every global installation verified 0.1.0 — the Homebrew
`node_modules` copy and all three Volta package stores. Dogfooding 0.1.0
therefore requires the consumer to bump its own pin, both the
`package.json` devDependency and `.devrouter.yml` `devrouter.version`.

Consumer status after the 2026-09-19 findings, as far as this side can verify:
the post-start liveness item handed back to the consumer is closed in their
source by PR uzh-bf/klicker-uzh#6170 ("fail startup fast when a managed process
dies early"), merged 2026-09-20; no live recovery is claimed from that merge.
The `{"stopped": false, "freedRoutes": 0}` reproducer has not arrived, so that
observation still stands unreproduced. Their port-claim decision on 5432 remains
open and stays a consumer-side choice; no `workspace journal settle` or capacity
reconciliation has been run by them, and no ensure → stop-on-running pair has
been produced yet. Their staged merge and worktree Git state were not touched.

### Admission-refused start release and installation — 0.1.1 (2026-09-20)

The `start-refused` fix merged as `d2a3750` (PR #117) and the release artifacts
merged as `3622b83` (`chore(release): prepare 0.1.1`, PR #118). Tag `v0.1.1`
points at that revision and is published, not draft and not prerelease. The
release event ran workflow 35506198134; the `check` job passed the full
validation list and the `publish` job published `@devrouter/cli@0.1.1`.

Artifact verification: the registry records
`dist.integrity = sha512-Ha4w7q7LZFnkm60FT9QwlL1kdcnzzhx8NuUt5xWwyhHd+5jS1EZZlvdQWcdiK4e3ybGHavzimBgea9wWCg9YOQ==`
and `dist.shasum = f70fed859a64ad44430be057a71e7e7f7fba35a3` for the version;
the downloaded tarball's SHA-512 equals that integrity, and its
`dist/devrouter.js` and `dist/devrouter-lifecycle-worker.js` are SHA-256
identical to a local build of `c6b317d`, the release commit. Publication again
did not reach this machine's edge at once: the version lookup returned E404 for
roughly two minutes after the publish job reported success, and the ninth poll
resolved.

Installs: the Homebrew npm prefix and the Volta package store both moved to
0.1.1, and `global.cli-path` reports all three PATH entries at 0.1.1 with
`runningVersion` 0.1.1 while `repo.cli-outdated` is OK at
`installedVersion` 0.1.1 equal to `repoVersion` 0.1.1. The Volta node 24.17.0
image copy needed an explicit `--prefix`: that node image's own npm resolves the
`/opt/homebrew/Cellar/node/26.9.0` prefix, so a plain `npm install -g` from
Volta's node leaves the copy stale. Two live findings remain operator-owned and
unchanged: `global.capacity-ledger` reports `capacity-history-unprovable`, and
`global.network-capacity` reports unknown allocation readiness.

Live proof on the released artifact, not the branch build: the synthetic fixture
`/private/tmp/dr-refusal-repro`, whose compose file publishes `127.0.0.1:5432`
while the shared router holds it, was driven with the installed 0.1.1 CLI.
`ensure . --json` refused with `hostPortConflicts` naming
`devrouter-traefik`; `status . --json` reported
`repo.managedRuntime.reliability = {desired: running, phase: stable, attention:
{reason: start-refused}}` with both recovery commands, and the human status
printed `Lifecycle attention start-refused` with Recovery 1 and 2;
`doctor .` reported `repo.host-port-claims` as an error naming the consumer
binding, its holder and the router-keeps-running remediation; `stop .` left
`desired: stopped-by-user` with no attention reason. The refusal itself is
unchanged and fail-closed.

Consumer coordination: task `01a06930-fdea-70f1-bebf-9514b07e23a0` was told
that 0.1.1 is published and installed, that its "0.0.51" observation is its own
pinned devDependency shadowing the Volta shim rather than an install defect, and
that dogfooding requires it to bump both its `package.json` pin and its
`.devrouter.yml` `devrouter.version`. The message carries the `start-refused`
evidence, asks for the `repo.managedRuntime.reliability` block after its own
ensure, and leaves the before/after `status --json` reproducer and the 5432
claim decision with that task. No consumer recovery is claimed from this side,
and its staged merge and worktree Git state were not touched.

### Post-release reliability review and follow-up (2026-09-20)

Status: **active; the reviewed corrections shipped in 0.1.2 and are installed.**
Remaining acceptance: RF08's explicitly authorized integrated canary, RF09's Q20
host suspend and live-environment tool, RF10's operator journal recovery, RF11's
consumer adoption and RF12's remaining measured breadth — its stopped-resume
and fault-recovery cohorts are measured, while preparation reuse in a routed
consumer, profile and host/container alternation, browser/auth cells and any
evidenced optimization stay open.
The user requested that all findings and improvements from the latest CLI review
remain part of the roadmap. This section is the current follow-up backlog for
the governing [roadmap in PR #57](https://github.com/rschlaefli/devrouter/pull/57),
at `d2e69e2e5815fb74bf46401bf3cef5a8ab7eaeed`. It retains that roadmap's
W0–W9, S1–S8, M0–M3 and Q01–Q36 obligations. `docs/project/` remains the
single project-artifacts root.

#### Review baseline and evidence

Reviewed main: `7765c1414bc9122ccf939f3550fa0b4dbad660c5`; published 0.1.1:
`3622b8315594a68f4cb9a6036b318a4961180313`. Executable source, scripts,
workflow, package definition and lockfile are identical between those revisions.
The registry's latest version and all three local global installations reported
0.1.1. CLI and lifecycle-worker bundle hashes matched across the installs and
the retained release build. [Release CI](https://github.com/rschlaefli/devrouter/actions/runs/35506198134)
and [main CI](https://github.com/rschlaefli/devrouter/actions/runs/35506817733)
passed. These facts establish publication and installation, not consumer recovery.

The review ran 63 tests across managed-runtime status, ensure output, reliability
liveness and file-lock suites, plus 37 harness gate, continuation and command
tests; all passed. Additional read-only installed-CLI probes reproduced RF01.
Injected phase/clock probes reproduced RF02's command-form distinction and denial,
RF03 and RF04 without modifying a live journal. Passing tests
currently encode some faulty behavior, so test counts alone cannot close these
findings. No consumer source, runtime or machine policy was changed by the review.

#### Confirmed defects and immediate corrections

All items below are open. The Devrouter maintenance owner owns source changes;
IDs identify backlog entries, not new modules or branches.

| ID / priority | Finding and evidence | Required result and acceptance |
| --- | --- | --- |
| RF01 / P2 — Diagnose the intended checkout | `reliabilityRecovery` in `src/core/managed-runtime-status.ts` emits `devrouter doctor <path>`, but `src/cli.ts` declares only `--repo <path>`. From a different cwd, installed 0.1.1 silently diagnosed that cwd and missed the fixture's fixed-port conflict. The `--repo` form found it. | Emit the supported form with safe path handling. Execute the suggested diagnostic against a synthetic checkout from a different cwd, including a path with spaces, and assert the selected repo and structured conflict. Replace the test that merely matches the incorrect prose. Preserve the shared router; carry the conflict-specific consumer-binding remedy instead of suggesting its shutdown. W1/W7, Q28. |
| RF02 / P2 — Let lifecycle commands reach their owner | `DEVROUTER_COMMAND_RE` in `src/commands/harness.ts` recognizes bare `devrouter`, but misses absolute and checkout-local executable paths. With injected `stopping`, bare `devrouter stop .` passed through while `/opt/homebrew/bin/devrouter stop .` was denied. | Recognize supported direct executable and launcher forms, including quoted paths, without executing or broadly interpreting shell text. Prove status, stop and ensure reach their own lifecycle checks during a transition; unrelated calls still defer. Inspect wrapper forms before claiming support. W9, Q29. |
| RF03 / P2 — Honor the full wait budget | `waitForHarnessGate` refuses when `waitedMs + pollInterval > budget`. A 1500ms budget refused at 0ms despite settling at 300ms; a 5000ms budget refused at 4000ms despite settling at 4500ms. | Wait the remaining partial interval and refuse only at the deadline. Deterministic tests cover zero, sub-interval and non-multiple budgets, final observation, and no deadline overrun. Re-run both installed harness journeys with a hook timeout accounting for initialization and wait. W9, Q29. |
| RF04 / P2 — Make parked-state recovery truthful | Status promises that `devrouter ensure <path>` waits for free capacity. The actual operation-request path in `src/core/reliability-model.ts` rejects `parked-for-capacity`, even at idle with complete stop proof; the controller submission path uses that transition. | Align guidance with the supported controller wait/resume path, or implement joining that path under the existing admission contract. Prove an installed parked ensure either follows the same incident safely or returns truthful next steps. It must not bypass headroom dwell, duplicate startup, reset budgets, or revive user-stopped intent. W1/W6a/W9, Q14–Q15. |
| RF05 / P3 — Preserve uncertainty in hook output | `permitReason` in `src/commands/harness.ts` says `environment settled` for passthrough, unmanaged and invalid-payload decisions. `waitForHarnessGate` also treats unknown phase as settled. These paths need not have observed the environment. | Keep the intended advisory fail-open behavior, but distinguish bypass, unmanaged and unavailable evidence from observed settlement in structured decisions and both harness envelopes. Assert classification and observation behavior rather than exact prose. W1/W7/W9, Q21/Q29. |
| RF06 / P3 — Stabilize queue-progress verification | [The push CI run](https://github.com/rschlaefli/devrouter/actions/runs/35506176174) failed `file-lock.test.ts`'s stable queue-position case at `progress.length >= 1`; the same release revision and focused rerun passed. Its real 80ms wait can expire before a progress callback. | Make the timing assertion deterministic or synchronize on the observed wait boundary. Retain real process-identity and lock-exclusion coverage. Prove queue position and progress without relying on an 80ms scheduling window; do not suppress the assertion or rely on CI reruns. W1/W8, Q13/Q19. |

#### Corrected package (2026-09-20)

**RF01–RF06 are implemented** on branch `rs/reliability-guidance-and-gate-corrections`
at `05f8c0c` ([PR #121](https://github.com/rschlaefli/devrouter/pull/121)); the branch
was merged as `abcc233` and released in 0.1.2 (record at the end of this section).
At the time of this review the published 0.1.1 still carried the reproduced defects.

| ID | Disposition |
| --- | --- |
| RF01 | implemented — recovery lines emit `devrouter doctor --repo <checkout>`, keep the positional form for the lifecycle commands, and single-quote a path that needs it. Unit coverage asserts the emitted form; a built-CLI run from another directory selected `/private/tmp/devrouter rf01 fixture with space` as its `repoPath`, while the previous form reported the caller's directory instead. |
| RF02 | implemented — the gate parses each shell segment's leading command word, skips `env`/assignment prefixes and the `npx`/`pnpm exec`/`npm exec`/`yarn` launchers, and compares the executable basename. Built-CLI proof: `devrouter stop .`, `/opt/homebrew/bin/devrouter stop .`, `./node_modules/.bin/devrouter ensure . --json`, `pnpm exec devrouter status --json` and `cd /x && devrouter ensure .` all answered `allow`/`devrouter-command` with no observation, while `echo /opt/homebrew/bin/devrouter` still observed the transition and refused. |
| RF03 | implemented — the wait spends the remaining budget and observes once more at the deadline. Deterministic tests cover a sub-interval budget, a settle exactly on the deadline, and a budget that is not a multiple of the interval; the built CLI refused a 1500 ms budget at 1500 ms (2 observations) and a 5000 ms budget at 5000 ms (4 observations). |
| RF04 | implemented as guidance alignment — the parked recovery lines name the foreground controller, the read-only status form and the intent release; `devrouter ensure` still refuses `parked-for-capacity`. Joining that path under the admission contract remains unimplemented and is not claimed. |
| RF05 | implemented — `waitForHarnessGate` returns `evidence-unavailable` for an unknown phase, and the hook envelope gives passthrough, unmanaged, invalid-payload and unavailable evidence their own wording instead of "environment settled". |
| RF06 | implemented — the fair-waiter queue-progress case drives its budget from a controlled clock instead of an 80 ms scheduling window, and the real process-identity and lock-exclusion coverage is retained. |

Evidence produced on `05f8c0c`:

- Focused `harness-gate`, `harness` command, `managed-runtime-status` and
  `file-lock` suites: 84 passed.
- Full suite: 2447 passed / 250 failed across 14 files, identical to the
  untouched `7765c14` baseline (2434 passed / 250 failed). The change adds 13
  passing tests and no new failure; the failures are environmental, because this
  sandbox denies `ps` and the file-lock boundary fails closed without process
  identity.
- `biome check`, `knip`, `tsc --noEmit`, docs policy, knowledge validation, the
  `tsup` build and `scripts/package-smoke.sh` passed.
- The built-CLI proof used a synthetic checkout and a temporary `HOME`; no live
  workspace, journal or machine state was touched.

Limits of this package: no real agent-harness journey has run against the
corrected revision, so RF02's and RF03's installed-harness confirmation, RF07's
cancellation/replay observation, and RF08/RF09's live fault matrix stay open.
Merging PR #121, releasing the corrected revision and republishing the installed
CLI remain separate authorized actions.

#### Live harness journey evidence (2026-09-20)

`scripts/qualify-harness-journey.sh` was run with Claude Code 2.1.278 against its
own local mock model, so no credentials, provider access or model spend were
involved. Three runs: one against the untouched `7765c14` build and two against
the corrected `05f8c0c` build. Each run creates its own temporary fixture
checkouts and `HOME`, and touched no live workspace or journal.

| Scenario | `7765c14` | `05f8c0c` run 1 | `05f8c0c` run 2 |
| --- | --- | --- | --- |
| deferral | pass | harness produced no tool call | pass |
| refusal | pass | pass | pass |
| neighbour | 1 failure | 1 failure | 1 failure |

Both gate-relevant scenarios pass on the corrected revision: the deferred call
ran once after a 6.0 s enforced wait and reported `settled-after-wait`, and the
refusal was delivered as exactly one denial whose tool never executed. Run 1's
deferral failure produced a one-turn, 70 ms transcript with no hook payload at
all, so the gate was never reached; it did not reproduce on the second run. That
harness-startup flake belongs to RF13's durable-proof work rather than to this
package.

The neighbour scenario fails the same assertion on both revisions — "the gate
keyed `<harness>/<sha>.json` instead of the gated checkout" — so it is a
pre-existing journey-script defect, not a regression from this package. The cell
cannot count as qualified until its owner disposes of that discrepancy.

The Codex journey was then run against the corrected revision with the same mock
model and no provider access: deferral passed (one call, executed after a 6.0 s
enforced wait, `settled-after-wait`), refusal passed (one denial, tool never
executed, "still starting after waiting 3.0s"), and neighbour failed the same
pre-existing ledger-key assertion. Both gate-relevant scenarios therefore hold
on two harness integrations for the corrected build, and the neighbour cell
stays open on its own pre-existing defect.

#### Durable journey proof and machine diagnostics (2026-09-20)

Status: **RF13 implemented and locally qualified; RF10 source diagnostics
implemented and live-reproduced read-only**. Both sit on
`rs/reliability-guidance-and-gate-corrections`
([PR #121](https://github.com/rschlaefli/devrouter/pull/121)) and are not merged
or released, so the published 0.1.1 and the installed CLI still carry the
neighbour journey defect and the collapsed capacity marker.

RF13 — journey proof. The neighbour scenario compared the ledger path against the
gated checkout without canonicalizing either side. That scenario deliberately
writes no ledger, so both values stayed unresolved caller paths, and the fixture
root inherited `$TMPDIR`'s trailing separator
(`.../T//devrouter-harness-journey.XXXXXX`); the assertion failed on that doubled
separator rather than on a wrong ledger key. `6d72964` makes the fixture root
physical (`pwd -P`, which also matches the physical paths the harness itself
reports), compares physical paths, and adds two pieces of durable proof:

- `DR_JOURNEY_EVIDENCE=<path>` writes one sanitized summary: outcome, per-scenario
  assertions, the exact source revision, the built bundle's SHA-256, the harness
  version and the Node version. It carries no credentials and no model output.
- Exit 3 now means "prerequisite unavailable" and writes `outcome: skipped` with
  every scenario `not-run`, so an unrun cell cannot be read as a pass.

Evidence at `6d72964`: Claude Code 2.1.278 passed deferral, refusal and the
previously failing neighbour cell; Codex `0.155.0-alpha.9.2` passed the same
three against the same mock model with no credentials. Ordinary CI already carries
the deterministic command-form and wait-budget regressions
(`src/commands/__tests__/harness.test.ts`, `src/core/__tests__/harness-gate.test.ts`).
The workflow adds the bounded live cell: the `harness-journey` job in
`.github/workflows/ci.yml` runs on the `workflow_dispatch` input
`harness_journey`, installs `@anthropic-ai/claude-code@2`, runs the journey with
evidence output, uploads the summary artifact, and fails on exit 3.
[Dispatched run 35509449423](https://github.com/rschlaefli/devrouter/actions/runs/35509449423)
passed `check` and `harness-journey` on `6d72964`.

RF10 — machine blockers. `CapacityHistoryError` now carries a bounded
`CapacityHistoryCause` and, for a single offending entry, its sanitized name;
`listReliabilityOperations` raises `ReliabilityJournalError` with that
classification instead of discarding it; doctor prints the cause and location and
keys its suggestion to the cause; and the network check names the missing evidence
instead of only its consequence. The same read-only doctor probe on this host now
reports:

- `global.capacity-ledger: error` with details
  `capacity-history-unprovable; journal-entry-unsupported; at
  23fe529a….stuck-stopping-20260914T1720.bak` and the suggestion to move that
  unrecognised entry out of the private reliability journal directory while
  preserving its contents.
- `global.network-capacity: warn` with
  `Allocation readiness: unknown. Missing evidence: Docker network inventory is
  unknown; retained container references are unknown; route evidence is
  incomplete or unknown.`

The exact invalid history is therefore an operator backup file left inside
`~/.config/devrouter/reliability/`, and one such entry blocks every capacity read
machine-wide. The supported recovery prepared for operator review is to move that
`.bak` file out of the journal directory, keep it, and re-run `devrouter doctor`;
`capacity reconcile --yes` stays limited to positively absent history and does not
apply here. Machine policy and operator state are separate live effects, so the
file was left in place and no ledger, journal, policy or runtime state was
touched. Fail-closed behavior stays covered by tests: a corrupt entry is
`journal-invalid`, a loose-mode or oversized entry is `journal-entry-unsafe`, an
unreadable entry is `journal-unreadable`, and no record content reaches the
report.

#### Harness gate breadth and lifecycle passthrough (2026-09-20)

Status: **implemented and locally qualified on
`rs/reliability-guidance-and-gate-corrections`
([PR #121](https://github.com/rschlaefli/devrouter/pull/121)); not merged or
released.** Six commits, `097bdb7`, `40b23f0`, `72f14db`, `ca2483b`,
`fbfb5ca` and `1af4680`, close the non-shell, overlap, nested and cancellation
halves of Q29 and correct a defect the qualification itself exposed.

Lifecycle passthrough defect (`097bdb7`). The gate's contract says lifecycle
commands (`devrouter ...`) always pass through, and the shipped guidance names
Codex's shell tool as `exec_command`. The bypass nevertheless required
`tool_name === "Bash"` and read only `tool_input.command`, while the Codex CLI
delivers `exec_command` with `tool_input.cmd`. Under Codex, `devrouter stop` or
`devrouter status` issued while the checkout was transitional was therefore
deferred for the whole wait budget and could return the refusal that tells the
agent not to retry — the gate could block the repair command it exists to leave
alone. The bypass now reads both spellings without depending on the tool name,
and `src/commands/__tests__/harness.test.ts` carries a regression for two
Codex-shaped payloads. That regression was falsified against the old condition:
the old code called the observer and returned the wrong reason.

Non-shell seam qualification (`40b23f0`). The journey proved the gate only for
each harness's shell tool, and the recommended wiring in `src/core/agents-md.ts`
and the bundled skill matched just `Bash` (Claude Code) or
`exec_command|Bash|shell` (Codex). The journey now writes a test-owned stdio MCP
server with one tool and scripts a call to it from the harness's own advertised
tool list, so the scenario never guesses how a client spells a server tool:

- `nonshell-allow` — settled checkout: the hook observes
  `mcp__marker__write_marker`, allows it, and the MCP server writes exactly one
  marker line.
- `nonshell` — transitional checkout: the identical call is refused with the
  phase and recovery text, that refusal reaches the model, the continuation
  ledger records `refused`, and the MCP server writes nothing.

The allowed cell runs first, so the refusal cell is read against a tool the same
run just observed to work.

Overlap qualification (`72f14db`). Two calls that reach the gate at the same
time were never decided by the journey, and the continuation ledger is the only
thing that keeps a re-delivered call from running twice, so the overlap is
qualified at both levels:

- `parallel` — the mock scripts two shell calls in one model turn. On this host
  Claude Code executed the two `Bash` calls sequentially: the first waited
  12.1s for the settlement and the second, delivered after the first returned,
  was allowed immediately as settled. Both ran exactly once, neither was
  refused, and the ledger held one granted claim for the single announced wait.
- `concurrent` — two hook processes start at the same instant with the same
  payload and distinct tool-call ids, so the overlap is the product boundary's
  own instead of an artifact of how a harness sequences its calls. Both
  observed `starting`, both settled `deferred-allow`/`settled-after-wait`
  after about 4.0s, and the ledger held two `granted` claims.

The concurrent cell was falsified against a ledger that keyed the claim on the
payload digest instead of the tool-call id: the second call was refused as
`continuation-replay` with `waitedMs` 0 and the cell failed four assertions,
while every other cell still passed.

Nested-call qualification (`ca2483b`, Claude Code only). A subagent runs its
own tool calls through the same hook the parent uses, and nothing proved that
its calls reached the gate. The `nested` cell scripts the harness's own
subagent tool: the subagent's first shell call arrives while the checkout is
settled and is allowed, the model fixture then turns the checkout transitional
immediately before scripting the second call, and that call is refused with the
phase and recovery text. The fixture flips the phase itself rather than racing a
watcher, so the refusal cannot be sequenced after the call it refuses. Removing
the transition falsifies the cell: the second call was allowed, ran, wrote its
marker, settled no claim and failed seven assertions, while every other cell
still passed. On this host Claude Code delivered the subagent's call as
`tool_name: Bash` with the same checkout as the parent. The Codex CLI exposes no
subagent tool, so the summary records the cell as `not-run` there rather than as
a pass.

Harness-initiated cancellation (`fbfb5ca`, extended to both harnesses at
`1af4680`). The earlier cancellation cell killed the gate itself; nothing
proved that a real harness cancel reaches the hook it owns. The `cancelled`
cell starts the CLI with a 30s hook budget on a transitional checkout, waits
for the hook's own wait announcement, then interrupts the CLI's process group.
The deferred command never ran and the identical re-delivery was refused as
`continuation-replay` in both harnesses, but the two CLIs treat the hook
differently. Claude Code forwards the interrupt: it reported
`terminal_reason: aborted_tools` and the hook settled the claim `interrupted`
1.3s into its budget with no duration. The Codex CLI reported exit code 1 with
`terminal_reason: incomplete` and killed its hook process outright, so the
durable claim stays `waiting`; the gate maps a still-waiting claim to
`interrupted` when the identical call is re-delivered, refuses it, and never
overwrites the record. The cell asserts each CLI's own transcript, the recorded
claim, the clean checkout and the refusal, so a harness that silently drops its
hook or reports the cancelled call as complete fails the run, and the Codex leg
accepts `waiting` only because a waiting claim can never become a granted wait.
All cells run last, so the earlier scenarios' evidence is unchanged. Both
harnesses ran the full set at `1af4680` against the local mock model, with no
credentials or provider spend:

| Harness | Version | Result | Retained summary |
| --- | --- | --- | --- |
| Claude Code | 2.1.278 | 11/11 pass | `/private/tmp/dr-claude-ff7efc4-evidence.json` |
| Codex CLI | 0.155.0-alpha.9.2 | 10 pass, nested not-run | `/private/tmp/dr-codex-ff7efc4-evidence.json` |

Both summaries name revision
`ff7efc41c69ee2bd666eda0ca783407d89bd48fc` and the same bundle SHA-256
`f431223a5cd7eb85e59844576937e7182629c7ea83e6df31ede70990a8a679e6` as
`ca2483b`, plus the harness version and the Node version. The earlier ten-cell
pair stays at `/private/tmp/dr-claude-1af4680-evidence.json` and
`/private/tmp/dr-codex-1af4680-evidence.json`, preceded by
`/private/tmp/dr-claude-ca2483b-evidence.json`,
`/private/tmp/dr-codex-ca2483b-evidence.json`,
`/private/tmp/dr-claude-72f14db-evidence.json` and
`/private/tmp/dr-codex-72f14db-evidence.json`. Harness facts the qualifier
pinned, each reproduced on this host:

- `.*` is a valid matcher in both harnesses and reaches every tool the model can
  call. The shipped Claude Code and Codex samples now use it and state the
  price: one short-lived process per gated call, with narrow matchers left to
  consumers that prefer the lower cost.
- Claude Code delivers an MCP call with
  `tool_name: mcp__marker__write_marker` plus an `mcp_server` field. Codex
  advertises an MCP server as a namespace tool
  (`{type: "namespace", name: "mcp__marker", tools: [...]}`), calls it with the
  function name plus a top-level `namespace` field, and reports the same
  `mcp__marker__write_marker` tool name to the hook.
- Codex refuses MCP calls under `approval: never` unless the server sets
  `default_tools_approval_mode = "approve"`. The journey fixture sets it, so
  the allowed cell is a real positive control rather than a silently blocked
  call.
- Claude Code delivered two `Bash` calls from one turn sequentially in headless
  mode, so a harness-level cell alone cannot prove an overlapping wait; the
  concurrent cell exists because the product boundary owns that guarantee.

The remaining Q29 and Q30 cell is a tool whose success depends on the live
managed environment, which belongs to RF08's authorized installed cell or to a
dedicated bounded fixture.

#### Hook-timeout consequence (2026-09-20, `ff7efc4`)

Hook `timeout` is not a gate. The findings recorded earlier show a hook that
overruns its configured timeout is abandoned and the tool then proceeds under
the harness's normal permission rules, which is why the shipped wiring keeps its
timeout above the wait budget. Nothing had observed the consequence of violating
that relationship on a transitional checkout. The `hook-timeout` cell inverts it
on purpose (a 3s hook timeout under an 8s budget) and runs last, so every earlier
scenario used the shipped value; the Codex leg rewrites only the fixture's own
`HOME/hooks.json` and the Claude leg passes a short settings file, so no live
harness configuration was touched. Nothing interrupts the run either: the
harness's own timeout ends the wait.

| Harness | Version | Harness result | Gate outcome | Command |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.278 | exit 0, `terminal_reason: completed` | claim settled `interrupted` | ran under the harness's own permission rules |
| Codex CLI | 0.155.0-alpha.9.2 | exit 0, `terminal_reason: completed` | claim stayed `waiting` | ran under the harness's own permission rules |

A hook timeout below the budget therefore does defeat the gate: the abandoned
wait never decides, the harness neither blocks the call nor reports the lost
decision to the model, and the command runs. The cell asserts only what must
hold whatever the harness does — the gate received the payload and announced the
deferral, the call recorded at most one claim, that claim was never `granted`,
the command wrote at most one marker line, both checkouts stayed clean and the
affected checkout stayed `starting` — and records the rest as observation. It is
a qualification of the boundary, not a defect claim against either CLI: the
harness applies its own policy when its hook does not answer.

What the product controls is the shipped wiring, so
`src/core/__tests__/agents-md.test.ts` now reads the generated skill file, finds
every `devrouter harness gate` hook in it and fails when a declared timeout is
below twice the 30s default wait budget. Setting a sample timeout to 20s
falsified that guard. The cell reuses the cancelled cell's settlement wait,
factored into one helper, so both cells read the ledger only after the recorded
claim settles or the observation budget has demonstrably elapsed.

Evidence: `/private/tmp/dr-claude-ff7efc4-evidence.json` and
`/private/tmp/dr-codex-ff7efc4-evidence.json`, both at revision
`ff7efc41c69ee2bd666eda0ca783407d89bd48fc` with bundle SHA-256 `f431223a…`.

#### Redirected call id after a grant (2026-09-20, `134a992`)

The journey already refused an identical re-delivery of a granted call, but
nothing observed a settled call's own id returning under a different command.
That is the redirect or superseded-call shape: a client or model that reuses
the id would otherwise run the new command on the earlier grant. The `redirect`
cell scripts one id twice — the first call waits on the transitional checkout
and is granted once it settles, the second repeats that id under a changed
command — and records what the client actually delivers instead of requiring a
particular client policy. Both harnesses delivered the repeated id, and the
gate refused it:

| Harness | Version | Delivered for the granted id | Gate outcome | Command |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.278 | two payloads under one id | `continuation-replay` against the recorded `granted` state | the changed command never ran |
| Codex CLI | 0.155.0-alpha.9.2 | two payloads under one id | `continuation-replay` against the recorded `granted` state | the changed command never ran |

Because the client's own delivery policy is outside the product's control, the
cell pins the boundary with two direct probes that re-enter the gate with the
recorded delivery's own field names, checkout and id: the granted id with the
changed command refuses with `continuation-replay` and the recorded `granted`
state, and the same command under a fresh id is allowed with `settled` on the
now-stable checkout. The granted call itself ran exactly once, the changed
command wrote nothing, both checkouts stayed clean and the affected checkout
ended `stable`.

Evidence: `/private/tmp/dr-claude-134a992-evidence.json` and
`/private/tmp/dr-codex-134a992-evidence.json`, both at revision
`134a992eb761d4a3cf4699fedcbd6b9cde0ab204` with the unchanged bundle SHA-256
`f431223a…`. Claude Code passed 12/12 cells; the Codex CLI passed 11 decided
cells with `nested` recorded not-run. The `ff7efc4` summaries above stay as the
narrower hook-timeout record.

#### Qualification, operator and consumer follow-up

All entries remain open unless their status explicitly says investigation.
Priority here orders the remaining reliability outcome, not permission to mutate
an operator's or another task's environment.

| ID / priority / owner | Remaining work and evidence | Acceptance and boundary |
| --- | --- | --- |
| RF07 / P2 — Cancellation and replay; Devrouter/harness owner | **Implemented and locally qualified on PR #121 (`7467786`); merged as `abcc233` and released in 0.1.2.** The journey gained an `interrupted` scenario that kills the shipped gate during its wait and replays the exact payload: the ledger records `interrupted` with no claimed `waitedMs`, the identical re-delivery is refused as `continuation-replay` against the recorded state, and the command never runs. The granted and refused calls also replay their exact captured payloads and must refuse with their recorded outcome, so a resending harness cannot execute one mutating call twice. Claude Code 2.1.278 and Codex 0.155.0-alpha.9.2 passed all four scenarios, and the `cancelled` cell now interrupts each real CLI while its own hook waits (`fbfb5ca`, extended to the Codex CLI at `1af4680`): Claude Code settles the claim `interrupted`, while the Codex CLI kills its hook so the claim stays `waiting` and the identical re-delivery maps it to `interrupted` and refuses it. Both harnesses ran the full set at `1af4680` against the local mock provider with no credentials or spend, and the retained summaries name revision `1af4680493f766b068bb8a4c4b5062d168bd2630` and bundle SHA-256 `f431223a…`; the earlier Codex summary stays at revision `7467786` with bundle SHA-256 `84ca0577…`. Claim timing was not changed; the cancellation-after-grant path is now refused by reproduced evidence instead of reasoning. The `hook-timeout` cell added at `ff7efc4` inverts the shipped relationship on purpose (3s hook timeout under an 8s budget) and runs last, so every earlier cell used the shipped value; both harnesses then ran the command under their own permission rules while the abandoned claim never became `granted` (Claude Code settled it `interrupted`, the Codex claim stayed `waiting`), the affected phase stayed `starting`, both checkouts stayed clean and no command ran twice. A guard in `agents-md.test.ts` now fails when any shipped hook timeout drops below twice the 30s default wait budget. The `redirect` cell added at `134a992` scripts one id twice, so a settled call's own id returns under a changed command: both harnesses delivered the repeated id, the gate refused it as `continuation-replay` against the recorded `granted` state, the changed command never ran, and the same command under a fresh id was allowed once the checkout was settled. Remaining for this row: a tool whose success depends on the live managed environment. | Observe cancellation, redirect and hook timeout before claim, during wait and after grant in each supported actual harness. Record whether the tool ran and reject continuation of a superseded task. Change claim timing only after its semantics are resolved; preserve ordinary settled-call behavior and uncertain-write non-replay. Include parallel/nested calls and a genuinely runtime-dependent browser/MCP tool in Q29; a shell command named `exec_command` does not by itself prove that seam. W9, Q22/Q29–Q31. |
| RF08 / P1 acceptance — Complete the integrated canary; Devrouter owner with the exact consumer owner | M1 is not closed by the current Q36 evidence. `scripts/qualify-harness-journey.sh` directly changes journal phases and runs a scripted tool through a real harness. Its neighbour record stays unchanged, but it does not exercise the full live failure/parking/resume sequence. Separate ordinary consumer startup/stop proof does not supply the missing integration. | Select an explicitly authorized installed platform/provider, consumer/profile and harness with two environments. Prove semantic readiness, required-process death, persistent pressure through the qualified injection boundary, safe parking, retained data/dirty source, fresh admission and resume, and actual neighbour functionality with zero agent-authored infrastructure repair. Keep source, installed and real-provider evidence separate. Apply twenty routine and ten selected fault repetitions or justify the scoped alternative before the run. W2–W9/S1–S8, M1, Q01–Q36. |
| RF09 / P1 acceptance — Reconcile the fault matrix; Devrouter owner | **Reconciliation pass on 2026-09-20 (PR #120; evidence on PR #121).** Q30 moved from source-only to live for a cancelled gate wait, Q29 and Q32 gained the journey and the content-digest fence, and Q29's non-shell, overlap and nested seams are now qualified: the journey drives a real MCP server tool through the hook in both harnesses, refused mid-transition and allowed once settled (`40b23f0`); two cells decide two calls over one checkout, including the same payload under distinct ids (`72f14db`); a Claude-only cell refuses a subagent's shell call once the checkout turns transitional (`ca2483b`), and a cell interrupts each supported CLI during its own hook's wait (`fbfb5ca`, extended to Codex at `1af4680`), where Claude Code settles the claim as `interrupted` while the Codex CLI kills its hook so the claim stays `waiting` until the re-delivery maps it to `interrupted` and refuses; Codex records only the subagent cell not-run. Both harnesses also ran a hook timeout below the wait budget (`ff7efc4`), which abandons the gate and leaves the call to the harness's own permission rules while the claim stays short of `granted`, and both re-delivered a settled call's own id under a changed command (`134a992`), which the gate refused as `continuation-replay` against the recorded `granted` state while the changed command never ran. The container-local OOM/SIGKILL cell is qualified at `bb72cb6` through `pnpm qualify:killed-runtime`. Still live-open: Q20 host suspend and a tool whose result depends on the live managed environment. Q07/Q08 stay not applicable as OOM questions because the product documents that it neither detects nor prevents OOM; Q26 has no quarantine path to qualify. | Reassess each original required result and evidence layer, preserving passing source evidence. Exercise container-local OOM/SIGKILL and retention in an authorized disposable runner, without requiring a speculative classifier. Qualify sleep/wake, unavailable provider, interruption/unknown completion, partial stop, corruption and pressure as applicable. Mark unsupported cells and absent quarantine behavior explicitly; narrowing the approved outcome needs a recorded decision. Do not convert missing implementation or missing fixtures into a passing/not-applicable row. W3–W5/W8/W9, M1–M2. |
| RF10 / P2 — Explain and recover machine blockers; operator with Devrouter diagnostic owner | **Implemented on PR #121; merged as `abcc233` and released in 0.1.2.** The installed 0.1.1 still prints the bare `capacity-history-unprovable`. The corrected build names the bounded cause, the offending journal entry and a cause-keyed recovery, and the network check names the three missing evidence inputs; the exact invalid history is an operator `.bak` file inside the private reliability journal directory. Remaining: the operator's own file move, which the installed 0.1.2 diagnostic now names. | Add bounded, values-free cause/location diagnostics sufficient to identify the exact invalid history or missing network evidence. Prove unreadable/corrupt/unknown state remains fail-closed. Prepare an exact supported recovery for operator review; `capacity reconcile --yes` applies only to positively absent history under its existing proof, not generic unprovable history. Preserve evidence and surviving charges. Setup/injection, policy changes and recovery are separate live effects. W1/W6a/W7, Q21/Q32/Q35. |
| RF11 / P2 — Close consumer adoption with live proof; existing Klicker task owner | Task `01a06930-fdea-70f1-bebf-9514b07e23a0` has not supplied a terminal recovery receipt to this review. The earlier 0.0.51 observation came from its project devDependency; global 0.1.1 does not change that pin. The 5432 claim decision and the `stopped:false, freedRoutes:0` before/after reproducer remain with that owner. A related primary-checkout stop defect was reproduced and fixed locally instead, and the fixed bundle returned `{"stopped": false, "deleted": true, "freedRoutes": 0}` for the already-deleted-registration shape while settling its journal (see *Primary managed stop recovery for absent registrations* below), so this owner should re-run its reproducer on a build that carries that fix. Adapter liveness PR #6170 is merged source evidence only. | Owner verifies executable resolution in the actual cwd, updates its package/config pins through its own source lane, resolves its binding, then records ensure, semantic smoke, stop and final exact routes/provider/resources. Return any reproduced CLI defect here. Preserve the staged merge and all other workspaces; exclude PRD, ingestion and rollout work. W1/W4/W7, M1–M2. |
| RF12 / P2 — Finish measured breadth and efficiency; Devrouter/consumer owners | **Measurement pass on 2026-09-20 (`1c42592`).** `scripts/qualify-lifecycle-cohorts.ts` (`pnpm qualify:cohorts`) runs three cohorts on one disposable devsy-managed fixture at the machine's real provider state: a cold `ensure`, a non-destructive `stop` followed by a resume, and a `SIGKILL` followed by recovery. Three rounds measured cold 9.6–20.3s (median 11.7s), stop 8.1–12.4s (median 8.5s), resume 9.7–13.1s (median 12.2s) and recovery 9.7–12.4s (median 9.9s). Every run was a first-attempt exit 0, peak CLI resident memory stayed at 70–73 MiB, each ensure started the same retained container (`recreated:false`, container ID unchanged), and the adapter log grew 1 → 2 → 3 while the marker planted before the stop survived both the stop and the kill. The retained path therefore already reuses the container and its Compose project, and no devrouter-side optimization is evidenced yet: the provider pipeline dominates after 2.3–3.5s of pre-provider work. **Preparation-reuse pass on 2026-09-20 (`c258ae0`).** `scripts/qualify-process-preparation.ts` (`pnpm qualify:preparation`) measured eight runs on one disposable primary fixture: cold ensure 36.1s with one preparation, unchanged reuse 23.0s with the same process PID and no preparation, a changed runtime 28.1s with a second preparation, a non-destructive stop 35.1s, a stopped resume 25.1s with a third preparation, an unknown-ownership refusal (exit 1, two refused adapter attempts, no completion, no preparation, process and route intact), a stop-then-ensure recovery 20.0s with a fourth preparation, and a pruned-population stop 11.0s that settled `idle`/`stopped-by-user`. Peak CLI resident memory stayed at 73-75 MiB and every accepted run was a first-attempt exit 0. The same harness reproduced and now regression-covers the primary managed stop defect recorded below. Still open in this row: profile and host/container alternation cells, browser/auth behavior in a selected cell, and any `before/after` optimization a later measurement justifies. | Measure stopped-resume and fault-recovery cohorts separately, preparation reuse, phase timings, memory and first-attempt failures. Qualify profile changes, host/container alternation and browser/auth behavior in the selected cells. Deliver only evidence-driven profile/artifact improvements, reporting before/after on the same workload. Keep extra providers/headless adapters conditional on selected scope; cross-host/cloud scheduling remains separate. W4–W8/W6b, M2–M3. |
| RF13 / P2 — Keep proof durable and release claims accurate; Devrouter owner | **Implemented and locally qualified on PR #121 (`6d72964`); merged as `abcc233` and released in 0.1.2.** The neighbour assertion defect is fixed, the journey writes a sanitized summary with source revision, bundle hash and harness/runtime versions, exit 3 marks a skip as `not-run`, and the opt-in `harness-journey` CI job passed its first dispatch. Remaining: keep the required live cells recorded as RF08/RF09 qualify. | Keep this follow-up active and publication receipts delivered. Retain sanitized producing-run summaries with immutable source/package and harness/provider versions. Add the relevant deterministic command/gate regressions to ordinary CI; arrange a bounded opt-in or release qualification job for authorized live cells with explicit pass/fail/skip outcomes. A skipped prerequisite is not acceptance. Record required/manual cells and retention rather than making every PR run shared runtimes. W7–W9, all milestones. |

#### Order, completion and preserved authority

RF10's read-only half was refreshed on 2026-09-20 with the installed 0.1.1
(`/Users/rschlae/.volta/tools/image/node/24.17.0/bin/devrouter`) against this
repository. It reproduced `global.capacity-ledger: error: Capacity ledger history
is unavailable for safe admission` whose `details` field carries only
`capacity-history-unprovable`, plus `global.network-capacity: warn ... Allocation
readiness: unknown` and the non-blocking `global.devsy-agent` warning. The bare
marker confirms RF10's complaint that a journal-enumeration failure is collapsed
into one cause with no location, so an operator cannot tell which history is
unreadable or which network evidence is missing. The diagnostic improvement and
any recovery remain open; no ledger, policy or runtime state was touched.

RF01–RF06 were merged as `abcc233` and released in 0.1.2 (PR #122, `6b57b0d`),
joined on the same branch by the RF13 journey-proof fix (`6d72964`), the RF10 diagnostics,
the RF07 cancellation/replay qualification (`7467786`), the capacity
content-digest fence (`697b5da`), the container-local death qualifier
(`bb72cb6`) and its durable lesson (`fb06f8a`), the Codex lifecycle-passthrough
fix (`097bdb7`), the non-shell qualification with the all-tools matcher
guidance (`40b23f0`) and the eight-cell qualification that adds two overlapping
calls per run (`72f14db`), the ten-cell qualification whose Claude-only
`nested` cell refuses a subagent's shell call (`ca2483b`) and whose `cancelled`
cell interrupts the CLI during its own hook's wait in both harnesses
(`fbfb5ca`, extended to the Codex CLI at `1af4680`) and whose `hook-timeout`
cell observes a harness that abandons the gate before it decides (`ff7efc4`,
guarded at source by the shipped-wiring timeout assertion) and whose `redirect`
cell refuses a settled call's own id re-delivered under a changed command in
both harnesses (`134a992`). Next work is the RF08/RF09 acceptance cell, which
needs an explicitly authorized installed platform, consumer, profile and two
environments. RF09's container-local OOM/SIGKILL, non-shell, overlap, nested,
cancellation, redirect and hook-timeout harness cells are now qualified, so what
remains there is Q20 host suspend and
a tool whose result depends on the live environment. RF10's operator recovery stays with the operator and the machine-policy
boundary, RF11 stays with the Klicker task owner (coordination sent 2026-09-20),
and RF12 extends whichever cell RF08/RF09 accept. RF13 now accompanies each
package with a retained summary.

PR #120's own CI fails intermittently at the same capacity-store assertion on
its main-based heads (`ce65d5c`, `14be44d`, `53c11df`, `a46eea7` at the time of
writing) because a docs-only branch carries no fence correction; the defect and
its fix lived on PR #121. Both were merged after the correction landed: #121 as
`abcc233` and #120 as `ae350f2`.

For each entry, record its disposition, implementing PR/revision, producing
command/run, artifact version, observed outcome and remaining limitations here.
Use `open`, `investigating`, `implemented`, `qualified`, or explicitly
`deferred/unsupported` with a reason and decision owner. A merge or passing unit
suite can establish implementation; it cannot establish live qualification.
Retain original failed first attempts in reliability measurements.

The terminal condition remains the approved roadmap outcome: applicable M1–M3
contracts implemented and qualified, safe ownership/resource/worker refusals
preserved, published and installed artifacts verified, and consumer status
supported by live evidence. A finite machine may legitimately refuse or wait;
the requirement is truthful state, bounded supported recovery and no routine
agent-written infrastructure repair, not a promise that every environment starts.

This update persists and reconciles work; it starts no implementation or runtime
action. Earlier scoped authority remains in force. New exact live fault targets,
enrollment, destructive cleanup, machine policy and consumer-owned changes retain
their existing boundaries. The docs-only update changes no executable contract
or knowledge concept; validation is docs policy, knowledge/link checks, staged
data hygiene and diff inspection.

#### Post-release corrections release and installation — 0.1.2 (2026-09-20)

The reviewed corrections were merged and released, so the installed artifact now
carries them:

- PR #121 (`fix(reliability): correct recovery guidance, diagnostics and the
  harness gate`) squashed to
  `abcc233b7e92088263fbb9dbdd6a96b95b2d6358`. PR #120, which first persisted
  these findings, squashed to
  `ae350f26d56033a023d1a0d7c9148147fda1be40`. PR #122
  (`chore(release): prepare 0.1.2`) squashed to
  `6b57b0d20739d0d5adde8a2547b54c3b0d551bb4`, bumping `package.json` and both
  example `.devrouter.yml` pins and adding the `[0.1.2]` changelog section with
  `upgrade-prompts/0.1.2.md`.
- Release [v0.1.2](https://github.com/rschlaefli/devrouter/releases/tag/v0.1.2)
  triggered [workflow 35522248020](https://github.com/rschlaefli/devrouter/actions/runs/35522248020):
  `check` passed in 2m23s and `publish` reported
  `Published package @devrouter/cli@0.1.2` in 17s at 16:20:13Z. The release
  PR's own CI was
  [run 35522090860](https://github.com/rschlaefli/devrouter/actions/runs/35522090860)
  on `f51a2fe`, whose tree equals the released `6b57b0d`.
- Validation at that revision: docs policy, knowledge, Biome, Knip, typecheck,
  the build, `scripts/package-smoke.sh` and the full suite (2704 tests in 148
  files) passed locally with a host process context.
- Registry: `@devrouter/cli@0.1.2` moved `latest` at about 16:27Z after the
  packument's five-minute edge TTL, with
  `dist.shasum = 0ebcb7bc9cbda9722f63881fa45b7eeeebe3d253` and
  `dist.integrity = sha512-wzcnxlOkhpgXOWhVw5PO8/0GmnpCgTpdE/zPPrncV2d0JDO/VmaIGRbp8ureTfRu7lGvt0jBqpHXwhlUbhmKTg==`.
  The published tarball's `dist/devrouter.js` is SHA-256
  `f4d0840b82a83cc9fc2d9b70593ea651094f89cba7010928208e43e553415dcd` and its
  `dist/devrouter-lifecycle-worker.js` is
  `d7d32993c23720d91b0901272c94bbe4e3af36370e459ad1340884cdc4c440b2`, equal to
  a local build of the released tree, so the published bundle is the reviewed
  source.
- Installs: `/opt/homebrew/bin/devrouter` and the Volta image copy at
  `~/.volta/tools/image/node/24.17.0/bin/devrouter` report 0.1.2, and the
  Volta package store this repository's Node 24.16.0 pin resolves was updated to
  0.1.2 as well; the installed Homebrew bundle hash matches the tarball.
- Live receipt on the installed 0.1.2 with a host process context:
  `global.cli-path` is `ok` with the running install at 0.1.2,
  `global.devsy-agent` stays a non-blocking `warn` at 1.19.0, and
  `global.capacity-ledger` now names the bounded cause and the exact entry —
  `capacity-history-unprovable; journal-entry-unsupported; at
  23fe529a30eb1b61c71ad42a1fac07b29848784a3fd9eb626643a5aaf789f0c9.stuck-stopping-20260914T1720.bak`
  — with the cause-keyed suggestion to move that unrecognised entry out of the
  private reliability journal directory while preserving its contents.

Dispositions after this release: RF01–RF07, RF10's source half and RF13 are
merged and released. RF10's operator recovery is named by the installed product
and awaits the operator's own file move. RF08's integrated canary still needs an
explicitly authorized installed platform, consumer, profile and two
environments; RF09 keeps Q20 host suspend and the live-environment tool open;
RF11 stays with the Klicker task owner, and RF12 now has its own measured
stopped-resume and fault-recovery cohorts while the RF08/RF09 cells remain the
place to qualify profile, host/container and browser/auth behavior. Merging,
releasing and installation were performed under the approved roadmap batch, and
no consumer workspace was touched.

## RF12 lifecycle-cohort measurement (2026-09-20, `1c42592`)

Status: **implemented and measured at source revision
`1c425924fd71aa764c9ab13e995ac5ca7d624d57`; the measured bundle hash
`f4d0840b82a83cc9fc2d9b70593ea651094f89cba7010928208e43e553415dcd` is the
published 0.1.2 bundle.**

`scripts/qualify-lifecycle-cohorts.ts` (`pnpm qualify:cohorts`) is the new
observation harness for RF12's stopped-resume and fault-recovery cohorts. The
fixture is one disposable devsy-managed checkout under
`$TMPDIR/devrouter-lifecycle-cohorts` with a one-service Compose devcontainer and
a repository adapter that appends a line to a log inside the container. Three
cohorts run in order on that one workload, so their numbers stay comparable:

1. `cold` — the first `ensure` creates the container and runs the adapter.
2. `stopped-resume` — a non-destructive `stop` retains the container and its
   data, and the next `ensure` starts the same retained container.
3. `fault-recovery` — a `SIGKILL` leaves the journal healthy while the container
   is dead, and the next `ensure` recovers the same container.

Each cohort records wall time, the streamed phase timeline, the peak resident
memory of the CLI process, the container's memory at readiness and its
first-attempt exit code. Container identity, retained data and the adapter
invocation count are read from Docker instead of trusted from devrouter's own
report. Exit 3 marks a missing prerequisite (Docker, devsy or a built bundle)
and is not a pass; the harness never retries.

The machine's real HOME is used on purpose, like an operator session, so the
real provider state and reliability journal are in play. The fixture path is
stable, so the three rounds reused one journal record
(`de920364b4c76e96af711e80d8d11ca5c322c352ff4c666bf9981f4eb164fa75.json`,
final revision 268), which survives the final delete and is printed with the
evidence.

| Cohort | min | median | max |
| --- | --- | --- | --- |
| Cold ensure (creates the container) | 9620ms | 11661ms | 20271ms |
| Non-destructive stop | 8058ms | 8547ms | 12378ms |
| Stopped-resume ensure | 9749ms | 12150ms | 13097ms |
| SIGKILL recovery ensure | 9747ms | 9943ms | 12391ms |
| Final delete | 8382ms | 8558ms | 11270ms |

Facts asserted in all three rounds:

- every cohort was a first-attempt exit 0; no run needed a retry
- peak resident memory of the CLI process stayed at 70–73 MiB
- container memory at readiness, as `docker stats` point samples: cold
  19.1–90.8 MiB, resume 16.7–160 MiB, recovery 17.1–17.6 MiB
- each ensure started the same retained container (`recreated:false`, container
  ID unchanged), without provider bootstrap or Compose creation
- the adapter log grew 1 → 2 → 3 invocations, and the marker file planted
  before the stop survived both the stop and the `SIGKILL`
- `docker kill` was observed as exit 137 with `OOMKilled false`
- the journal recorded `idle`/`stopped-by-user` after the stop and
  `stable`/`running` after each ensure
- the final delete removed the exact container; no container carrying the
  fixture mount survived

Phase timings come from the streamed events, which the CLI writes to stderr and
the harness timestamps on arrival. Devrouter's pre-provider work takes 2.3–3.5s
before the `provider` phase; the provider pipeline then dominates with
`injecting_agent` 1.2–4.3s and `running_lifecycle_hook` 0.9–2.9s, after which
`process-start`, `route-publication` and `readiness` complete within about
half a second. The resume cohort is not measurably cheaper than a cold start
(their medians differ by less than the observed spread), because the retained
container still runs the provider's full start pipeline.

Evidence-driven conclusion: the retained path already reuses the container and
its Compose project, this measurement justifies no product change, and any
future optimization needs the same workload measured before and after. The
recorded scoped alternative is three rounds per cohort instead of the roadmap
default of twenty, because every round stops, kills and recreates a real
devcontainer; the fixture is deterministic in its assertions and the observed
spread is reported above. Still open in RF12: profile changes,
host/container alternation and browser/auth behavior in the selected cells.
Preparation reuse is measured below, together with the stop-recovery defect
that harness exposed.

### Preparation reuse and pruned-population stop (2026-09-20, `c258ae0`)

Status: **measured at source revision
`c258ae0c2f2dce30ee93150b1303f2695fc4a1cb` with `dirty: false`; the measured
bundle hash
`539b79fb0647b3efeaeac55c503160e6e8825aeac055521aca0bd333f81bf475` is the same
bundle that released the two stuck journals recorded below.**

`scripts/qualify-process-preparation.ts` (`pnpm qualify:preparation`) measures
repository-owned process preparation in a routed consumer. Its fixture is one
disposable primary managed checkout under
`$TMPDIR/devrouter-process-preparation/consumer` whose repository adapter passes
`--prepare-command` to `devrouter-process ensure`; one retained container
(`81e84d260782bf48f4ad2daa52a6f0f66b7acf269b0f99c5be24b6f37068924a`) carries all
cohorts, and the published route is fetched over the machine's real TLS setup.

| Run | wall | preparations | adapter | facts |
| --- | --- | --- | --- | --- |
| Cold ensure | 36124ms | 1 | 1/1, 3063ms | created the container, route probe ok |
| Unchanged reuse | 23028ms | 1 | 2/2, 12ms | same PID 206, preparation skipped |
| Changed runtime | 28128ms | 2 | 3/3, 2053ms | new PID 721, generation 2, route ok |
| Non-destructive stop | 35120ms | - | - | retained the exited container, journal `idle`/`stopped-by-user` |
| Stopped resume | 25080ms | 3 | 4/4, 3063ms | same container, new PID 194, route ok |
| Unknown-ownership refusal | 17256ms | 3 | 6 starts / 4 completions | exit 1, two refused attempts, no preparation, PID 194 and route intact |
| Stop-then-ensure recovery | 19988ms | 4 | 7/5, 2047ms | new PID 101, route ok |
| Pruned-population stop | 10964ms | - | - | container removed externally; stop settled `idle`/`stopped-by-user` at revision 692 |

Facts asserted in the green run: every accepted run was a first-attempt exit 0;
peak CLI resident memory stayed at 73.4-74.9 MiB; container memory at readiness
ranged from 32.7 to 152.4 MiB; preparations advanced 1, 1, 2, 3, 3, 4 across the
cold, reuse, changed-runtime, resume, refusal and recovery runs; the helper
record's PID changed only when the runtime identity changed; the refusal wrote
two adapter start lines and no completion line; and the final delete removed the
exact container and route. The receipt is
`$TMPDIR/devrouter-process-preparation/evidence.json`, with the earlier
stuck-journal run preserved at
`/private/tmp/devrouter-preparation-receipts/2026-09-20-stuck-journal-release-and-refusal-count.json`.

Evidence-driven conclusion: preparation reuse works and is measurable. An
unchanged adapter identity reuses the owned process with a 12ms adapter replay
and no preparation; a changed adapter identity stops the owned group, prepares
again and launches the new generation; a stopped container resumes and prepares
again because no owned process survived. The refusal is fail-closed: the adapter
is attempted (and replayed once by the managed rollback) without completing,
preparing, killing or duplicating anything. The pruned-population run shows the
repaired primary stop branch settling a stop whose container was removed
externally.

## Primary managed stop recovery for absent registrations (2026-09-20, `a906070`)

Status: **source fix and regressions committed, verified live on two stuck
journals and on the clean measurement revision `c258ae0`; merge, release and
installation are separate authorised steps.**

The consumer symptom was an environment stuck in `stopping` after ensure failed
before creating a Devsy registration: journal settlement answered
`already-settled`/`COMPLETED` while `stop` demanded a registration that no longer
existed and every later ensure was blocked. The RF12 preparation harness
reproduced that symptom on a primary managed checkout in two shapes:

1. Prune: ensure succeeded, an external prune removed the fixture container while
   the Devsy registration survived, and `devrouter stop` refused with `Retained
   container population or immutable identity changed.` The journal stayed at
   `desired: stopped-by-user, phase: stopping, stopProof: {workloadsStopped:
   false, routesRemoved: false}`, and `workspace journal settle` reported
   `already-settled`.
2. Guard-ordered delete: `devrouter stop --delete` deleted the Devsy registration
   and the containers and then threw `Absent stop requires a linked workspace.`
   during settlement, leaving the same `stopping` phase and the same blocked
   ensure.

Root cause: the absent-registration proof and the unchanged-registration prune
branch both required a ledger-owned linked checkout. A primary checkout has no
ownership ledger, so it could never settle a stop whose registration was already
gone, even though its retained stop baseline recorded the exact provider identity
it owned.

Fix `a906070` gives the absent proof a discriminated identity: a linked checkout
keeps proving its ownership record, worktree path, Git ownership and Git common
directory, while a primary checkout proves the same thing through the retained
generation's own checkout path and provider ID. An inconsistent pair (linked
without a retained workspace, or primary with one) throws `Absent stop requires
the exact workspace identity.` instead of choosing a proof. This removes the
linked-only gate from the prune branch, which already re-checks registration
identity, endpoint, daemon, provider selection and absent populations. Every
fail-closed check survives: both provider registries must stay readable and clear
of the exact ID and path, saved container IDs must be positively absent, project,
directory and provider-runner populations must be empty across two stable
observations, the retained generation must be unchanged, and no provider or
container mutation is reported for a proven-absent stop.

Live recovery receipts, both released by the measured bundle
(`539b79fb0647b3efeaeac55c503160e6e8825aeac055521aca0bd333f81bf475`):

- `$TMPDIR/devrouter-process-preparation/consumer` (journal
  `790366b9ceb5608598e295753592fe2befab393ed4091a6fe7670be360073c71.json`), a
  primary checkout whose registration and container were already gone and whose
  journal was stuck in `stopping`: the rebuilt CLI reconciled it with
  `{"kind": "primary", "stopped": false, "deleted": true, "freedRoutes": 0}` at
  exit 0.
- `$TMPDIR/devrouter-process-preparation/consumer-prune` (journal
  `7640fc8089682278a67f31f8366aaa5ef97ed1f935ab1677cec64db6bd665d93.json`), a
  primary checkout with a retained pruning baseline, a surviving registration and
  a removed container: `devrouter stop <path> --json` returned exit 0 with
  `{"kind": "primary", "stopped": false, "freedRoutes": 1}`, and the journal moved
  to `phase: idle` with `stopProof: {workloadsStopped: true, routesRemoved: true}`
  at revision 31.

Regression cover: `src/core/__tests__/managed-stop-recovery.test.ts` (80 tests,
including the proven primary checkout, a competing registration, and both
inconsistent linked/primary identities) and the `qualify:preparation`
`pruned-population stop` cohort, which removes the container externally and
asserts exit 0, a settled journal and a freed route. Remaining: land the fix
through the normal draft-PR, review, merge and release path, and have the Klicker
consumer re-run its own reproducer on a build that carries it. No consumer
workspace was touched.

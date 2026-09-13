# Stop retained environments after configuration changes — PR #65

## Approval summary

Managed environments must remain stoppable after their repository configuration
changes or application startup fails. Today the Devsy stop path reconstructs
ownership from current configuration, so an edit can strand an otherwise owned
runtime. This package records independently validated stop ownership during
infrastructure preparation and uses that evidence for non-destructive shutdown.

The existing roadmap authorizes implementation, checks, ordinary branch delivery,
and isolated fixtures plus eLearning qualification. No renewed proceed is needed.
The terminal condition is a reviewed, CI-green draft PR with retained-data and
stop/resume evidence. This package does not publish a release, change machine
policy, restart the shared VM, delete data, or mutate another task's runtime.

A valid record must identify the exact provider, Docker daemon and complete
container population. Stop revalidates that record, stops only the proven IDs,
and reports completion only after cessation and route removal are proven. This
does not authorize adopting replacement containers from labels alone. Existing
records without the new evidence retain the strict legacy path; corrupt records
never fall back. Recovering a legacy incident may still require equivalent
historical ownership evidence. No complete autonomous recovery or OOM protection
claim is part of this package.

## Execution details

### Context and evidence

Owner: main. Tier: full path. Target: main, resolved from origin/HEAD.
Baseline: 9be6df2d0abd797017a39d657e1aaa319d062e00 (release 0.0.60).
Branch: rs/config-drift-stop-recovery.
Worktree: /Users/rschlae/Git/personal/devrouter/trees/rs/config-drift-stop-recovery.
The branch is independent of the capacity implementation. Reuse its investigation,
not unmerged assumptions about APIs or locking.

The released `managed-devsy-stop.ts` loads mutable configuration before inspecting
containers. `managed-runtime-state.ts` reconstructs records and must explicitly
validate and preserve new fields. Ordinary ensure holds the workspace lock but
does not hold the provider lock throughout final capture. Current state persistence
occurs after application readiness; the complete service/preflight boundary is
earlier. Canonical final cessation proof must consume the retained evidence too.

### Binding implementation contract

Add an optional, bounded, versioned stop baseline to the retained runtime record.
It contains only allowlisted ownership metadata: exact provider context, ID and
UID/source identity; pinned Docker endpoint and daemon identity; project and
primary service; independent required and allowed service sets; ordered Compose
path identities and provider provenance; exact container IDs and immutable label
and mount identities. Bind it to the corresponding runtime/configuration generation.
Never store arbitrary labels, environment, command output or configuration contents.

Capture after complete independent population proof and before application
readiness. Acquire the existing provider lock while already holding the workspace
lock; repair paths must not acquire it recursively. Revalidate registration,
daemon and population, then persist atomically. This records ownership without
claiming application readiness: use the appropriate degraded transition state and
carry the same baseline into the later ready state. A persistence failure cannot
report ready or successful capture. Partial startup retains a prior baseline only
while that exact generation and population still match. Otherwise retain uncertainty.

The baseline stop path must not load current repository configuration or resolve
deleted Compose/generated files. Compare recorded paths and immutable identities
against live metadata. Preserve canonical journal ownership, stop intent, worker
drainage, lifecycle fences and lock order. Missing linked-worktree identity is not
permission to claim a fresh identity for recovery. Provider conflict, unavailable
evidence, or a changed provider remains an error, not a default-provider fallback.

Use the pinned endpoint for every Docker enumeration, inspection, stop and final
verification. Revalidate daemon identity and the complete frozen population before
each effect; claim each effect through the existing lifecycle fence. Stop exact
container IDs without invoking configuration-dependent provider Compose stop.
Keep the legacy helper's behavior unchanged for other callers.

Carry proof through route removal and final lifecycle settlement. Revalidate
registry, daemon, immutable identities and complete membership before recording
successful cessation. Added, missing, replaced or foreign containers prevent a
successful stop proof, even if some owned containers have already stopped. Locks
serialize cooperating operations; they do not exclude external Docker changes.

An absent baseline uses legacy behavior. A present invalid or unsupported baseline
rejects before mutation. Never derive the allowed service set from the same labels
being checked, forge a migration from changed configuration, or transfer ownership
to a new project merely because the former one is empty.

### Ownership and sequence

| Workstream | Owner | Acceptance |
| --- | --- | --- |
| Contract and transition design | Main, with native planner | Approved frozen plan and explicit failure boundaries |
| Baseline capture and canonical stop implementation | Native executor Gauss | Consequential state, ensure, stop and lifecycle tests |
| Simplification and ownership/lifecycle review | Independent specialists | Findings verified and addressed on the committed slice |
| Integration and qualification | Main | Repository checks, isolated retained-data fault proof, eLearning stop/resume and zero routes |
| Integrated final review and draft delivery | Independent final reviewer; main publishes | Reviewed complete package and required green CI |

Executor owns the implementation slice after plan commit. Intended files are
managed runtime state, workspace ensure, sanitized Devsy registry, managed stop,
targeted Docker helpers, final lifecycle proof and their focused tests. Main owns
cross-system decisions, review disposition, runtime actions and external delivery.
No child delegates or mutates a consumer runtime.

### Verification

Start with managed-runtime-state, managed-devsy-stop and workspace-ensure tests.
Then exercise environment-stop, devsy-mutation and reliability-lifecycle entry and
settlement. Use minimal synthetic fixtures that assert behavior and authority.

Required cases: primary and linked checkouts; changed, malformed or deleted
repository/generated configuration; application failure after infrastructure proof;
repeated stop; absent and corrupt baseline; persistence failure; provider or daemon
drift; duplicate, missing or foreign members; changed IDs or membership during stop;
partial cessation; stop intent racing startup. No successful proof may follow an
incomplete population or substituted defaults.

Run affected repository checks, package build and packed CLI qualification. Use an
isolated fixture to demonstrate data retention through configuration drift and
stop/resume before applying the candidate to the exact eLearning canary. Read the
runtime lifecycle skill before these actions. Retain volumes and finish every
touched runtime stopped with zero exact routes. Do not induce host OOM or restart
the shared VM. Record source versus installed/runtime evidence separately.

### Progress and review

2026-09-08: native planner Ampere reviewed frozen v1 and requested five corrections:
explicit provider-lock capture, pre-application ownership persistence, pinned Docker
endpoint, baseline-backed final cessation proof, and strict/deletion-independent
baseline validation. Main accepted all five. Frozen v2 includes them and primary,
linked, repeated-stop and application-failure coverage. Planner verdict: APPROVED.
The public-source advisor completed with DONE_WITH_CONCERNS after its initial
missing-context response. Main accepts the exact-ID/daemon, pre-readiness capture,
complete membership and stop-first constraints, already present in this contract.
Main rejects replacing updatedAt with a new fencing system: the existing journal
already supplies monotonic fences and effect claims. Automatic cleanup after a
persistence failure would require a separately proven target set and is not added.
Legacy records keep their existing verified stop path, rather than becoming
unmanaged. Creation/image metadata is not a substitute for the pinned daemon and
immutable full container IDs. The advisor saw only two verified public release
source files; it did not review private runtime state or the complete implementation.

The executor completed the bounded seam map. Initial host tests pass 182 cases in
five suites; the environment-stop suite could not load jsonc-parser from the older
primary checkout's dependencies. Install the task's frozen lockfile before using
that suite as baseline evidence. No implementation or runtime mutation has occurred
in this worktree yet.

The isolated frozen-lockfile install completed; an optional cpu-features native
build failed on host Node 26.8.1, but installation exited successfully. All 194
baseline tests across the six affected suites subsequently passed. Baseline log:
`/private/tmp/devrouter-config-drift-baseline-tests-installed.log`.

Implementation is in progress with the same executor. Main owns the separate
`scripts/qualify-config-drift-stop.ts` runner and its package script. It uses an
isolated copy of the existing example, bounded container memory, temporary
configuration renames, a named-volume marker and canonical ensure/stop/exec.
It restores configuration for cleanup and retains the fixture and volumes.
Qualification failure cannot become a pass merely because cleanup succeeds.
Typecheck, script formatting, unused-code checks and diff whitespace checks pass;
the live runner has not executed. Do not treat this as runtime qualification.
No application runtime was started or changed during this implementation checkpoint.

Main independently ran the current seven affected suites: 221 tests passed,
including 27 retained-stop recovery cases. The producing log is
`/private/tmp/devrouter-stop-recovery-current-tests.log`. These tests establish
the tested synthetic ownership and cessation behavior; they do not yet prove
the complete startup-to-stop path with a real provider. The executor remains
responsible for completing capture and lifecycle seam coverage.

Main corrected the qualification runner so a configuration-restoration error
does not skip the exact runtime stop attempt. Repeated cleanup stops now each
require a structured stopped result. Formatting, typecheck and diff whitespace
checks passed after this change. Live qualification remains pending.

The executor returned with the implementation and focused seam tests complete,
but identified a compatibility defect: capture unconditionally rejects non-Unix
Docker transports. Main has not accepted that limitation as the final contract.
The configured Claude CLI advisor is examining the connection identity boundary
before correction and integration. No runtime qualification or review gate has
passed for this implementation yet.

Main's complete host test run passed all 1,243 tests in 91 suites with two workers:
`/private/tmp/devrouter-stop-recovery-full-tests-host.log`. The preceding sandbox
run failed process-identity lock checks; those failures did not reproduce outside
the sandbox. This evidence does not qualify non-Unix connection compatibility.

The transport advisor returned DONE_WITH_CONCERNS. Main accepts preserving
legacy startup on recognized non-Unix transports with an explicit capability
notice. New baseline recovery in this slice requires a local Unix Docker endpoint;
other transports remain an explicit roadmap gap. Unknown or malformed connection
evidence must not silently become fallback, and a present baseline never falls back.
This host resolves to the OrbStack Unix socket. The executor owns one focused
compatibility correction pass. The advisor's claimed Docker environment precedence
is unverified and is not adopted.

### Incoming consumer incidents

The Klicker KB/KG/Generation owner reported exec failing before child launch.
Read-only metadata proves journal revision 1232 has 128 history entries, no worker,
stable running intent, and a completed, drained latest exec. The released handler
rejects requests at that exact history bound. The separate
[manual history rollover fix](https://github.com/rschlaefli/devrouter/pull/64)
has a passing required check and remains open. Main returned the diagnosis; no
consumer runtime, data, journal or lease was changed. Delivery of that fix is
independent of configuration-drift stop recovery.

The user merged the history fix at 7d2fcba38a716afce54a67d9a861fa5b2850e6a3.
Main verified identical source trees, rebuilt the history worktree CLI and passed
package smoke. A read-only in-memory transition against the affected journal
accepted the next operation, advanced its fence and preserved uncertain history.
The consumer owner then reported canonical exec of `true` exiting zero with no
runtime restart or journal edits. Preserve that history worktree's built CLI and
sibling artifacts while its container checks use them. The global CLI is unchanged.

Process-helper tests skip on this macOS host because Linux /proc is unavailable;
the Linux-specific checks remain a CI requirement, not a local passing claim.

The AI Infra Portfolio coordinator supplied Office verification evidence. Its
execution owner retains custody; this task performs no Office runtime or source
changes. Sandbox process-identity failure cleared with host escalation. A retained
workspace occupied the default Azurite port. Applying an alternate port coincided
with container replacement; Compose reconciliation is a hypothesis pending the
internal decision trace. An intentional stop during preparation preceded unknown
worker completion; a later accepted-baseline startup and full build passed.
The container check command includes a host-only installed-CLI profile-plan test,
so its split execution remains with the Office owner.

Remaining roadmap obligations from Office: expose proposed container replacement
before mutation, isolate host ports, distinguish intentional cancellation from
unexplained completion loss without inventing command certainty, and route host-only
checks explicitly. No fix or live acceptance is claimed for these obligations.

### Integrated qualification

Implementation commit 33601b0 is integrated with the user-merged history fix at
29aefd85059287509d452134a0d7b86830768fdf. Integration avoids qualifying against the
known exhausted-history defect; the 67 affected model/lifecycle tests pass.
Transport correction passed independent focused tests, typecheck, Biome, Knip,
documentation checks and commit hooks. Simplifier Bohr found no justified net
reductions. Slice risk reviewer Halley remains active
(`01a0826d-dace-7fd3-9e8e-d1aae279d012`); final review remains pending.

The packed candidate passed the isolated real-Devsy qualifier. Exact fixture:
`/var/folders/24/j7k2mlqn42l_dhq64jpqslxh0000gp/T/devrouter-stop-drift-wopc0x`.
It stopped after repository/generated configuration was renamed away, resumed
with the named-volume marker intact, then passed repeated canonical stop and
provider Stopped/zero-route checks. The producer exited zero and its receipt
sets configurationDriftStop, retainedData, finalStopped and passed to true.
Receipt: the fixture's `qualification.json`; command log:
`/private/tmp/devrouter-stop-live-qualification.log`. Readback also confirms idle,
stopped-by-user, no worker, and both cessation and route-removal proofs.
The fixture and volumes are retained; no deletion is authorized or performed.
This qualifies the isolated Unix-endpoint case, not eLearning or autonomous recovery.

eLearning qualification subsequently passed against its retained source baseline
ad71415e7b7441dcc4013c8ce89c75acaf386728 (eight commits ahead and 44 behind current
main; no source integration attempted). Startup and warm ensure reported no
recreation, retained synthetic records verified before and after stop/resume,
and final exact provider status is Stopped with zero canary routes. Receipts:
`/private/tmp/devrouter-stop-elearning-29aefd/`. No records were seeded or reset.
The canary's existing memory limits remained in place. Browser acceptance from
the earlier release is not claimed as newly rerun here.

The packed synthetic lifecycle qualifier also exited zero with its scenario
receipt in `/private/tmp/devrouter-stop-integrated-lifecycle-qualification.log`.
Halley's risk review found one consequential test gap: stop-dispatch must reject
a linked checkout without persisted identity before allocation or worker launch.
Main added that case and verified all 16 lifecycle-supervision tests and typecheck.
No production code changed for this review correction. Final review remains pending.

Final integrated unit verification passes 1,277 tests in 91 suites with two
workers outside the sandbox. Typecheck, Biome, Knip, docs policy, knowledge and
diff checks pass. The unchanged packed executable digest matches the live fixture
and synthetic qualifier receipts despite documentation/test-only follow-up edits.


### Source-less tmpfs compatibility correction

While final review of a22eb1d remained running, main reproduced a baseline
capture failure for a source-less tmpfs mount. The pinned Devsy source supports
such mounts, while the new validator required an absolute source for every mount.
A focused regression failed at that validator before any stop effect.

The correction accepts an empty source only when the mount type is tmpfs.
Bind and volume mounts retain absolute-source validation. The capture/readback/
exact-stop regression and negative bind/volume cases pass; all 74 affected
recovery and Docker-inspection tests pass, along with typecheck and Biome.
Main owns this bounded correction because it is coupled to final integration.
The current reviewer examines the prior immutable range; this change must be
included in its correction pass before delivery. Earlier live evidence still
covers its original inputs, but does not prove tmpfs behavior in a real runtime.


The tmpfs correction passed rebuilt package smoke and real isolated Devsy
qualification using the packed candidate from 973cf4d. The qualifier now mounts
16 MiB of tmpfs and verifies its filesystem type through canonical exec before
configuration-drift stop and retained-volume resume. Producing run exited zero.
Receipt: `/var/folders/24/j7k2mlqn42l_dhq64jpqslxh0000gp/T/devrouter-stop-drift-XyI4Tu/qualification.json`.
Its tmpfsMount, configurationDriftStop, retainedData, finalStopped and passed
fields are true. CLI SHA256 is
145bf9fe7f79a71f0197e30689cddac1285ef36b77f49783f725fd622a6834ef.
Final cleanup performs repeated exact stops and checks provider Stopped and zero
fixture routes. The fixture and its volumes remain retained; eLearning and other
tasks' runtimes were not touched. Final review of the prior range remains live;
the correction and qualifier update require its follow-up review before delivery.


### Final review disposition

Claude final review completed with findings on 7d2fcba..a22eb1d. Main owns one
integrated correction pass. The tmpfs finding is closed by 973cf4d and the packed
live receipt committed with 86f0f8b. The remaining accepted findings are provider
lock progress, locale-dependent mount ordering, and missing ensure capture-failure
coverage. Reuse the existing provider lock helpers with their throttled wait
reporter; normalize both retained and observed mounts with code-unit ordering.
Remove the duplicate stop test whose transport environment variables did not
exercise a transport decision; the ensure transport seam retains that coverage.

Main keeps the approved ownership boundary on capture failure: unsupported known
transport is a capability limitation, whereas failed population proof is unknown
ownership. Do not silently downgrade the latter to legacy operation, adopt
leftover/foreign containers, or delete them. Startup must remain unverified until
that identity is resolved. This follows the binding contract requiring complete
proof before application readiness; it does not introduce a new mutation policy.
An ensure-context error preserves the underlying diagnostic, manuals disclose
the precondition, and a regression asserts no selected-application launch or
ready-state publication after capture rejection. Automatic reconciliation of
ambiguous project members remains outside this package's ownership authority.

The advisory request to prove registration and daemon identity only once is
rejected: the approved contract explicitly requires revalidation before each
effect and final settlement. Cooperating locks cannot exclude external Docker
changes. The full rechecks and existing changed-population tests remain.


Review corrections pass all 1,281 unit tests in 91 suites, including 204 focused
lifecycle/recovery tests. Typecheck, Biome, Knip, documentation policy, knowledge
and diff checks pass. Rebuilt package smoke passes. The lifecycle fixture now
partially mocks router constants because reuse of the existing provider helper
loads its ordinary configuration dependencies; no production test hook was added.
The final correction pass must review the complete integrated range and the new
provider-helper import boundary. Earlier real-provider receipts remain evidence
for their named builds, not fresh live proof of this correction build.


### Corrected packed CLI live qualification

The packed ee2d842 executable passed the real isolated Devsy qualifier after the
lock-helper and locale-ordering corrections. Producing run exited zero; receipt
`/var/folders/24/j7k2mlqn42l_dhq64jpqslxh0000gp/T/devrouter-stop-drift-kS1fpz/qualification.json`
reports tmpfsMount, configurationDriftStop, retainedData, finalStopped and passed
all true. CLI SHA256:
1ca7b311225cb00cdabef9ffcd730c2c12de273aa87556239f8593649f1b7731.
The qualifier verifies the real tmpfs type, canonical stop after configuration
removal, retained-volume data after resume, repeated final exact stop, Devsy
Stopped, and zero fixture routes. The fixture and data are retained. No eLearning
or other task runtime was changed. The single follow-up final review remains
running against the immutable ee2d842 range; this entry changes evidence only.


### Final review closure

The configured Claude correction pass completed DONE_WITH_CONCERNS with an
explicit ready-for-draft verdict and no blocking defects. All six initial
findings are closed through corrections or the documented contract dispositions.
Its three low-severity follow-ups are dispositioned as follows:

- Fresh live evidence: already closed by the ee2d842 packed qualifier and receipt
  above, committed in 0167f56 after the review's immutable snapshot.
- Test isolation: narrow the lifecycle fixture's router mock to its temporary
  DEVROUTER_HOME and the immutable TCP protocol registry; derived real-home paths
  remain unavailable rather than being silently inherited. Recheck this suite.
- Operator diagnostics: retain as follow-up work. Population-proof errors should
  identify the offending service/container and explain an ownership-preserving
  inspection path. Do not adopt the suggested blanket removal remedy: data or
  container deletion still requires exact separate approval. This does not block
  the reviewed package and does not claim automatic orphan reconciliation.

Draft PR #65 is published: https://github.com/rschlaefli/devrouter/pull/65 .
Required Linux CI remains pending. The production range remains
ee2d842; subsequent changes are evidence and test-isolation metadata only.

# Stop retained environments after configuration changes

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

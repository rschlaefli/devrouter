# ADR 0008: Model reliability before runtime activation

Status: accepted for the source contract and manual lifecycle integration; capacity-managed activation remains proposed.

Devrouter represents desired intent, observed readiness, admission, consumers,
operation completion, and incident budgets independently. A pure transition
function accepts explicit time and fenced events and returns effect requests.
It performs no provider, filesystem, process, or router operations. Consumer
summaries are derived from current required capabilities and observation freshness.

Environment identity, intent revision, runtime generation, and controller epoch
fence every event. Explicit stop supersedes attachment.
Observation timestamps must also meet the current generation's time floor, so
relabeling old evidence with a current fence cannot restore readiness.
Parking requires positive workload and route stop evidence before releasing capacity. Missing evidence
retains the charge. Persistence acknowledgement must precede a launch request;
a possibly dispatched operation without authoritative completion is never replayed.
Incident budgets survive runtime and controller changes.

This contract makes lifecycle races executable before adapters acquire mutation
authority. Manual CLI adapters consume the version-2 extension below. Resource accounting
and live recovery require separate qualification; model tests cannot establish
these properties.
Machine enrollment, automatic recovery, and operational thresholds require later
decisions and qualification. A single combined status would hide uncertainty,
while activating a controller now would give an unqualified model live effects.

## Manual lifecycle integration extension

Contract version 2 distinguishes immutable manual execution authority from
capacity-managed admission. Manual commands do not claim measured capacity or a
host reservation; their capacity projection is unmanaged. Existing admission,
parking, and automatic-recovery gates remain exclusive to capacity-managed state.
Unknown contract versions are rejected rather than silently migrated.

An environment can outlive several ensure or exec operations. Each manual
operation therefore has its own request identity and bounded completion record.
Reusing an identity reports the original operation without replay. A different
operation requires definite completion and worker drainage, or an explicit stop
with full cessation proof. A new ensure may reconcile a drained interrupted or never-dispatched ensure
while preserving its unknown historical result. Unknown arbitrary exec never gains
that exception. Exhausted history fails closed. This preserves the
difference between application completion and a worker that can still mutate.

An initial exec may adopt positive evidence of an existing runtime while creating
its first manual record. It never starts that runtime or overrides recorded stop
intent. Runtime adapters, installed qualification, and real-provider proof remain
separate obligations; this extension alone does not activate runtime integration.

The manual CLI journals bounded dispatch and worker incarnation under the existing
Devrouter home. Its worker owns lifecycle serialization and claims provider and
route effects against the current intent immediately before mutation. Stop intent
precedes waiting; preexisting claims remain potentially in flight until exact
worker drainage and runtime cessation are proven. Typed execution results retain
transport metadata separately, without persisting arguments, output, or environment.
Installed synthetic tests cover production adapters but do not qualify real-provider
fault recovery or capacity-managed behavior.

Within explicit start intent, ordinary ensure repairs a retained degraded profile
before applying the desired profile. This reuses exact ownership checks and locks;
it never turns missing evidence into authority to adopt or destroy resources.
A repair failure ends that bounded attempt with retained diagnostics. Stop fences
both repair and subsequent transition. This behavior removes a separate repair
command requirement without activating the capacity-managed controller.

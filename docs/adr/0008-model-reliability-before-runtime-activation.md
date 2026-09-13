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
that exception. At the history bound, manual admission may retire only the oldest
completed or not-launched, drained, noncurrent record. Retirement, advancement of
the intent fence, and admission occur atomically. Uncertain records remain retained;
if no record qualifies, admission remains blocked. Capacity-managed history remains
fail-closed because its request identities are externally retryable. This preserves
the difference between application completion and a worker that can still mutate.

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

## Foreground observation extension

The observation controller has a separate store identity, incarnation epoch and
consumer generation. These never replace the manual journal's environment,
intent, runtime or controller fences. Restart discards active observer bindings;
only explicit acquisition and renewal authorize a consumer session. Session
release and expiry have no runtime effect. Existing manual commands remain
independent of observer availability.

The foreground controller owns one private Unix socket and bounded active-reference
snapshot under the existing Devrouter home. It does not install a service, start
itself from a client request, claim repository ownership, or become a global
repository registry. Persistence precedes acknowledgement and event delivery.
Lost continuity, stale observations and unavailable evidence yield UNKNOWN.

Compatible consumers share bounded read-only probe batches. Runtime and process
revalidation runs outside the manual journal lock. Publication is serialized,
then rereads bounded persisted ownership/configuration and the exact manual
revision while holding that journal lock. It durably commits observer projections
before releasing the lock and delivers events afterward. Manual stop therefore
wins against stale publication; external runtime changes after sampling remain
subject to the next observation and freshness bound.

Configuration fingerprints use an incarnation-local random HMAC key. This binds
observations to configuration bytes without retaining a public low-entropy hash
of secret-bearing values. Neither the key nor raw configuration enters the
snapshot. Runtime output is transient and failures expose fixed classifications.

A timeout cancels only the observer-owned probe group. A batch whose probe has
not drained retains its concurrency slot. Continuous recovery, capacity admission,
service-manager enrollment and agent continuation remain separately qualified
roadmap packages; observation grants none of their mutation authority.

## Declared host-budget admission

The source contract accepts an explicit `macos-declared-v1` host policy with a
required `unmanagedAllowanceBytes`. This is a reviewed allowance for non-pool
workloads, not a measurement of current host occupancy. The host charge combines
that allowance, each retained VM pool's full declared growth budget once, and
environment reservations for additional host-only work. Guest container memory
and VM overhead already included in the pool budget must not be added again.
Runtime-domain accounting remains independent. Existing estimates need review
against these categories before activation.

Host capacity may not exceed observed physical memory. Fresh normal pressure is
also required; collection-start timestamps prevent delayed samples from obtaining
a new freshness window. Neither normal pressure nor a declared growth budget proves
an enforced physical VM ceiling. Unmanaged growth, underestimated overhead and
delayed pressure can still exhaust memory. This contract does not claim complete
OOM protection.

Legacy `macos-host-v1` policies remain readable but cannot acquire declared-budget
semantics implicitly. Production activation must reject that adapter before
reconciling journals. Stopping an environment does not release a retained VM pool;
only exact fenced pool-cessation proof permits that release. Numeric machine
policy and live activation remain separately reviewed actions. Host mapping alone
does not qualify production guest accounting or canonical command integration.

The policy schema also validates controller scheduling knobs
(`clientWaitSeconds`, `maxClientWaitSeconds`, `watchSeconds`,
`sampleIntervalSeconds`) that are reserved for future runtime binding. Runtime
constants remain authoritative until a reviewed change binds them at their use
sites.

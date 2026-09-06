# ADR 0008: Model reliability before runtime activation

Status: accepted for the source contract; runtime activation remains proposed.

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
authority. Existing CLI behavior and outputs do not consume it yet. Future
adapters must prove durable dispatch ordering, ownership, resource accounting,
and live recovery independently; model tests cannot establish these properties.
Machine enrollment, automatic recovery, and operational thresholds require later
decisions and qualification. A single combined status would hide uncertainty,
while activating a controller now would give an unqualified model live effects.

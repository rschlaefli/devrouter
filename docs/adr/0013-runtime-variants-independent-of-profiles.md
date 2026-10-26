# ADR 0013: Keep runtime variants independent of profile resource selection

Status: Accepted

Context: A managed checkout may need the same Compose services and repository
processes with a different application startup input. Profiles already select
resource dimensions: apps, dependencies, managed services, and managed process
markers. Reusing a profile for startup mode would change that resource set.

Decision: `managedRuntime.variants` declares additional runtime startup inputs.
`default` is implicit and reserved. `devrouter ensure` and `devrouter workspace
ensure` accept `--variant <name>`; an ordinary ensure selects `default` without
making the choice sticky. `--repair` retains the recorded variant.

Variants and profile resources remain independent. A same-variant profile change
may drop a failed process directly, while a retained degraded profile and
variant are repaired before a requested variant change. A non-default variant
requires a managed post-start adapter and participates in managed process
identity even when the adapter supplies an explicit fingerprint or replaces the
environment allowlist.

Non-default variants are manual-only until capacity admission can model them.
Capacity-targeted, enrolled, and retained capacity-managed checkouts refuse them
before journal intent, controller admission, preparation, provider mutation, or
route effects. Controller enrollment and resume must not reinterpret retained
non-default state as `default`.

Why: A separate selector keeps resource selection and process startup changes
under separate contracts. Reusing profiles would make a startup-only change
require a duplicate resource selection and could silently alter services or
processes. A repository marker file would create another per-checkout lifecycle
state in the wrong owner and could be stale or ambiguous across commands. The
cost is one more declared selector and command input. Capacity estimates do not
yet include variant-specific demand, so those checkouts stay on the manual path
until the admission model can account for them.

# ADR 0015: Require explicit stopped-generation authority for app replacement

Status: Accepted for the source contract; live qualification and release remain gated.

Context: Managed ensure deliberately avoids legacy automatic recreation. A
retained environment may need its application container replaced while named
storage and dependency identities survive. Provider recreation discards the
primary writable layer and removes anonymous volumes. A lost worker or rolling
journal cannot make a second destructive dispatch safe.

Decision: Extend the existing ensure request with explicit `--replace-app` after
canonical stopped-generation proof. Initially qualify manual managed Compose on
Devsy 1.24.0, unchanged committed configuration and preserving repository hooks.
Reject anonymous or unattributed primary mounts and daemon-wide reverse network,
PID and IPC namespace consumers. Revalidate under the existing provider lock.
Preserve dependency container IDs, named volumes and bind identities.

The existing operation store owns one fenced durable attempt per exact checkout
outside its strictly enumerated journal directory. Bind stopped generation,
old primary, frozen preflight, operation and worker before dispatch. Failure,
unknown completion, canonical stop and new request IDs never rearm it. Persist
the existing degraded-state barrier before dispatch. Require a retained
non-primary dependency so a released client cannot interpret the temporary
absence of the primary as an absent Compose project and create it again.
Capture the proved replacement stop baseline before application checks.

Why: Explicit intent preserves ordinary ensure behavior and user control over
writable-layer loss. Existing workers, journal locks and provider serialization
already own lifecycle effects; a separate replacement engine would duplicate
that authority. The separate receipt keeps released journal schemas readable.
The conservative single-use and retained-dependency limits leave later repeat
replacement and primary-only recovery unqualified. Changed Compose overlays,
data-service replacement and reset semantics remain outside this operation.

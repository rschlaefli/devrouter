# ADR 0010: Support verified Devsy releases across a 1.x range

Status: Accepted; source implemented and unit-qualified. The moved trust anchor
for releases Devrouter has not pinned is flagged for maintainer review before a
release ships.

Context: [ADR 0006](./0006-devrouter-owned-devsy-agent-acquisition.md) pins the
supported Devsy version with committed Linux agent digests. The exact pin turned
every Devsy CLI update into a blocked managed start: `doctor` reports
`global.devsy-agent` stale and `ensure` fails before the provider queue, and
the only repair is a Devsy downgrade. Devsy publishes a SHA-256 digest for each
release asset, and its own injection path only warns on an agent version
mismatch, so the equality gate is Devrouter-owned rather than a Devsy
requirement.

Decision: Devrouter supports installed Devsy releases inside `>=1.16.2 <2.0.0`
and resolves the official Linux agent for the installed release. The committed
manifest stays authoritative for the release reviewed in this repository and
remains the offline path. For another in-range release, Devrouter reads the
published release metadata once, keeps only the official Linux agent assets,
requires the SHA-256 digest GitHub reports for each, and records the verified
manifest in versioned Devrouter machine state. A release without a published
digest is refused instead of trusted. Until an explicit setup records that
manifest, an in-range release stays `ready` with a drift warning and Devrouter
injects nothing, so the host CLI governs its own agent instead of trusting an
unverified binary; `setup --workspace-runtime devsy` is the deliberate step
that turns that fallback into verified injection. Later inspection and
`ensure` read the recorded manifest without network access. Versions below the
floor or at and above the next major stay stale, and an explicit
`DEVSY_AGENT_BINARY` remains authoritative only when it matches the official
asset for the installed release.

Why: The exact pin protected one reviewed release but made Devrouter the
bottleneck for routine Devsy maintenance without a compatibility
justification. The verified range keeps the supply-chain gate (size, SHA-256,
atomic publication, and acquisition only through an explicit setup request)
while a compatible release update can proceed. The material trade-off is the
trust anchor. For a release Devrouter has not pinned in source, the expected
digest comes from the release metadata GitHub serves at acquisition time
instead of a value committed in this repository. That delta is deliberate and
bounded: acquisition happens once, in an explicit setup command, and every
later readiness check is deterministic. The exact-version sentence of ADR 0006
is replaced; its verification, ownership, and injection contract stands.

Rejected alternatives:

- Keep the exact version pin. It blocks routine Devsy updates and forces
  downgrades with no compatibility basis.
- Accept any 1.x release without a published digest. That drops the integrity
  gate for every release Devrouter has not pinned.
- Track the Devsy latest release automatically. The target would move without
  review and a future major could enter silently.
- Commit a manifest for every Devsy release. That restores the
  repository-verified anchor but repeats the same bottleneck at each update.

Revisit when Devsy publishes signed release attestations or a stable
integrity-verifying prefetch API, when `2.0.0` approaches, or when an in-range
release changes the agent injection contract.

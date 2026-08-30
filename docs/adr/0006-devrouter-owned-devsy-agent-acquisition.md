# ADR 0006: Verify Devsy agents in Devrouter-owned state

Status: Accepted

Context: Devsy injects a Linux agent when a workspace starts. Its normal
acquisition order can end in one collapsed `agent binary not found` error, so
operators cannot distinguish a missing release asset, failed network request,
invalid cache entry, or incompatible version. Depending on that hidden
start-time acquisition also lets provider mutation begin before Devrouter knows
whether the required agent is available.

Decision: Devrouter pins the supported Devsy version and official Linux agent
asset digests. An explicit Devsy setup request acquires the native matching
asset into versioned Devrouter-owned machine state, verifies its size and
SHA-256 digest, and publishes it atomically. Devsy startup validates that source
before provider mutation and passes it through `DEVSY_AGENT_BINARY` only in the
child process environment. An operator-provided `DEVSY_AGENT_BINARY` remains
authoritative but must match one pinned asset exactly.

Devsy continues to own its workspace registry, provider state, desktop display,
and private cache. Devrouter does not write the private cache or change the
desktop app environment. The desktop app and CLI remain complementary views of
the shared Devsy registry, while Devrouter owns deterministic CLI automation.

Why: Devrouter can now fail before a partial workspace start, report one
actionable readiness state, and avoid trusting an undocumented provider cache.
Versioned Devrouter state makes the supply-chain boundary explicit and permits
safe replacement without taking ownership of Devsy workspaces.

Rejected alternatives:

- Rely on Devsy's implicit download during every cold start. This keeps failure
  opaque and occurs after provider mutation has begun.
- Populate Devsy's private cache. That cache is an undocumented provider-owned
  implementation detail.
- Bundle the agent in Devrouter's npm package. The large platform assets would
  make every install pay for runtime support it may not use.

Revisit when Devsy exposes a stable integrity-verifying prefetch API, or when
the desktop app must independently start Devrouter-managed workspaces.

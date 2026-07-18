# Devrouter roadmap

Status: active. This record contains open work and quality gates, not current product reference material.

Use the [documentation map](../README.md) for supported behavior, [AGENTS.md](../../AGENTS.md) for repository constraints, and the [decision records](../adr/) for durable rationale.

## Validation gates

Required checks for behavior and documentation consistency:

1. `pnpm check:docs-policy`
2. `pnpm check`
3. `pnpm knip`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm build`
7. `node dist/devrouter.js -V --repo ./examples/routing`
8. `node dist/devrouter.js upgrade --repo ./examples/routing`
9. `node dist/devrouter.js setup --repo ./examples/routing --yes --json`
10. `node dist/devrouter.js doctor --repo ./examples/routing`
11. `node dist/devrouter.js repo inspect --repo ./examples/routing --json`
12. `pnpm routing:smoke` when Docker and local networking are available
13. `pnpm devcontainer:smoke` when DevPod is available
14. `pnpm devcontainer:smoke down` after live devcontainer verification

## Near-term roadmap

### Test-surface hardening

- Add platform-specific durability coverage where filesystems expose stronger power-loss test hooks.
- Expand diagnostics tests with mocked Docker responses for edge-case guidance.
- Add command-level regression tests for documentation-backed behavior.

### UX and operability

- Add `devrouter app env <name>` for resolved dependency-environment inspection.
- Add a repository bootstrap helper from discovered Compose metadata to `.devrouter.yml`.
- Add `devrouter app doctor` for app-scoped diagnostics and remediation hints.

### Protocol and runtime expansion

- Evaluate additional TCP protocol support with explicit TLS requirements.
- Define the supported host-runtime TCP strategy in schema and manuals before implementation.

### CI and release hygiene

- Keep CI gates aligned with the validation gates above.
- Keep documentation and knowledge validation mandatory in CI.
- Ensure packaged assets include every upgrade prompt consumed at runtime.

## Known risks

- Shared TCP hostname multiplexing depends on TLS/SNI-capable clients.
- Host-process detection relies on platform-specific process and network inspection.
- Full smoke validation requires Docker, DevPod, and local socket/network access.

## Documentation policy

- Product manuals and active knowledge describe current behavior only.
- Dated project plans, ADRs, and solution records may retain labelled historical context.
- Upgrade and migration instructions stay in `CHANGELOG.md` and `upgrade-prompts/*.md`.

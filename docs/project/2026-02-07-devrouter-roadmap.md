# Devrouter roadmap

Status: active. This record contains open work and quality gates, not current product reference material.

Use the [documentation map](../README.md) for supported behavior, [AGENTS.md](../../AGENTS.md) for repository constraints, and the [decision records](../adr/) for durable rationale.

## Next package

No package is currently approved. Selecting among the independent items in the
near-term backlog requires a new expert-planning pass.

W2 — [Workspace resource accounting](./2026-08-16-workspace-resource-accounting-roadmap.md)
was delivered in [PR #30](https://github.com/rschlaefli/devrouter/pull/30),
merged into `main` at
[f176a67](https://github.com/rschlaefli/devrouter/commit/f176a6672328fe2a4d1da039a05ffb7f0a68cdf2),
and published in [v0.0.36](https://github.com/rschlaefli/devrouter/releases/tag/v0.0.36).
It added opt-in, report-only workspace storage accounting without adding a
mutation path.

W1 — [Packaged CLI command and release proof](./2026-08-15-packaged-cli-command-release-proof-roadmap.md) was delivered in [PR #29](https://github.com/rschlaefli/devrouter/pull/29) and merged into `main` at [f6718c6](https://github.com/rschlaefli/devrouter/commit/f6718c65a0e91dc6f7bb3b40ac1d328ab6a918cf); it added `pnpm test:package` and the required CI step after `pnpm build`. The registry-backed `npx` proof and any publication or release work remain separate scope.

## Validation gates

Required checks for behavior and documentation consistency:

1. `pnpm check:docs-policy`
2. `pnpm check:knowledge`
3. `pnpm check`
4. `pnpm knip`
5. `pnpm typecheck`
6. `pnpm test`
7. `pnpm build`
8. `pnpm test:package`
9. `node dist/devrouter.js -V --repo ./examples/routing`
10. `node dist/devrouter.js upgrade --repo ./examples/routing`
11. `node dist/devrouter.js setup --repo ./examples/routing --yes --json`
12. `node dist/devrouter.js doctor --repo ./examples/routing`
13. `node dist/devrouter.js repo inspect --repo ./examples/routing --json`
14. `pnpm routing:smoke` when Docker and local networking are available
15. `pnpm devcontainer:smoke` when DevPod is available
16. `pnpm devcontainer:smoke down` after live devcontainer verification

## Near-term roadmap

### Test-surface hardening

- Add platform-specific durability coverage where filesystems expose stronger power-loss test hooks.
- Close the macOS `/proc` process-test skip, which both the workspace cleanup
  and packaged-CLI packages carried as a residual concern. The
  [open-source release plan](./2026-02-08-open-source-release-plan.md) owns the
  matching macOS CI lane.
- Expand diagnostics tests with mocked Docker responses for edge-case guidance.
- Add command-level regression tests for documentation-backed behavior; the
  delivered installed-CLI smoke covers this at the distribution boundary.

### UX and operability

- Keep `devrouter workspace cleanup --repo . --inactive-for 30d --json` as the
  report-only managed-workspace inspection path, delivered in
  [PR #27](https://github.com/rschlaefli/devrouter/pull/27); preserve advisory
  activity, explicit `--check-merged` network scope, and fail-closed
  suggestions.
- Run the controlled live report-only `--check-merged` trial against a real
  forge. That package closed as `DONE_WITH_CONCERNS` with synthetic GitHub and
  GitLab CLI JSON as its only integration evidence, so the network path has
  never executed against a live forge.
- Add `devrouter app env <name>` for resolved dependency-environment inspection.
- Add a repository bootstrap helper from discovered Compose metadata to `.devrouter.yml`.
- Add `devrouter app doctor` for app-scoped diagnostics and remediation hints.

### Protocol and runtime expansion

- Evaluate additional TCP protocol support with explicit TLS requirements.
- Define the supported host-runtime TCP strategy in schema and manuals before implementation.

### CI and release hygiene

- Keep CI gates aligned with the validation gates above.
- Keep documentation and knowledge validation mandatory in CI.
- Ensure packaged assets include every upgrade prompt consumed at runtime;
  `pnpm test:package` proves this boundary on every required CI run.

## Known risks

- Shared TCP hostname multiplexing depends on TLS/SNI-capable clients.
- Host-process detection relies on platform-specific process and network inspection.
- Full smoke validation requires Docker, DevPod, and local socket/network access.

## Documentation policy

- Product manuals and active knowledge describe current behavior only.
- Dated project plans, ADRs, and solution records may retain labelled historical context.
- Upgrade and migration instructions stay in `CHANGELOG.md` and `upgrade-prompts/*.md`.

# Project records

Plans live here as dated execution records. Active records may change; delivered records preserve branch context and evidence without becoming product documentation.

## Active

- [Devsy partial-start recovery](./2026-08-26-devsy-partial-start-recovery-plan.md) — keep failed cold Devsy starts canonically stoppable and prepare the 0.0.42 release PR.
- [Dependency-aware devcontainer profiles](./2026-08-26-devcontainer-dependency-profiles-plan.md) — managed app/service/process profile dimensions for devcontainer 0.0.39.
- [HTTP readiness leaf pin](./2026-08-21-http-readiness-leaf-pin-plan.md) — repair the macOS TLS readiness probe without changing lifecycle contracts.
- [Devrouter roadmap](./2026-02-07-devrouter-roadmap.md) — current product and quality backlog.
- [Workspace resource accounting](./2026-08-16-workspace-resource-accounting-roadmap.md) — W2 specification for per-workspace storage consumption in the cleanup report.
- [Workspace resource accounting plan](./2026-08-16-workspace-resource-accounting-plan.md) — W2 execution plan on `rs/workspace-resource-accounting`.
- [Packaged CLI command and release proof](./2026-08-15-packaged-cli-command-release-proof-roadmap.md) — W1 specification for installed-package and CI verification.
- [Open-source release plan](./2026-02-08-open-source-release-plan.md) — remaining portability, CI, and release-verification work.
- [Workspace safety hardening](./2026-07-18-pr-25-workspace-safety-hardening-plan.md) — reviewed `0.0.35` safety candidate in [PR #25](https://github.com/rschlaefli/devrouter/pull/25).
- [Profiles, leases, and resource lifecycle](./2026-08-24-profiles-leases-resource-plan.md) — profile-scoped ensure, lease-based idle tracking, and mode diagnostics for `0.0.36`.
- [Documentation and OKF rework](./2026-07-18-docs-okf-rework-plan.md) — current documentation architecture change.

## Delivered history

- [Runtime-only proxy mode](./2026-06-13-proxy-runtime-plan.md) — introduced routing to externally managed upstreams.
- [Workspace-agent-native workflow](./2026-06-25-pr-9-workspace-agent-native-plan.md) — established parallel-worktree routing and agent guidance.
- [Architecture deepening](./2026-06-28-pr-10-architecture-deepening-plan.md) — separated command surfaces from runtime internals.
- [Agent-native devcontainer usability](./2026-06-28-pr-11-agent-native-devcontainer-usability-plan.md) — added repository inspection and devcontainer onboarding workflows.
- [Workspace lifecycle hardening](./2026-07-13-workspace-lifecycle-hardening-plan.md) — made linked-worktree lifecycle fail closed.
- [Managed development process](./2026-07-14-managed-dev-process-plan.md) — centralized devcontainer process lifecycle.
- [Workspace ownership cleanup](./2026-07-15-workspace-ownership-cleanup-plan.md) — persisted ownership and added conservative garbage collection.
- [Runtime helper delivery](./2026-07-16-pr-24-runtime-helper-delivery-plan.md) — removed devrouter from consumer images.
- [Unified workspace reconciler](./2026-07-16-unified-workspace-reconciler-plan.md) — unified primary and linked checkout startup.
- [Workspace cleanup v1](./2026-08-12-workspace-cleanup-v1-plan.md) — delivered report-only cleanup evidence and safe suggestions for managed linked workspaces in [PR #27](https://github.com/rschlaefli/devrouter/pull/27), merged in [32c29dd](https://github.com/rschlaefli/devrouter/commit/32c29dd54aa0395037e3439d29edcd36dc9b63c8).

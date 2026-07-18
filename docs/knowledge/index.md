---
okf_version: "0.1"
---

# Devrouter knowledge

This OKF bundle gives maintainers and coding agents cross-cutting orientation. It does not replace executable code, tests, `.devrouter.yml` validation, CLI help, ADRs, runbooks, or product manuals. When a concept conflicts with executable behavior, the executable artifact wins and the concept must be corrected in the same change.

## Concepts

- [Repository guide](./repository-guide.md) — choose the authoritative source and first change surface for a task.
- [Architecture and ownership](./architecture-and-ownership.md) — understand which system owns repository, runtime, provider, and route state.
- [Managed environment lifecycle](./managed-environment-lifecycle.md) — follow exact-checkout startup, stop, teardown, and garbage-collection invariants.
- [Routing and runtime contracts](./routing-and-runtime-contracts.md) — change HTTP/TCP routing, application runtimes, dependencies, or route publication safely.
- [Consumer devcontainer contract](./consumer-devcontainer-contract.md) — integrate a self-contained consumer devcontainer without installing devrouter into its image.
- [Change and verification map](./change-and-verification-map.md) — map source changes to tests, manuals, generated guidance, and release proof.

## Maintenance

Concept frontmatter declares source-path review triggers. Run `pnpm check:knowledge` after changing the bundle or any linked authority. Git history is the semantic history; this bundle intentionally has no `log.md`.

---
type: Change Guide
title: Change and verification map
description: Maps Devrouter change surfaces to coupled documentation, tests, generated guidance, and release evidence.
status: active
source_paths:
  - package.json
  - scripts/check-docs-policy.sh
  - scripts/check-knowledge.ts
  - src/core/agents-md.ts
  - src/core/ai-prompt.ts
  - .agents/skills/**
  - .github/workflows/**
  - AGENTS.md
  - CHANGELOG.md
  - upgrade-prompts/**
---

# Change and verification map

## Principle

Run the smallest focused check first, then the full risk-appropriate gate. Product behavior changes must keep current manuals, generated guidance, examples, and the affected knowledge concept synchronized. Historical project records, ADRs, and solution documents change only when their own status, rationale, or incident lesson changes.

## Impact map

| Change surface | Coupled knowledge and guidance | Minimum focused proof |
| --- | --- | --- |
| `src/cli.ts` or `src/commands/**` | Root README, relevant manual, generated command intents when agent-facing | Command test plus CLI help/build output. |
| `src/core/repo-config.ts` or `src/types.ts` | [Routing contract](./routing-and-runtime-contracts.md), examples, `src/core/ai-prompt.ts`, bundled Devrouter skill | `repo-config.test.ts`, prompt consistency, docs policy. |
| Workspace ownership, ensure, stop/down, GC, or DevPod mutation | [Architecture](./architecture-and-ownership.md), [managed lifecycle](./managed-environment-lifecycle.md), relevant ADR/solution | Focused lifecycle/ownership/provider tests and disposable lifecycle smoke. |
| Managed post-start, devcontainer generator, verification, or example | [Devcontainer contract](./consumer-devcontainer-contract.md), `docs/DEVCONTAINER.md`, bundled onboarding skill and templates | Managed-post-start, scaffold/verify tests, cold/warm DevPod smoke. |
| Router, TLS, route discovery, or host-route state | [Architecture](./architecture-and-ownership.md), [routing contract](./routing-and-runtime-contracts.md), routing example | Route/config/state tests and routing smoke. |
| Generated `AGENTS.md`, prompt, or skill output | [Repository guide](./repository-guide.md), `AGENTS.md`, generated snapshots/tests | `agents-md.test.ts`, `ai-prompt.test.ts`, docs policy. |
| Release packaging or runtime resources | Roadmap/release records when active, changelog, one matching upgrade prompt | Build, package dry-run, installed/symlinked executable smoke. |
| Documentation-only authority or structure | This map, `docs/README.md`, `AGENTS.md`, OKF profile when boundaries change | Docs policy, `check:knowledge`, local links, diff checks. |

Source-path frontmatter is a review trigger, not proof that a concept needs editing. Record a no-knowledge-impact conclusion when behavior, contract, invariant, workflow, architecture, or ownership did not change.

## Repository gates and releases

The canonical [validation checklist](../../AGENTS.md#validation-checklist) defines the full repository gate. Add the routing smoke for route behavior and the devcontainer smoke plus teardown for managed DevPod behavior when required local services exist. Static checks are not equivalent to these live gates.

The canonical [release checklist](../../AGENTS.md#release-checklist) owns version, changelog, upgrade-prompt, generated-guidance, package, and publication sequencing. Publication remains a separate approval-gated action after CI and required live evidence pass.

## Knowledge review

Run `pnpm check:knowledge` after concept or profile changes. The validator separates OKF core errors, repository-profile errors, and hygiene findings; it checks local paths and anchors without network access. Unknown producer fields remain allowed. Do not add concepts merely because a path changed—apply the admission test and prefer correcting one canonical page.

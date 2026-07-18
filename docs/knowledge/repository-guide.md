---
type: Repository Guide
title: Repository authority and task guide
description: Routes common Devrouter changes to the artifact that owns the behavior and its required evidence.
status: active
source_paths:
  - src/cli.ts
  - src/commands/**
  - src/core/repo-config.ts
  - src/core/agents-md.ts
  - src/core/ai-prompt.ts
  - AGENTS.md
  - docs/README.md
---

# Repository authority and task guide

## Purpose and boundary

Use this concept to find the first trustworthy artifact for a change. It explains authority and relationships, not every file or command. The [documentation map](../README.md) routes readers to current manuals, decisions, solutions, project records, and release history.

## Authority order

| Question | Start here | Why |
| --- | --- | --- |
| What commands and flags exist? | `src/cli.ts` and the matching `src/commands/*.ts` handler | Command registration and option parsing are executable. |
| What does `.devrouter.yml` accept? | `src/core/repo-config.ts:loadRepoConfig` and `src/core/__tests__/repo-config.test.ts` | Parsing is strict; prose examples do not extend the schema. |
| What happens at runtime? | The matching `src/core/*.ts` module and tests | Core modules own lifecycle and state transitions. |
| Why is a durable boundary designed this way? | [ADRs](../adr/) | ADRs own accepted rationale, not current implementation detail. |
| How should a user perform a supported task? | [Product manuals](../README.md) and generated CLI help | Manuals own current operating guidance. |
| Why did a failure recur and how is it prevented? | [Integration solutions](../solutions/integration/) | Solution records preserve incident-derived lessons. |
| What was one branch meant to deliver? | [Project records](../project/index.md) | Plans are dated execution history, not current reference truth. |

## Repository shape

`src/cli.ts` registers commands. Thin modules under `src/commands/` translate CLI options and output. Modules under `src/core/` own parsing, orchestration, provider interaction, state, and validation. Shared public types live in `src/types.ts`.

Repository-generated guidance is a product surface: `src/core/ai-prompt.ts` owns the onboarding prompt, while `src/core/agents-md.ts` owns the generated `AGENTS.md` section and bundled skill. Update their regression tests when changing those outputs.

## Task routes

- Configuration or runtime kind: start with `src/core/repo-config.ts`, then follow the [routing contract](./routing-and-runtime-contracts.md).
- Checkout, DevPod, stop/down, or garbage collection: follow the [managed lifecycle](./managed-environment-lifecycle.md).
- Consumer `.devcontainer/` wiring: follow the [devcontainer contract](./consumer-devcontainer-contract.md).
- Shared router or state ownership: follow [architecture and ownership](./architecture-and-ownership.md).
- Documentation, generated guidance, CI, or release work: use the [change and verification map](./change-and-verification-map.md).

## Change guidance

Verify current behavior in code and tests before editing a concept. Update only concepts materially affected by a contract, invariant, workflow, architecture, or ownership change. A localized refactor with no semantic effect normally changes no concept page.

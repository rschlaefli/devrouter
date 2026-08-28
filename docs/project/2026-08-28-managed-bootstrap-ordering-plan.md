# Managed devcontainer bootstrap ordering plan

## Goal

- Make every devrouter-managed repository adapter run only after the consumer's
  `postCreateCommand` has completed successfully.
- Reject unsafe lifecycle configuration before Devrouter, DevPod, Devsy,
  Compose, managed processes, or routes mutate external state.
- Preserve the consumer's lifecycle contract in the generated selective-profile
  config and keep repositories without a managed adapter compatible.
- Publish the fix as devrouter `0.0.43`, then use that exact release for the
  linked KlickerUZH consumer repair and provider matrix.

## Non-goals

- Do not emulate the Dev Container lifecycle or run a consumer's
  `postCreateCommand` from devrouter.
- Do not silently add, normalize, or weaken `waitFor` in a consumer repository.
- Do not make warm profile transitions recreate a workspace, rerun post-create,
  reset a database, or remove a container or volume.
- Do not change the machine's preferred workspace provider, configure Devsy,
  access secrets, invoke an external model, deploy, force-push, or delete a
  branch, worktree, workspace, container, or volume.
- Do not merge the linked KlickerUZH pull request under this plan.

## Execution contract

- Proposed authority: One approval of this plan and the linked Klicker plan
  authorizes work in the two named task worktrees, bounded implementation
  delegation, repository edits, repository-native checks, local conventional
  commits, synthetic provider runtimes, exact runtime stops, required reviews,
  pushes, pull-request creation and maintenance, and exact-head CI monitoring.
- Proposed upstream delivery authority: The same approval authorizes merging
  the devrouter pull request and publishing `0.0.43` only after required review,
  exact-head CI, package inspection, and release checks pass. It does not
  authorize bypassing a required check or publishing a different version.
- Withheld authority: Klicker merge, deployment, machine provider-preference
  changes, Devsy installation or configuration, secret access, external model
  calls, real or personal data, force-push, destructive cleanup, branch or
  worktree deletion, and container or volume removal remain withheld.
- Execution owner: The current main session is the cross-repository execution
  orchestrator because validation, release, consumer pinning, and provider proof
  are one critical path. It owns architecture, integration, external-action
  gates, review disposition, and final evidence.
- Terminal: Devrouter `0.0.43` is published from a reviewed, green exact head;
  the linked Klicker branch pins that artifact and reaches merge-ready with the
  provider matrix complete; every task runtime is stopped with zero owned
  routes. Klicker merge and destructive cleanup remain separate decisions.
- Pause: Stop before release if the validator cannot run before provider
  mutation, generated config changes lifecycle fields, rollback publishes a
  candidate route, or exact provider ownership cannot be proven.
- Pause: Stop if checks require credentials, external model calls, real data,
  provider installation/configuration, destructive cleanup, force-push, a
  different release version, or unrelated workspace mutation.

## Plan identity and package boundary

- Plan: `docs/project/2026-08-28-managed-bootstrap-ordering-plan.md`
- Repository: `/Users/rschlae/Git/personal/devrouter`
- Branch: `rs/managed-bootstrap-ordering`
- Worktree: `trees/managed-bootstrap-ordering`
- Target: `main`
- Fresh base: `origin/main` at `4abbfc92c09d1de5cc872ceb28a8173ef20ffac5`
  (`0.0.42`), 0 ahead and 0 behind when the worktree was created.
- Pull request: not created.
- Release candidate: `0.0.43`.
- Consumer: KlickerUZH plan
  `project/2026-08-28-provider-safe-devcontainer-bootstrap-plan.md` on branch
  `rs/provider-safe-devcontainer-bootstrap` from current `origin/v3`.
- Packaging: One upstream devrouter pull request and release, followed by one
  ordinary Klicker consumer pull request. This is not a GitHub stack.

## Findings and root cause

- The Dev Container specification defaults `waitFor` to
  `updateContentCommand`. Later lifecycle commands may continue after the
  provider reports the environment ready unless the consumer selects a later
  wait point.
- Klicker declares a destructive and state-producing `postCreateCommand` but no
  `waitFor`. Its devrouter-managed `post-start.sh` immediately consumes files
  created by post-create.
- The observed Devsy failure is therefore consistent with the declared
  lifecycle: devrouter invoked the repository adapter while post-create was
  still installing, building, resetting, seeding, and writing runtime shims.
- Warm profile proof does not establish cold-start ordering because an existing
  workspace may already contain all post-create artifacts.
- `resolveManagedPostStartPlan` runs before provider startup and is the earliest
  common adapter seam. `inspectManagedDevcontainerConfig` currently runs only
  for the managed-runtime profile contract and therefore cannot be the sole
  validator.
- The generated devcontainer config is a same-directory copy whose only
  intentional semantic change is `runServices`; preserving the source
  `waitFor` is part of that compatibility contract.

## Settled lifecycle contract

### Applicability

- Validate every repository whose adapter is managed by devrouter, including
  legacy managed post-start and `managedRuntime` consumers. Do not limit the
  gate to dependency-profile repositories.
- If the source devcontainer declares no `postCreateCommand`, retain current
  behavior and require no `waitFor` migration.
- If it declares `postCreateCommand`, a managed adapter is safe only when
  `waitFor` is exactly `postCreateCommand` or `postStartCommand`.
- Missing, earlier, malformed, or unsupported `waitFor` values are hard errors.
  Do not warn, guess intent, or rewrite the source.

### Parsing and placement

- Parse the effective source `devcontainer.json` with the repository's existing
  JSON-with-comments-compatible parser path. Add no parser dependency unless
  characterization proves the current path cannot preserve valid JSONC.
- Perform lifecycle validation while resolving the managed adapter, before
  writing generated configuration, starting a provider, selecting Compose
  services, delivering helpers, invoking repository scripts, or publishing
  routes.
- Name the source file and accepted values in the error. Keep diagnostics
  values-free and suitable for `doctor`, `verify`, and `ensure`.
- Preserve the validated source `waitFor` unchanged in
  `.devcontainer/devcontainer.devrouter.json`.

### Failure and rollback

- A static lifecycle rejection performs zero provider, service, process, or
  route mutations.
- A provider that violates the declared wait point may start base or selected
  services before the repository marker assertion fails. Existing transition
  rollback must then stop newly selected profile services, retain exact
  recoverable ownership, and publish zero candidate routes or processes.
- Never rerun post-create as recovery. A fresh provider workspace is repaired by
  fixing lifecycle compliance or recreating it under an explicitly destructive
  workflow, not by a warm profile switch.

## Product primitive and ADR gates

- Product primitive: No end-user product primitive, stored data model, or public
  application API changes. This is a developer-runtime contract.
- ADR: Existing devrouter lifecycle and exact-ownership decisions already cover
  the placement and rollback model. Clarify the consumer lifecycle contract in
  the matching knowledge page; add an ADR only if implementation introduces a
  new persistence owner or provider-specific semantic branch.
- Re-arm architecture review if safe ordering would require provider-specific
  sleeps, lifecycle emulation, workspace recreation, broad Compose commands, or
  mutation before validation.

## Research and planning review

- The Dev Container lifecycle reference documents the command sequence and the
  default wait point:
  <https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-reference.md>.
- The schema defines the legal `waitFor` enum and default:
  <https://github.com/devcontainers/spec/blob/main/schemas/devContainer.base.schema.json>.
- The reference CLI implements the same default and lifecycle ordering:
  <https://github.com/devcontainers/cli/blob/main/src/spec-common/injectHeadless.ts>.
- The required native planner route could not launch because this task retained
  stale role metadata (`combo/glm-5.3-flash` with unsupported maximum effort),
  while the canonical planner configuration currently points to Sol/xhigh.
- Continuity used one read-only generic planner on `gpt-5.6-sol` at xhigh. It
  returned `DONE_WITH_CONCERNS`.
- Accepted: validate all managed adapters; reject unsafe source configuration;
  validate before mutation; preserve `waitFor`; release upstream before final
  consumer proof; use separate cold workspaces for DevPod and Devsy.
- Accepted correction: Marker validation is an immediate assertion, not a poll.
  The declared `waitFor` owns synchronization.
- Accepted correction: A provider may already have started selected services
  before a marker exposes its violation, so failure proof must include rollback
  to zero candidate services, processes, and routes.

## Delegation and review map

| Slice | Owner | Dependency | Acceptance boundary | Review gate |
| --- | --- | --- | --- | --- |
| D0 plan | main | approval | Both linked plans are approved and committed | planner complete via disclosed continuity route |
| D1 lifecycle gate | main | D0 | All managed adapters reject unsafe ordering before mutation | simplifier + lifecycle slice-reviewer |
| D2 guidance and release metadata | executor | D1 | Scaffold, diagnostics, docs, examples, changelog, and `0.0.43` agree | simplifier; main verifies |
| D3 integration and release | main | D1-D2 | Full checks, artifact inspection, exact-head CI, merge, and release pass | final-reviewer |

- D1 remains in the main session because it defines a cross-provider safety
  boundary in the critical path.
- D2 is a bounded mechanical slice with no credentials, provider calls, or
  private data. The main session verifies every change before integration.
- Reviewers are distinct from implementers. Findings are advice until the main
  session verifies and dispositions them.

## Test portfolio

| Consequential behavior | Stable seam | Required cases | Distinct failure |
| --- | --- | --- | --- |
| Adapter applicability | managed-post-start resolver | legacy adapter, managedRuntime adapter, scaffold adapter, unmanaged repo | a managed adapter bypasses the gate |
| Safe ordering | lifecycle parser/validator | `postCreateCommand` and `postStartCommand` wait points | safe consumer is rejected |
| Unsafe ordering | lifecycle parser/validator | missing, initialize, onCreate, updateContent, malformed value | provider mutation can precede rejection |
| No-post-create compatibility | lifecycle parser/validator | managed adapter without post-create | migration is required without a race |
| JSONC support | fixture parsing | comments and trailing commas | valid devcontainer config is rejected |
| Generated-config fidelity | profile config test | source wait point survives; only `runServices` changes semantically | generated config weakens lifecycle |
| Zero-mutation rejection | workspace ensure unit | provider/service/helper/route mocks remain untouched | static error causes external effects |
| Provider violation rollback | workspace ensure integration fixture | selected services start, marker fails, services stop, no process/route | partial environment remains exposed |
| Diagnostics | doctor/verify/ensure | actionable file and accepted values, no secret values | consumer cannot repair configuration |
| Release artifact | package smoke | packed `0.0.43`, version pin examples, bundled guidance | source passes but published CLI differs |

## Slices and commits

### D0: commit the reviewed plan

- Commit this file after approval and record Progress as active.
- Verify the worktree remains based on the recorded `origin/main` and stages no
  unrelated primary-checkout `.pnpm-store` content.
- Commit: `docs(project): plan managed bootstrap ordering`.

### D1: enforce the lifecycle gate before mutation

- Route: `main`; execution-tier skip reason: critical-path coupling at the
  cross-provider lifecycle and pre-mutation boundary.
- Acceptance: Focused resolver, JSONC, generated-config, diagnostics,
  zero-mutation, and rollback checks pass on the committed slice.
- Add a focused source-devcontainer lifecycle parser/validator called by
  `resolveManagedPostStartPlan` for every managed adapter.
- Keep repositories without post-create compatible. Hard-reject unsafe wait
  points for consumers with post-create.
- Thread no new provider-specific behavior into `workspaceEnsure`.
- Add focused resolver, JSONC, generated-config, diagnostics, and zero-mutation
  tests. Add a rollback fixture only at the smallest seam that proves selected
  services are removed and routes/processes remain absent.
- Run formatting, typecheck, focused tests, and `git diff --check` before commit.
- Commit: `fix(devcontainer): require managed bootstrap ordering`.
- Run simplifier and lifecycle slice-reviewer in parallel; verify and disposition
  each finding before D2.

### D2: align scaffolds, guidance, and release metadata

- Route: `executor` in the Devrouter task worktree after D1 review closes.
- Acceptance: Scaffold, diagnostics, bundled guidance, changelog, version pins,
  docs policy, knowledge checks, and packed `0.0.43` artifact agree.
- Add safe `waitFor` to Devrouter's managed devcontainer scaffold and reference
  examples that declare post-create plus managed post-start.
- Update consumer contract, lifecycle knowledge, Dev Container guidance,
  diagnostics text, bundled skill, and agent prompt where the public contract is
  described.
- Bump package and example pins to `0.0.43`; add changelog and upgrade guidance.
- Run docs policy, knowledge checks, formatting, typecheck, focused tests, and
  package inspection.
- Commit: `chore(release): prepare 0.0.43`.

### D3: integrate, review, publish, and prove the artifact

- Route: `main`; execution-tier skip reason: release authority, exact-head CI,
  package publication, and cross-repository integration are critically coupled.
- Acceptance: The complete branch passes the release checklist and final
  review; the merged exact artifact is published and independently read back as
  `0.0.43`.
- Run the repository release checklist, including check, knip, typecheck, full
  test suite, build, package smoke, setup/doctor/inspect tests, and applicable
  provider-free lifecycle smokes.
- Run one final-reviewer over the integrated exact range and apply only verified
  corrections. Rerun affected checks.
- Inspect staged and packed content for credentials and personal data.
- Push and open an ordinary pull request with an exact-head evidence body.
- Monitor exact-head CI and review threads. Merge only when required checks and
  review gates pass, then publish exactly `0.0.43` and verify registry metadata,
  package contents, and CLI version.
- Stop at `release_blocked` if publication or exact-head CI fails. Do not pin an
  unpublished candidate in Klicker.

## Progress

- `2026-08-28`: Root cause confirmed against current source and Dev Container
  specification. Fresh branch created from `origin/main` at `4abbfc9`.
- `2026-08-28`: Read-only planning review completed through the disclosed Sol
  continuity route with corrections incorporated.
- `2026-08-28`: The user approved both linked plans, including the named
  Devrouter merge and `0.0.43` release boundary. D0 is active; D1 follows after
  the plan commit while Klicker K1 runs in its separate worktree.
- `2026-08-28`: D0 committed as `8aaa970`. D1 now uses strict JSONC parsing,
  rejects managed adapters with unsafe bootstrap ordering at the pre-provider
  resolver seam, preserves the accepted wait point in generated profiles, and
  reports an actionable values-free diagnostic. Focused verification passes:
  Biome on all touched files, 88 resolver/profile/ensure/diagnostic tests,
  TypeScript, Knip, and `git diff --check`.
- `2026-08-28`: D1 committed as `76ff322`. The disclosed Luna/max continuity
  simplifier found no code simplification and one stale Progress line. The
  lifecycle slice reviewer requested values-free unsupported-value diagnostics
  and explicit cold marker-failure rollback proof; both corrections are
  implemented and verified for the correction commit.
- Current state: `active`. Completed slices: D0. Active: D1 correction review.
  Remaining: D2-D3. Latest evidence: the branch contains committed D0 and D1;
  no provider runtime is active for this package. Required delivery: published
  `0.0.43`; achieved delivery: reviewed plan plus committed D1 implementation
  with verified reviewer corrections.

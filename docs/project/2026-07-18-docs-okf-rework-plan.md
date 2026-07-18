# Devrouter documentation and OKF rework plan

## Goal

- Give humans and agents one clear documentation entry point.
- Add a lean OKF v0.1 knowledge bundle for cross-cutting architecture, lifecycle, integration, and change guidance.
- Consolidate repeated product manuals while keeping executable behavior, ADRs, runbooks, and incident solutions authoritative.
- Move project artifacts under `docs/project/` and normalize plan filenames.

## Non-goals

- No CLI, schema, routing, lifecycle, or release behavior changes.
- Do not turn every Markdown file into an OKF concept.
- Do not rewrite ADRs, solution records, release history, or completed plans for style.
- Keep root `CONTEXT.md`; Matt Pocock skills consume its domain vocabulary.
- No workspace-safety implementation, npm publication, or package release within this branch.

## Identity

- Plan: `docs/project/2026-07-18-docs-okf-rework-plan.md`
- Branch: `codex/docs-okf-knowledge`
- Worktree: `trees/docs-okf-knowledge`
- Target: `main` at `ee425ab`; the documentation commits were rebased after the safety PR merged, and the verified merge base equals `origin/main`.
- Related PR: merged workspace safety hardening [PR #25](https://github.com/rschlaefli/devrouter/pull/25).

## Decisions

- Use OKF Tier 2 at `docs/knowledge/`; `docs/` remains the mixed documentation root.
- Keep manuals, ADRs, solutions, project plans, changelog, upgrade prompts, examples, and generated agent guidance outside the OKF bundle.
- Use `Repository Guide`, `Architecture Concept`, `Workflow`, `Integration Contract`, and `Change Guide` as the local concept types.
- Declare `type`, `title`, `description`, `status`, and `source_paths` as required in `docs/knowledge/profile.yaml`; that manifest is the single local policy authority beyond OKF core. Use role owner `repository maintainers` for the high-consequence lifecycle and integration concepts.
- Validate with existing `yaml` and `tsx` dependencies; add no package dependency.
- Move all project artifacts to `docs/project/`. Filenames use lowercase kebab-case with the original creation date and `-plan.md` for implementation plans.
- Date precedence: retain a valid existing `YYYY-MM-DD` prefix as the authorial creation date; for undated files, use the author date of the first-add commit from `git log --follow --diff-filter=A`.
- Preserve useful roadmap content. Remove only claims proven complete or duplicated, and retain remaining work in a dated roadmap or plan.
- Keep `CONTEXT.md` at the repository root and link it from the docs map.
- Treat the six proposed concepts as a ceiling, not a quota. Merge any page that fails the admission test or lacks an independent durable boundary.
- Current-state policy applies to product manuals and active knowledge. `docs/project/**`, `docs/adr/**`, and `docs/solutions/**` are status-labelled records and may retain historical context.

## Research

- Evidence: 2,253 lines span `README.md` and current top-level manuals; workspace, devcontainer, TLS, diagnostics, secret-manager, and app-run guidance recur across three to six files.
- Evidence: `docs/` mixes current manuals, ADRs, incident solutions, and plans. Only the solution files have frontmatter, and their custom schema is not OKF core.
- Evidence: the repository already has `yaml` and `tsx`; `okflint` and PyYAML are unavailable.
- Evidence: no `CODEOWNERS` or other ownership file exists. Role ownership avoids inventing a person or team.
- External research: none needed. OKF v0.1 and its lean codebase profile are the governing sources.

## Independent plan review

- Reviewer: independent Codex collaboration agent, 2026-07-18.
- Accepted blockers: rebase docs-only commits after the stacked safety PR lands instead of merely retargeting; add an explicit source/destination/date/preservation manifest; carve historical records out of the current-state product-doc rule; specify validator categories, tolerance, index rules, offline link behavior, and test fixtures.
- Accepted simplification: build the migration manifest first; treat six concepts as a ceiling and merge thin concepts.
- Result: ready to commit after these revisions.

## Project artifact migration manifest

Date evidence uses the existing prefix when present. Undated sources use their verified first-add date.

| Source | Destination | Date evidence | Treatment |
| --- | --- | --- | --- |
| `docs/PLAN.md` | `docs/project/2026-02-07-devrouter-roadmap.md` | Git first add `2026-02-07` | Preserve open roadmap; replace repeated baseline and decision prose with canonical links. |
| `docs/OSS_PLAN.md` | `docs/project/2026-02-08-open-source-release-plan.md` | Git first add `2026-02-08` | Verify checklist state; retain incomplete sensible work and accurate completion evidence. |
| `project/PROXY_RUNTIME_PLAN.md` | `docs/project/2026-06-13-proxy-runtime-plan.md` | Git first-add author date and documented update `2026-06-13` | Preserve as delivered implementation history. |
| `project/2026-06-25-pr-9-workspace-agent-native.md` | `docs/project/2026-06-25-pr-9-workspace-agent-native-plan.md` | Existing `2026-06-25` prefix | Preserve; normalize missing suffix. |
| `project/2026-06-28-pr-10-architecture-deepening-plan.md` | `docs/project/2026-06-28-pr-10-architecture-deepening-plan.md` | Existing prefix | Preserve. |
| `project/2026-06-28-pr-11-agent-native-devcontainer-usability-plan.md` | `docs/project/2026-06-28-pr-11-agent-native-devcontainer-usability-plan.md` | Existing prefix | Preserve. |
| `project/2026-07-13-workspace-lifecycle-hardening-plan.md` | `docs/project/2026-07-13-workspace-lifecycle-hardening-plan.md` | Existing prefix | Preserve. |
| `project/2026-07-14-managed-dev-process-plan.md` | `docs/project/2026-07-14-managed-dev-process-plan.md` | Existing prefix | Preserve. |
| `project/2026-07-15-workspace-ownership-cleanup-plan.md` | `docs/project/2026-07-15-workspace-ownership-cleanup-plan.md` | Existing prefix | Preserve. |
| `project/2026-07-16-pr-24-runtime-helper-delivery-plan.md` | `docs/project/2026-07-16-pr-24-runtime-helper-delivery-plan.md` | Existing prefix | Preserve. |
| `project/2026-07-16-unified-workspace-reconciler-plan.md` | `docs/project/2026-07-16-unified-workspace-reconciler-plan.md` | Existing prefix | Preserve. |
| `project/2026-07-18-workspace-safety-hardening-plan.md` | `docs/project/2026-07-18-pr-25-workspace-safety-hardening-plan.md` | Existing prefix; PR now known | Preserve; add known PR ID per plan schema. |

After moves, scan Markdown, scripts, and configuration for stale source-path literals as well as clickable links.

## Slice 1: Normalize project artifacts and documentation navigation

- Do: create `docs/README.md` as the human documentation map.
- Do: move root `project/` files and top-level planning documents into `docs/project/`; normalize uppercase and undated names using verified creation dates.
- Do: preserve useful open roadmap work and update stale completion state instead of deleting it.
- Do: add a status index for active and delivered project records.
- Do: update live references, documentation policy inputs, and plan identity paths. Define manuals/knowledge as current-state product docs while project plans, ADRs, and solutions remain status-labelled records. Keep `CONTEXT.md` unchanged at root.
- Check: no project plan remains outside `docs/project/`; every project filename starts with `YYYY-MM-DD-` and uses lowercase kebab-case; internal links resolve; docs policy passes.
- Commit: `docs(project): organize dated project plans`.

## Slice 2: Add the lean OKF knowledge bundle

- Do: add `docs/knowledge/index.md` plus repository guide, architecture, managed lifecycle, routing/runtime contract, consumer devcontainer contract, and change/verification concepts.
- Do: synthesize only cross-cutting knowledge that passes the admission test. Link canonical source symbols, tests, ADRs, manuals, and solution records.
- Do: add a local OKF profile/impact map and deterministic TypeScript validation. Preserve unknown producer fields; report core errors, profile errors, and hygiene findings separately; enforce root and non-root `index.md` rules; check local paths and anchors without network access; detect duplicate titles and missing source paths.
- Do: add deterministic fixtures for valid unknown fields, each error category, reserved-index rules, broken paths/anchors, duplicate titles, and missing source paths.
- Do: add the validator to package and CI-facing documentation checks without new dependencies.
- Check: OKF validation, docs policy, formatter, typecheck, and focused script tests pass.
- Commit: `docs(knowledge): add lean OKF repository bundle`.

## Slice 3: Consolidate current-state manuals

- Do: shorten `README.md` to product orientation, five-minute path, and documentation map.
- Do: keep `GETTING_STARTED.md` focused on installation and first successful route; keep `REPO_ONBOARDING.md` focused on consumer-repository onboarding; retain `DEVCONTAINER.md` as the canonical managed integration guide.
- Do: replace duplicated detail with links while preserving all unique supported behavior, constraints, commands, and verification steps.
- Do: update `AGENTS.md`, examples, and docs-policy rules for the new authority map and knowledge maintenance contract.
- Check: no current product capability or safety constraint is lost; docs policy, OKF validation, link checks, formatter, Knip, typecheck, tests, and build pass.
- Commit: `docs: consolidate product and contributor guidance`.

## Finish gate

- Review each slice for correctness and simplification before commit.
- Run a documentation-appropriate security review, independent whole-branch review, and strict maintainability review.
- Update this progress section and the ready PR against `main` with whole-branch evidence only after approval to push.

## Progress

- Current: implementation and final review fixes are complete. After PR #25 merged, the seven documentation/tooling commits were rebased onto `origin/main` at `ee425ab`; the merge base matches that commit, the branch diff is isolated from the safety implementation, and `CONTEXT.md` remains unchanged. Root orientation is 101 lines, getting started is 128, repository onboarding has one consumer-focused authority, and the canonical devcontainer contract is retained. The OKF validator parses typed documents once through a 60-line orchestrator and focused context/core/profile/hygiene modules; `profile.yaml` is the sole local required-field authority, real-path containment rejects symlink escapes, and link findings map stripped bodies back to exact source lines. Per-slice reviews are clean; two-axis branch and security findings are resolved; the final thermo-nuclear gate approves after its source-line blocker was fixed and re-reviewed; and the separate simplification pass is clean. Fresh docs policy, OKF validation, Biome, Knip, typecheck, all 527 tests, build, and diff checks pass. The earlier 77-file local-link scan still applies because the only later content change is this plan checkpoint; the Linux-only process test is explicitly skipped on macOS, and live routing/DevPod smokes are inapplicable to this documentation/tooling-only branch.
- Next: push the rebased branch, open a ready PR against `main`, wait for required CI and feedback, then merge under the user's explicit authority.

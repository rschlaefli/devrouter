# Runtime helper delivery plan

## Goal

- Remove devrouter package downloads and helper installation from generated and adopted consumer Dockerfiles.
- Keep generic process ownership in devrouter while application commands and environment setup remain repository-owned.
- Make `.devrouter.yml` the only consumer-side devrouter version pin.
- Migrate and revalidate elearning draft MR !73 after the upstream change is released.

## Non-goals

- Replace DevPod, Docker Compose, the existing process-group ownership algorithm, or route readiness.
- Add process configuration to `.devrouter.yml`.
- Make direct `devpod up` the canonical application-start command; `devrouter ensure` remains canonical.
- Change elearning application, PDF-navigation, database-schema, deployment, or production configuration.

## Identity

- Plan: `project/2026-07-16-runtime-helper-delivery-plan.md`
- Branch: `codex/runtime-helper-delivery`
- Worktree: `trees/runtime-helper-delivery`
- Target: `main`
- Base: `main` at `e8a2dbb`
- PR: none
- Related downstream: elearning draft [MR !73](https://gitlab.uzh.ch/uzh-bf/tc/elearning/-/merge_requests/73)
- Related history: `project/2026-07-14-managed-dev-process-plan.md` and `project/2026-07-16-unified-workspace-reconciler-plan.md`

## Research

- Evidence: generated Dockerfiles currently download the pinned `@devrouter/cli` tarball solely to extract `bin/devrouter-process`; the CLI dependency tree is not installed.
- Evidence: generated `devcontainer.json` delegates `postStartCommand` directly to `.devcontainer/post-start.sh`, so the helper must currently exist before host-side `ensure` regains control.
- Evidence: `workspaceEnsure` already proves the exact app container and its in-container workspace path before route publication and HTTP readiness.
- Evidence: the helper is a packaged Linux shell asset; it owns locking, PID/PGID proof, fingerprinted reuse, bounded replacement, logging, and foreign-process refusal.
- Evidence: Docker inspection and execution are already part of the trusted local DevPod reconciliation path.
- Limitation: no external research is needed because the change is internal ownership and lifecycle code covered by local source, package, and live downstream evidence.

## Resolved decisions

- Decision: follow [ADR 0002](../docs/adr/0002-keep-devrouter-out-of-consumer-images.md). Consumer images contain no devrouter package or helper installation.
- Decision: after exact-container preflight, `devrouter ensure` copies its packaged helper to a fixed runtime-only path inside the container and invokes the managed repository post-start adapter with the helper path in `DEVROUTER_PROCESS_HELPER`.
- Decision: preflight returns the exact validated container ID and in-container workspace path. Delivery and adapter execution consume that result directly without re-inspecting or re-selecting a container.
- Decision: generated `devcontainer.json` no longer declares `postStartCommand`; canonical `ensure` owns adapter invocation after helper delivery. This avoids a bootstrap dependency on a helper that is intentionally absent from the image.
- Decision: the managed marker and conventional `.devcontainer/post-start.sh` path are the opt-in contract. Non-managed/custom devcontainers retain their existing startup behavior.
- Decision: retain `procps` and `util-linux` because the helper uses them, but remove `tar` when it is no longer otherwise required by the generated image.
- Decision: add static diagnostics and regression assertions that reject devrouter package/helper installation in a consumer Dockerfile.
- Decision: use an explicit migration matrix. Legacy adapter plus legacy image remains temporarily supported; new adapter plus legacy image uses the delivered helper; new adapter plus helper-free image is the target state; legacy adapter plus helper-free image fails early with an actionable migration error.
- Decision: migrate consumers in order: adopt the new adapter contract, remove automatic `postStartCommand`, remove the Dockerfile helper block, then recreate through `devrouter ensure`. The files travel atomically in one commit even though validation checks the ordered states.

## Skill routing

- Delivery: `$rs-sliced-development-workflow`.
- Runtime contract: repository `devrouter` skill.
- Architecture record: `$domain-modeling`.
- Per-slice review and simplification: separate workflow review agents using `references/review-rubric.md`.
- Finish: `$verification-before-completion`, `$security-review`, `$thermo-nuclear-code-quality-review`, and `$rs-mr-description-writer`.

## Slice 1: Deliver the helper at reconciliation time

- Do: add package-asset resolution and a focused managed-post-start runner that streams the helper into the exact app container, applies executable permissions, and invokes the repository adapter with argv-safe Docker execution.
- Do: make container preflight return its exact validated container ID and workspace path; call one `preflight → deliver → invoke adapter` operation after initial attachment and every bounded recreation, before route publication/readiness.
- Do: fail closed and clear unpublished/stale route state when delivery or post-start fails.
- Check: focused unit tests prove delivery order, exact container/workdir without re-selection, helper failure behavior, post-start failure behavior, warm reuse, and no route publication before successful startup.
- Check: an HTTP-readiness-triggered recreation repeats preflight, helper delivery, and adapter execution before route republish.
- Check: existing primary/linked ownership and recreate tests remain green.
- Commit: `fix(ensure): deliver managed process helper at runtime`.

## Slice 2: Remove image-time devrouter coupling

- Do: remove package download/extraction and `tar` from the generated Dockerfile.
- Do: remove automatic `postStartCommand` from generated `devcontainer.json` and make generated `post-start.sh` require the runtime helper path supplied by `ensure`.
- Do: add doctor/verification evidence that consumer Dockerfiles do not install or extract devrouter.
- Do: update generated guidance, docs, upgrade guidance, and the ADR without adding another consumer-side version source.
- Check: scaffold generation/idempotence, diagnostics, migration-matrix behavior, docs policy, package contents, and full repository gates.
- Commit: `fix(devcontainer): keep devrouter out of consumer images`.

## Slice 3: Release and migrate elearning

- Do: open and review the devrouter PR; merge and release only with the required explicit merge authority.
- Do: update elearning draft MR !73 to the released version, remove the Dockerfile helper block, remove automatic DevPod post-start, and use the runtime-delivered helper contract.
- Do: refresh generated devrouter guidance and rename/update the current elearning plan to include MR !73.
- Check: cold and warm linked-worktree startup, primary-checkout reuse/reconciliation, trusted HTTPS, clean `exec` status propagation, full repository checks, and the duplicate-title PDF browser regression at required viewports.
- Check: cold proof uses a fresh DevPod/image built from the helper-free Dockerfile, asserts `/usr/local/bin/devrouter-process` is absent, asserts the delivered helper exists only at its runtime path, and proves application startup.
- Check: prove neither the devrouter generated scaffold nor elearning Dockerfile contains `@devrouter/cli`, `devrouter-process`, or an image-time devrouter version pin.
- Commit boundaries: one downstream implementation commit plus one plan/MR metadata commit if required by the workflow.

## Finish gates

- Independent plan review accepted before the plan-only commit.
- Per-slice correctness review and separate simplification review completed.
- Full devrouter tests, typecheck, build, Biome, Knip, docs policy, ShellCheck, package smoke, Opengrep, and diff checks pass.
- Mandatory security and strict maintainability reviews have no unresolved blocker.
- Elearning local runtime and GitLab CI pass on the updated draft MR.
- No secrets, credentials, personal data, local fixtures, database exports, or unrelated work are staged.
- No merge occurs without the repository-required explicit authority.

## Progress

- Current: research and independent plan review complete; accepted findings are integrated and the plan is ready for its standalone commit.
- Evidence: current `0.0.33` generator and elearning adoption both embed only `devrouter-process`, not the full CLI, but still couple the image build to the devrouter package and version.
- Review: independent reviewer required exact preflight-result threading, an explicit four-state migration matrix, helper delivery on the HTTP-recreation path, and a truly fresh helper-free cold proof. All four corrections are incorporated above.
- Blocked: none.
- Next: commit the plan alone, then execute Slice 1 while leaving ADR 0002 for the implementation commit.

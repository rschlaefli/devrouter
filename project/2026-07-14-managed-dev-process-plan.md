# Managed Dev Process Plan

## Goal

- Ship one reusable, fail-closed dev-process supervisor with Devrouter.
- Replace repository-specific PID, process-group, locking, and restart code.
- Keep application commands and environment setup inside each application repository.

## Non-goals

- No application-health policy inside the supervisor.
- No new `.devrouter.yml` schema.
- No change to `workspace ensure` route readiness or its single recreate budget.
- No generic application-environment generator.

## Identity

- Plan: `project/2026-07-14-managed-dev-process-plan.md`
- Branch: `codex/managed-dev-process`
- Base: `origin/main` at `4a7b04b`
- Target: `main`
- Downstream: KlickerUZH draft PR #5169.

## Decisions

- Devrouter publishes a Linux-only `devrouter-process` executable in the existing npm package.
- The helper owns locking, state, PID/PGID proof, fingerprinted reuse, bounded group replacement, logs, and foreign-process refusal.
- Callers provide one process name, one conservative process match, an optional runtime fingerprint, and the command after `--`.
- Devrouter's generated devcontainer installs the pinned package and uses the helper.
- HTTP readiness remains owned by host-side `devrouter workspace ensure`; the helper checks process ownership only.
- Klicker keeps a thin `post-start.sh` for its origins and environment, but deletes its generic supervisor and supervisor tests.

## Research

- Local evidence: Devrouter's scaffold currently emits a `pgrep` plus `setsid` startup script without ownership or locking.
- Local evidence: Klicker PR #5169 carries a hardened 170-line implementation and 118-line regression test for the same generic responsibility.
- Local evidence: Devrouter 0.0.29 already probes every configured HTTP route and spends one bounded container recreate when a live application is unhealthy.
- External research: none needed; behavior is Linux process lifecycle and existing repository policy.

## Review

- Plan review: handled directly because the extraction is narrow and the user approved the module boundary on 2026-07-14.
- Final review: fresh correctness, simplification, security, maintainability, and package-content checks before publication.

## Progress

- Current: plan approved; implementation not started.
- Next: Slice 1, reusable helper and generated scaffold integration.

## Slice 1: reusable managed process

- Do: add packaged helper; adapt generated Dockerfile and post-start scaffold; move lifecycle regression coverage to Devrouter.
- Check: focused process tests in Linux, scaffold tests, typecheck, Biome, package-content inspection.
- Commit: `feat(process): add managed dev-process helper`.

## Slice 2: release 0.0.30

- Do: version, lockfile, changelog, docs, and one upgrade prompt; document the small caller interface and Linux requirements.
- Check: full test, typecheck, build, docs policy, Knip, package smoke, `git diff --check`.
- Commit: `chore(release): prepare 0.0.30`.

## Downstream gate

- Upgrade Klicker draft PR #5169 to 0.0.30.
- Delete `.devcontainer/dev-process.sh` and `.devcontainer/test-dev-process.sh`.
- Keep only Klicker origins/environment plus `pnpm run dev:container` in `post-start.sh`.
- Validate cold start, exact Git/workspace identity, all ten routes, delegated login, and warm container/process reuse.

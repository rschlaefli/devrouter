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
- Devrouter's generated devcontainer extracts only the helper from the exact package tarball and uses it without installing the CLI dependency tree.
- HTTP readiness remains owned by host-side `devrouter workspace ensure`; the helper checks process ownership only.
- Klicker keeps a thin `post-start.sh` for its origins and environment, but deletes its generic supervisor and supervisor tests.

## Research

- Local evidence: Devrouter's scaffold currently emits a `pgrep` plus `setsid` startup script without ownership or locking.
- Local evidence: Klicker PR #5169 carries a hardened 170-line implementation and 118-line regression test for the same generic responsibility.
- Local evidence: Devrouter 0.0.29 already probes every configured HTTP route and spends one bounded container recreate when a live application is unhealthy.
- External research: none needed; behavior is Linux process lifecycle and existing repository policy.

## Review

- Plan review: handled directly because the extraction is narrow and the user approved the module boundary on 2026-07-14.
- Security: no high-confidence vulnerability found. Repository-owned package scripts and the installed semver are shell-quoted, process commands stay argv arrays, regexes are arguments rather than shell fragments, and foreign process groups fail closed.
- Maintainability: the first release draft installed the full CLI dependency tree for one shell helper. The generated image now extracts only that executable from the exact package tarball; no new config schema or application-health abstraction remains.
- Final evidence: pinned Node 24/pnpm 11 passes docs policy, Biome, Knip, TypeScript, 352/352 Vitest tests, build, ShellCheck, `git diff --check`, and Opengrep with 0 findings. The extracted-helper Linux regression passes the complete lifecycle suite.

## Progress

- Current: implementation, release artifacts, and final review complete.
- Next: publish and merge the Devrouter PR, release 0.0.30, then complete the downstream Klicker gate.

## Slice 1: reusable managed process

- Do: add packaged helper; adapt generated Dockerfile and post-start scaffold; move lifecycle regression coverage to Devrouter.
- Check: focused process tests in Linux, scaffold tests, typecheck, Biome, package-content inspection.
- Result: `devrouter-process ensure` now hides locking, state validation, PID/PGID ownership, fingerprinted reuse, bounded group replacement, logging, and foreign-process refusal behind one command. Generated devcontainers extract only the helper from the exact Devrouter package tarball and call it with their inferred pnpm dev command.
- Evidence: Linux regression passes concurrent start, exact reuse, explicit/default fingerprint changes, workspace change, stale and malformed state, TERM escalation, and foreign-process refusal. Full Vitest passes 352/352; Biome, Knip, TypeScript, build, docs policy, ShellCheck, package manifest inspection, Opengrep, and `git diff --check` pass. The npm tarball includes executable `bin/devrouter-process`.
- Review: direct correctness and simplification pass kept HTTP health and recreate policy in `workspace ensure`, removed repository-specific lifecycle code from the generated scaffold, and retained no new config schema.
- Commit: `feat(process): add managed dev-process helper`.

## Slice 2: release 0.0.30

- Do: version, lockfile, changelog, docs, and one upgrade prompt; document the small caller interface and Linux requirements.
- Check: full test, typecheck, build, docs policy, Knip, package smoke, `git diff --check`.
- Result: release 0.0.30 documents and packages the managed-process helper, updates generated devcontainer guidance, and leaves route readiness in `workspace ensure`.
- Evidence: pinned Node 24/pnpm 11 full gate passes docs policy, Biome, Knip, TypeScript, 352/352 Vitest tests, build, and `git diff --check`. Opengrep reports 0 findings. A clean Node 24 Debian container installed the exact 0.0.30 tarball, resolved `/usr/local/bin/devrouter-process`, and passed the complete Linux lifecycle regression through the packaged executable.
- Note: the clean npm install reports an existing transitive `uuid@10` deprecation and pending optional install-script notices; neither affects the packaged shell executable or this branch's dependency graph.
- Review cleanup: the generated image now extracts only the shell helper from the exact tarball; it no longer installs the full CLI dependency tree or its transitive install scripts.
- Commit: `chore(release): prepare 0.0.30`.

## Downstream gate

- Upgrade Klicker draft PR #5169 to 0.0.30.
- Delete `.devcontainer/dev-process.sh` and `.devcontainer/test-dev-process.sh`.
- Keep only Klicker origins/environment plus `pnpm run dev:container` in `post-start.sh`.
- Validate cold start, exact Git/workspace identity, all ten routes, delegated login, and warm container/process reuse.

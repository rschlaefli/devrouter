# HTTP readiness leaf pin plan

## Identity and scope

- Date: 2026-08-21.
- Repository: `/Users/rschlae/Git/personal/devrouter`.
- Branch: `rs/http-readiness-leaf-pin`.
- Worktree: `/Users/rschlae/Git/personal/devrouter/trees/rs-http-readiness-leaf-pin`.
- Base and target: `origin/main` at `6ee4707cf372d25ddeb714e3fe1b779b484f3a6f` -> `main`.
- Pull request: draft [#32](https://github.com/rschlaefli/devrouter/pull/32),
  targeting `main`; merge remains outside this task.

This package repairs the host-side HTTPS readiness verifier used by
`devrouter ensure` and `repo devcontainer verify`. The macOS SecureTransport
curl in the P5 evidence run rejected the valid mkcert root with curl (60)
`SSL certificate problem: out of memory`, while native browser trust,
`security verify-cert`, OpenSSL, and Node HTTPS accepted the same route. Curl
accepted the exact certificate mounted and served by Traefik. The readiness
probe therefore pins its local TLS check to that served leaf without changing
the synchronous API or the route status contract.

The package does not start a runtime, rebuild or retry P5, install trust,
touch providers or secrets, access production, crawl content, clean state, or
delete any checkout. Existing dirty devrouter and provider worktrees remain
out of scope.

## Ownership and freshness

- `git fetch origin` is unavailable because the primary repository's
  `.git/FETCH_HEAD` is not writable. `git ls-remote origin refs/heads/main`
  confirmed the exact base above immediately before worktree creation.
- The primary checkout is on the same `main` head and retains untracked
  `.pnpm-store/` artifacts; it is not an implementation workspace.
- No open PR or clean existing branch owns `http-route-probe.ts`.
- The dirty `rs/runtime-evaluate-lifecycle` worktree has no probe diff and is
  preserved untouched. Historical route-recovery and lifecycle branches are
  merged or stale and are not reused.

## Planner disposition

The required native planner review returned `DONE_WITH_CONCERNS` and accepted
the direct leaf-pin design:

- Keep the synchronous curl probe and all current flags, timeout, hostname/SNI
  verification, result shape, `100..499` success range, and error details.
- Keep `getMkcertRootCAPath({ repoPath })` as the setup/preflight validation
  path, but pass the exported `CERT_FILE` leaf to curl.
- Do not widen this package into an async Node HTTPS rewrite or caller API
  change.
- Do not update lifecycle knowledge or add an ADR; their lifecycle and public
  contracts remain unchanged. The plan records this no-knowledge-impact
  disposition.

## Slices

### S0 — reviewed plan and ownership freeze

Create this plan and its active project-index entry from the exact verified
base. Confirm no overlap before source edits.

Acceptance: the plan, branch, worktree, target, no-runtime boundary, and
planner corrections are explicit; `git status` contains only the intended
plan changes.

Commit: `docs(project): plan HTTP readiness leaf pin`.

### S1 — trusted HTTPS readiness repair

Change `src/core/http-route-probe.ts` to retain mkcert setup validation while
passing `CERT_FILE` to `curl --cacert`. Add a concise maintainer comment that
the served leaf is deliberate certificate pinning for the local Traefik route.
Strengthen `src/core/__tests__/http-route-probe.test.ts` to require the exact
leaf path, prove the root path is not passed, retain the no-`-k` assertion,
preserve `HTTP 404` and `HTTP 503` behavior, and preserve curl failure
diagnostics. Add one concise unreleased changelog entry.

Acceptance: focused route-probe, devcontainer-verify, and workspace-ensure
tests pass; no caller API or non-TLS behavior changes; `git diff --check`
passes.

Commit: `fix(readiness): pin HTTPS probe to served certificate`.

This slice stays in the main session because its trust-path edit and tightly
coupled tests are smaller than a disjoint executor handoff. A simplifier is
not required unless the diff grows beyond the direct pin. A slice reviewer
must inspect the committed range with correctness and TLS-security lenses.

## Verification and finish gate

Run from the exact branch after each relevant commit:

```sh
pnpm exec vitest run src/core/__tests__/http-route-probe.test.ts src/core/__tests__/devcontainer-verify.test.ts src/core/__tests__/workspace-ensure.test.ts
pnpm check:docs-policy
pnpm check:knowledge
pnpm check
pnpm knip
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
git diff --check
```

The focused tests are the acceptance gate for the repair. The full sequence
is exact-head evidence; it must not be replaced by the prior runtime result.
No new runtime, browser, provider, ingestion, or model proof is allowed in
this package. The final reviewer inspects the integrated committed range only
after fresh verification and before any completion or PR-readiness claim.

The branch is published only to `origin` as `rs/http-readiness-leaf-pin`, and
draft PR #32 targets `main`. Exact-head CI is required before merge; this task
does not merge, deploy, or alter the existing dirty worktrees.

## Progress

- `2026-08-21`: Fresh `origin/main` was confirmed with `git ls-remote`; the
  isolated worktree was created from `6ee4707` after proving no writer overlap.
- `2026-08-21`: Native planner review completed with `DONE_WITH_CONCERNS` and
  the leaf-pin correction was adopted. Source edits and runtime proof remain
  pending.
- `2026-08-21`: The focused route-probe, devcontainer-verify, and
  workspace-ensure suite passed (45 tests); Biome, docs policy, knowledge,
  typecheck, and diff checks also passed. No runtime was started.
- `2026-08-21`: Exact-head verification passed: 588 Vitest tests, with the
  macOS `/proc`-dependent process test explicitly skipped, plus build,
  package smoke, docs policy, knowledge, Biome, Knip, typecheck, and diff
  checks. The configured slice-reviewer route rejected its available
  reasoning configuration; the native fallback review passed with no
  correctness or TLS-security findings. The native final reviewer also
  passed the committed implementation range. No runtime or browser proof was
  rerun.
- `2026-08-21`: Published `rs/http-readiness-leaf-pin` to `origin` and opened
  draft PR #32 against `main`. CI run `32491618356` passed at head `709e3a3`;
  the PR remains draft and unmerged.

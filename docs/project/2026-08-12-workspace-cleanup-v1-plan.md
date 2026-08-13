# Devrouter workspace cleanup v1

## Problem

Managed linked workspaces expose separate ownership, checkout, provider, route,
and garbage-collection evidence, but no report-only command joins that evidence
into a safe cleanup decision. The new command must help an operator decide what
to inspect next without changing runtime, Git, route, or ledger state.

## Evidence

- Repository: `/Users/rschlae/Git/personal/devrouter`.
- Branch: `rs/workspace-cleanup-v1`.
- Manual worktree: `/Users/rschlae/Git/personal/devrouter/trees/rs-workspace-cleanup-v1`.
- Base: verified `origin/main` at `57e9749b86e8afeb41f850bd7fdbbeb99826880c`.
- Primary checkout was clean and two commits behind `origin/main` before this
  worktree was created. The primary checkout remains untouched.
- Existing authority: `src/core/workspace-ownership.ts` owns durable owner
  records and `present|missing|locked|conflict`; `src/core/workspace-gc.ts`
  owns exact ledger-scoped GC; `src/core/workspace-lifecycle.ts` owns stop/down;
  `src/core/devpod-workspaces.ts` is the provider listing boundary.
- The existing `listHostRouteState()` path is not suitable for this command:
  it may create directories, acquire locks, and repair or migrate route state.
  Cleanup therefore needs a separate strictly read-only route snapshot adapter.

## Decision

Add:

```text
devrouter workspace cleanup --repo . --inactive-for 30d --check-merged --json
```

The command is report-only. It has no `--yes` and never mutates DevPod,
routes, ownership records, Git, Docker, application processes, worktrees, or
branches. Existing `workspace gc`, `workspace down`, and ownership/provider
ordering remain unchanged.

### Primitive impact

| Product primitive | Disposition | Contract delta | Compositions and consumers | Evidence |
| --- | --- | --- | --- | --- |
| Managed workspace identity | reuse | Keep the Git-common-dir ownership record as the exact path, workspace, branch, and DevPod registration owner. | `workspace cleanup`, `gc`, `down`, `ensure` | `workspace-ownership.ts` remains authoritative. |
| DevPod registration | extend | Report registration separately from actual runtime state; registration alone never proves that Docker/provider resources still exist. | cleanup report and exact lifecycle revalidation | `devpod list` can retain a workspace after its Docker resources were stopped or pruned. |
| Managed runtime state | extend | Add `running|stopped|busy|not-found|absent|unknown` from `devpod status`; `not-found` is positive stale-runtime evidence, while `unknown` is reserved for an unavailable or malformed probe. | activity/suggestion guards and stale-registration repair | Local probes on 2026-08-13 returned `Running`, `Stopped`, and `NotFound` for registered Docker workspaces. |
| Cleanup advice | compose | Combine ownership, registration, runtime, routes, checkout, activity, and integration without adding a second mutation path. | human/JSON report; existing `workspace gc/down` commands | Existing lifecycle commands retain final exact-owner checks. |

The 2026-08-13 extension stays in this branch because it completes the same
unpublished cleanup contract. The prior integrated-final budget is exhausted.
After an explicit scope/risk reassessment, the user authorized one exceptional
third integrated-final review for the existing `workspace-cleanup-v1` package;
changing the package key does not reset that history or budget.

Only managed linked workspaces represented by the DevPod/route/ownership
surfaces are included. Direct `runtime: docker` cleanup is outside this
command.

## Report contract

Use one stable row shape for human and JSON output. Keep these fields
orthogonal rather than deriving one state from another:

- workspace identity: `workspace`, `branch`, `repo`, `worktreePath`,
  `devpodId`;
- ownership: `present|missing|locked|conflict`;
- provider registration: `owned|absent|conflict|unknown`;
- runtime: `running|stopped|busy|not-found|absent|unknown`;
- checkout: `clean|dirty|missing|detached|unknown`;
- activity: `recent|quiet|unknown`, `cutoff`, `latestTimestamp`, and ordered
  `contributingEvidence`;
- integration: `merged-exact|on-target|patch-equivalent|not-verified|unknown`;
- `eligibleActions`, `suggestions`, and ordered human-readable `reasons`.

Nullability and enum values are explicit and versioned in the report types.
Rows and evidence arrays have deterministic ordering. Human output labels the
same concepts and exact commands that JSON carries.

### Activity

- Default inactive duration is `30d`.
- Accept a small dependency-free syntax: positive integer plus one unit from
  `s`, `m`, `h`, `d`, or `w`; reject zero, negative, fractional, compound,
  malformed, or unknown units.
- Use only valid exact timestamps from, in precedence-independent newest-first
  evaluation: DevPod `lastUsed`, route `updatedAt`, ownership `updatedAt`, and
  Git HEAD committer date.
- The newest valid timestamp is the report’s `latestTimestamp`; every source at
  that timestamp contributes to `contributingEvidence`.
- A recent trustworthy signal vetoes `quiet`. If no valid signal exists,
  activity is `unknown`, not quiet. Missing, malformed, or unavailable sources
  remain unknown at the smallest affected field.
- Filesystem mtimes and remote-branch absence are never activity evidence.
- Document that DevPod `lastUsed` can be absent, provider-version dependent, or
  unrelated to every runtime interaction, so activity is advisory only and
  does not replace the revalidation in `gc`/`down`.
- Always inspect local DevPod registration and `lastUsed`; `--check-merged`
  controls only remote Git/forge calls. Probe exact registered workspaces with
  `devpod status --output json --timeout 5s` so stopped or pruned Docker state
  is reported explicitly. A failed or malformed status probe remains
  `unknown` and suppresses destructive advice.

### Integration and forge checks

`--check-merged` alone enables read-only remote/forge checks. Without it, the
command must not invoke `gh`, `glab`, or any network-capable probe.

- Discover the `origin` URL and default target conservatively from local Git
  configuration. Support only explicit HTTPS/SSH GitHub and GitLab URL forms;
  unsupported, ambiguous, or missing forms are `unknown`.
- For freshness, resolve the selected target with a read-only remote probe,
  compare its SHA with the local remote-tracking target ref, and only then use
  local ancestry. A stale, missing, deleted, malformed, or unavailable remote
  is `unknown`.
- Use host `gh`/`glab` only for the matching forge and parse strict synthetic
  JSON schemas. Never print credentials, tokens, private URLs, or raw provider
  payloads.
- `merged-exact` requires a merged same-repository GitHub PR/GitLab MR whose
  recorded source-head SHA equals the current workspace HEAD SHA.
- `on-target` requires the current HEAD to be an ancestor of the explicitly
  verified-fresh remote target SHA.
- `patch-equivalent` is advisory only. Require at least one unique source
  commit, locally available source objects, a verified common base, and
  equivalent aggregate patches using stable patch IDs for the source range and
  the current range. Never produce a full-removal suggestion from this state
  alone.
- A missing or deleted source remote never counts as integration evidence.
- Unauthenticated, stale, unavailable, malformed, or unsupported checks become
  `unknown`; successful local Git evidence without a verified forge/remote
  check is `not-verified` rather than merged.

### Suggestion truth table

Suggestions are exact commands plus an explicit reason. A suggestion requires
all relevant identity and safety evidence; unknown evidence suppresses it.

| Evidence | Suggestion | Guard and explanation |
| --- | --- | --- |
| Exact ownership is `missing` | `devrouter workspace gc --repo <repo> --yes` | Only the existing exact ledger GC path is suggested; no Git/worktree/branch removal is implied. |
| Exact managed owner is `present`, activity is `quiet`, checkout is `clean`, and provider/route identity is owned and non-conflicting | `devrouter workspace down <workspace> --keep-worktree --repo <repo>` | State clearly that this deletes DevPod/runtime data while preserving the worktree and owner record. |
| Exact managed owner is `present`, checkout is `clean`, unlocked, provider/route identity is owned and non-conflicting, and integration is `merged-exact` for current HEAD | `devrouter workspace down <workspace> --repo <repo>` | Full down retains its own clean/unlocked/ownership revalidation; the report never removes branches. |
| Dirty, locked, conflict, detached, changed, provider-unknown, route-unknown, activity-unknown, integration-unknown/not-verified/patch-equivalent, or incomplete exact identity | none | Explain the specific blocker; do not emit a destructive command. |

Runtime `running`, `stopped`, and `not-found` are actionable only when the
DevPod registration is exactly owned. `busy` and `unknown` suppress advice.
For `not-found`, existing exact `workspace gc/down` deletion uses this locked
sequence: exact registration; ordinary `devpod delete <id>
--ignore-not-found`; exact registration still present; strict status response
with the expected ID and `NotFound`; exact ownership revalidation; `devpod
delete <id> --force --ignore-not-found`; registration absent. ID mismatch,
reassignment, malformed output, `Busy`, or unavailable status fails closed
before routes or ownership records change.

The missing-owner GC suggestion is the only suggestion that can be emitted
without a present linked checkout. No suggestion ever deletes a branch.

## Test portfolio

| Risk/behavior | Test obligation | Primary stable seam | Distinct failure caught |
| --- | --- | --- | --- |
| Duration parsing and cutoff | `add new` | Pure duration parser | Wrong default or acceptance of malformed/ambiguous syntax. |
| Activity precedence and unknown handling | `add new` | Pure evaluator with injected timestamps | Filesystem or invalid signals influence activity, or a newer trustworthy signal is ignored. |
| Checkout blockers and exact identity | `extend existing` plus focused additions | Synthetic Git/ownership/provider fixture | Dirty, locked, detached, missing, conflict, or non-exact ownership permits unsafe advice. |
| Exact merged head and squash/patch equivalence | `add new` | Injected Git/forge adapter | A merged PR/MR is accepted without exact SHA, or conservative patch equivalence overclaims. |
| Fresh target and missing/stale remote | `add new` | Injected remote/Git adapter | Stale local tracking refs or deleted source remotes count as proof. |
| GitHub/GitLab parsing and privacy | `add new` | Synthetic CLI JSON parser | Provider payload variation, malformed JSON, auth errors, or private data leaks. |
| Human/JSON output | `add new` | Formatter/command handler | Fields are omitted/conflated or commands/reasons differ by output mode. |
| Report-only side effects | `add new` | Built-CLI subprocess with spies and hashes | Cleanup invokes mutations or network without the opt-in flag, or changes files while reporting. |
| DevPod registration versus runtime | `add new` | Synthetic `devpod list/status` adapter and real CLI fixture | A registered but stopped/pruned workspace is reported unknown or mistaken for a live runtime. |
| Stale DevPod metadata repair | `add new` | Existing exact mutation lifecycle | `gc/down` cannot remove registration after Docker prune, or force deletion runs without exact `NotFound` proof and postcondition. |
| Integration ordering | `extend existing` | Synthetic Git/forge command runner | `on-target` bypasses forge/source verification or a deleted source branch counts as integrated. |
| Remote-call allowlist | `extend existing` | Built-CLI PATH-shim smoke | `git ls-remote` or forge argv escapes capture, or a mutating command appears. |

## Implementation slices

### Slice 1 — Read-only evidence adapters and report core

- `Route: main`. Cross-system identity, activity confidence, forge semantics,
  and the report-only boundary are architecture and data-integrity decisions.
- `Do:` Add a focused cleanup core and explicit adapter interfaces for clock,
  Git, provider, route snapshot, ownership, remote, and forge evidence.
- `Do:` Add a route snapshot reader that reads existing canonical/compatibility
  state without mkdir, lock, migration, repair, atomic publication, or writes.
  Preserve existing route-state behavior for every other command.
- `Do:` Extend or isolate provider parsing so optional valid `lastUsed` is
  reported without changing provider mutation or ownership ordering. Invalid
  provider records produce unknown evidence, not a guessed timestamp.
- `Do:` Implement duration, activity, checkout, exact identity, integration,
  suggestions, deterministic ordering, and privacy-safe failure mapping.
- `Do:` Implement strict GitHub/GitLab schemas, supported URL parsing,
  verified-fresh target checks, exact source-head matching, and conservative
  aggregate patch equivalence behind `checkMerged`.
- `Check:` Focused core tests for all rows in the portfolio. Synthetic fixtures
  must cover GitHub and GitLab, exact merge, squash/patch-equivalent, stale and
  missing remotes, malformed/unauthenticated providers, activity precedence,
  blockers, and no-side-effects at the adapter seam.
- `Commit:` `feat(workspace): add report-only cleanup evidence`.
- `Intermediate review:` required — cross-system and destructive-suggestion
  seam. Run exactly one `intermediate-reviewer` plus exactly one `simplifier`
  in parallel on the same immutable committed range before integration.

### Slice 2 — CLI command and stable output

- `Route: executor` after native executor availability is confirmed. If the
  configured executor cannot be proven, use the documented native Terra xhigh
  fallback; the main session owns integration and verification.
- `Do:` Register `workspace cleanup` with `--repo`, `--inactive-for` defaulting
  to `30d`, `--check-merged`, and `--json`. Do not expose `--yes`.
- `Do:` Keep `workspace gc` registration and implementation unchanged. Wire the
  handler only to the report-only core and render the same orthogonal values,
  exact suggestions, and reasons in human and JSON formats.
- `Check:` Command tests, CLI help, built-CLI report-only smoke, and captured
  mutation/network calls. With no `--check-merged`, assert zero forge calls.
- `Commit:` `feat(workspace): expose cleanup report command`.
- `Intermediate review:` not required if Slice 1’s review remains applicable
  and this slice only wires the settled core; re-arm it if core semantics or a
  risk boundary changes.
- `Simplifier:` required for substantive executable/test changes, with the
  exact committed range and changed-hunk manifest.

### Slice 3 — Synchronized guidance and release notes

- `Route: budget-worker` for disjoint mechanical documentation edits after the
  command wording is final; hosted review receives no secrets, credentials,
  private URLs, PII, or production data. Main session owns final synchronization.
- `Do:` Update the exact affected authorities: root `AGENTS.md` command surface
  and current product model; `docs/project/index.md`; the active roadmap
  `docs/project/2026-02-07-devrouter-roadmap.md`; lifecycle knowledge;
  `docs/REPO_ONBOARDING.md`; `examples/workspace/README.md`; generated guidance
  source `src/core/agents-md.ts` and its tests; `src/core/ai-prompt.ts` and its
  tests; `.agents/skills/devrouter/SKILL.md`; and `CHANGELOG.md` Unreleased.
- `Do:` Document lastUsed blind spots, advisory activity, `--check-merged`
  network scope, no `--yes`, exact suggestion guards, privacy boundaries, and
  unchanged GC/down semantics. Do not add a version prompt or bump versions
  unless a repository policy check proves it is required.
- `Check:` Docs policy, knowledge check, prompt consistency, generated-guidance
  tests, link/command-surface checks, and exact documentation diff inspection.
- `Commit:` `docs(workspace): document cleanup report contract`.
- `Intermediate review:` not required — documentation-only slice.
- `Simplifier:` not applicable — documentation-only slice.

### Slice 4 — Integrated verification and final review

- `Route: main`. Integration, scope hygiene, proof of no side effects, and
  final readiness stay with the orchestrator.
- `Do:` Run focused checks first, then `pnpm check:docs-policy`,
  `pnpm check:knowledge`, `pnpm check`, `pnpm knip`, `pnpm typecheck`,
  `pnpm test`, `pnpm build`, and the safe report-only CLI smoke.
- `Do:` The subprocess smoke uses an isolated `HOME`, disposable Git repo,
  PATH-stubbed `devpod`, `gh`, and `glab`, synthetic ownership/route files,
  captured argv, and pre/post filesystem hashes. It asserts no forge calls
  without `--check-merged`, only approved read-only calls with it, and byte-
  identical Git metadata, ownership ledger, route state, provider fixtures, and
  worktree after both modes. No destructive lifecycle or live network smoke is
  run; record the lifecycle-smoke waiver because existing GC/down/provider
  semantics are out of scope.
- `Do:` Inspect the exact diff and staged content for credentials, tokens,
  private URLs, PII, raw exports, or unrelated changes. Persist planning,
  intermediate, simplifier, and final reports in the gitignored
  `docs/project/_local/reviews/` directory.
- `Do:` Before integrated-final dispatch validate `gate=integrated-final`,
  `package_key`, sanitized `scope_key`, exact paths, exact identity, attempt,
  applicable lenses (correctness/plan, maintainability, security, and
  architecture/data flow), and intermediate evidence. Use one configured
  read-only reviewer; allow at most one correction review for this package.
- `Check:` Completion checklist against every contract item, final reviewer
  verdict, clean Git status, committed branch, no prohibited side effect, and
  limitations recorded.
- `Commit:` Any verified reviewer correction is a conventional follow-up. Do
  not push, create/update a PR, merge, release, deploy, publish, remove the
  worktree, or delete the branch.

### Slice 5 — Read-only runtime reconciliation and review corrections

- `Route: main`.
- `Execution-tier skip reason: critical-path coupling` — registration/runtime
  semantics, integration ordering, and subprocess proof share one fail-closed
  report seam.
- `Do:` Always load local DevPod registration and activity; add strict runtime
  status parsing/probing; report stopped/pruned resources without guessing.
- `Do:` Query source/forge evidence before selecting `merged-exact` or
  `on-target`, keeping missing source refs and unavailable forge checks
  fail-closed.
- `Do:` Expand the subprocess smoke with a logging Git shim, synthetic origin,
  DevPod list/status fixtures, forge response, exact read-only command
  allowlist, and pre/post state hashes.
- `Do:` Assert exact call order: default mode uses only local Git, DevPod list,
  and exact DevPod status; merged mode additionally permits only `git
  ls-remote` and the matching read-only forge list command.
- `Check:` Focused cleanup and DevPod tests; built CLI smoke; runtime-field
  output tests; exact per-mode command allowlists and unchanged-state hashes.
- `Commit:` `fix(workspace): reconcile cleanup runtime evidence`.
- `Slice review:` required — cross-system runtime truth and integration seam.
- `Simplifier:` required — substantive executable/test slice; run in parallel
  with the slice reviewer on the immutable commit.

### Slice 6 — Harden stale DevPod registration deletion

- `Route: main`.
- `Execution-tier skip reason: critical-path coupling` — exact ownership,
  provider mutation, and postcondition ordering form one destructive seam.
- `Do:` Preserve ordinary exact deletion; only when registration remains,
  require strict expected-ID `NotFound`, revalidate exact ownership, retry
  `--force --ignore-not-found`, and require registration absence before routes
  or ledger mutation.
- `Check:` Focused DevPod mutation, GC, and lifecycle tests covering every
  sequence step and fail-closed case; no real cleanup run.
- `Commit:` `fix(workspace): delete stale DevPod registrations safely`.
- `Slice review:` required — destructive fallback and data-loss boundary.
- `Simplifier:` required — substantive executable/test slice; run in parallel
  with the slice reviewer on the immutable commit.

### Slice 7 — Extension guidance and finish

- `Route: main`.
- `Execution-tier skip reason: critical-path coupling` — synchronized
  agent-facing guidance and final evidence must match the reviewed contract.
- `Do:` Update affected command/lifecycle documentation and this progress
  record; preserve report-only semantics and distinguish registration from
  runtime state.
- `Check:` Full repository validation, expanded smoke, safe real-machine
  default report with state hashes, then a controlled report-only
  `--check-merged` run after synthetic remote/forge proof. No suggested command
  is executed. Run the explicitly authorized exceptional third integrated-final
  review for `workspace-cleanup-v1` after recording the scope/risk reassessment.
- `Commit:` `docs(workspace): document runtime cleanup evidence` plus any
  verified correction commit.
- `Slice review:` not required for documentation-only changes.
- `Simplifier:` not applicable for documentation-only changes.

## Non-goals

- No edits in the primary checkout and no Codex-native worktree.
- No push, PR/MR, merge, release, deployment, publication, real cleanup,
  worktree removal, or branch deletion. No new mutation entrypoint; `gc` and
  `down` remain the sole callers and inherit the hardened exact-delete behavior.
- Automated forge checks use synthetic GitHub/GitLab CLI JSON. A controlled
  live report-only `--check-merged` machine trial is allowed only after the
  synthetic allowlist and unchanged-state smoke pass.
- No filesystem mtime activity, remote-branch absence inference, or secret/
  private-URL output.

## Progress

- `2026-08-13`: Slices 5-7 completed. Commit `356c0dd` always reconciles local
  DevPod registration with bounded exact runtime status, reports pruned Docker
  resources as `not-found`, moves source/forge proof ahead of integration
  classification, and expands the subprocess allowlist smoke. Commit `a611148`
  hardens exact deletion with ordinary delete, expected-ID `NotFound` proof,
  ownership revalidation, force retry, and absent-registration postcondition.
  Commits `7b3556c` and `d81c51b` synchronize guidance, accepted simplifications,
  and bounded smoke behavior. Both slice reviews returned `DONE`; simplifiers
  proposed two accepted private-surface reductions.
- `2026-08-13`: Fresh verification passed 82 cleanup/DevPod/GC/lifecycle/agent
  tests plus 10 destructive-seam tests (one unrelated host process-identity
  test skipped in the restricted sandbox), docs policy, Biome, Knip, TypeScript,
  build, and the synthetic no-state-change smoke. The unrestricted full suite
  remains unavailable in this sandbox because process-birth identity cannot be
  read; 529 tests passed and 33 existing lock-dependent tests failed for that
  single environmental reason. A safe real-machine Klicker report classified
  31 owned registrations as 3 running, 1 stopped, and 27 not-found, with 2
  absent; zero runtime states were unknown and zero actions were executed. A
  controlled `--check-merged` report remained fail-closed because 20 source
  branches were absent and 11 forge queries were unavailable; ownership and
  route hashes were identical before and after both reports.

- `2026-08-13`: Reopened before publication after a real-machine report and
  two-axis review. Default mode reported all 33 Klicker providers as unknown;
  the implementation gated local DevPod evidence behind `--check-merged`.
  Review also found `on-target` returned before forge/source verification and
  the subprocess smoke did not capture `git ls-remote`. Local DevPod probes
  established the missing runtime states: registered workspaces can be
  `Running`, `Stopped`, or `NotFound` after Docker cleanup. Slices 5-7 fold
  these findings into the existing branch. The user explicitly authorized one
  exceptional third integrated-final review after scope/risk reassessment; no
  cleanup command has been run.

- `2026-08-12`: Orientation complete. Primary `main` was clean and two commits
  behind `origin/main`; manual worktree created from verified `origin/main`.
- `2026-08-12`: Planning-stage reviewer `gpt-5.6-sol/high` completed with
  `DONE_WITH_CONCERNS`. Critical and high findings were incorporated: strict
  read-only route adapter, explicit forge/freshness/patch semantics,
  deterministic suggestion guards, subprocess no-side-effects proof, exact
  artifact paths, and ignored review storage. Reviewer report is recorded in
  `docs/project/_local/reviews/`.
- `2026-08-12`: Slice 1 implementation is committed as `159fa8e`. The
  report core is adapter-driven and report-only; route inspection does not
  create locks/storage or repair mirrors; Git read probes disable optional
  locks; provider `lastUsed` is optional and malformed values remain unknown;
  forge and freshness checks are opt-in and synthetic-testable. Focused
  verification passed: 39 tests across cleanup, route-state, DevPod, and
  ownership suites; TypeScript; Biome; and Knip.
- `2026-08-12`: Post-slice simplifier and intermediate review completed in
  parallel on `159fa8e`, both `DONE_WITH_CONCERNS`. Accepted corrections now
  gate the default provider probe, suppress activity cleanup suggestions when
  an explicit integration check is uncertain, restrict forge hosts, classify
  unsupported/missing/stale source evidence as unknown, resolve verified target
  ancestry before forge/source-branch checks, remove eager snapshots, and
  remove the unused formatter helper. Focused verification passed: 41 tests;
  Biome passed. Reports are recorded in `docs/project/_local/reviews/`.
- `Completed:` Reviewed safety corrections were committed before the CLI slice;
  the CLI and stable human/JSON output are now integrated.
- `2026-08-12`: Slice 2 CLI/report output is committed as `532709b`; focused
  command and core checks passed with 16 tests. The required simplifier review
  completed after one metadata-only dispatch block and one reconciled
  correction attempt; it found no justified reduction. Report:
  `docs/project/_local/reviews/2026-08-12-workspace-cleanup-v1-slice-2-simplifier.md`.
- `2026-08-12`: Advisor review found the initial patch-equivalence branch
  unreachable and allowed two failed patch probes to compare equal. The
  correction now requires a distinct current/source SHA, a present source
  remote matching the forge candidate, at least one unique source commit, and
  two defined equal stable patch IDs. Focused cleanup tests cover exact merge,
  missing/stale remotes, squash-style equivalence, and failed probes. Report:
  `docs/project/_local/reviews/2026-08-12-workspace-cleanup-v1-patch-equivalence-advisor.md`.
- `2026-08-12`: The correction intermediate review found two additional
  fail-closed gaps: exact merge evidence was not bound to the current source
  remote and verified target branch, and malformed successful patch/commit
  output could pass. The follow-up now binds both refs, validates patch IDs,
  rejects any malformed source commit line, and adds regression coverage.
  Review: `docs/project/_local/reviews/2026-08-12-workspace-cleanup-v1-patch-correction-intermediate.md`.
- `2026-08-12`: Integrated-final review found stale local default-target
  binding, unverified patch bases, an incomplete smoke manifest, and stale
  progress text. The follow-up now verifies remote/local target agreement,
  proves both patch ranges share the forge base, hashes route/provider/
  worktree fixtures, and closes the finish-gate progress after fresh checks.
  Review: `docs/project/_local/reviews/2026-08-12-workspace-cleanup-v1-integrated-final.md`.
- `Completed:` Integrated-final correction commit `57518f2` passed 23 focused
  cleanup tests, 552 full tests, docs policy, knowledge, Biome, Knip,
  TypeScript, build, and the expanded no-state-change report-only smoke.
  The one allowed correction review returned `DONE_WITH_CONCERNS` with all
  behavioral findings closed; the remaining concerns are synthetic-only forge
  evidence and the repository's known `/proc` process-test skip.
- `Finish status:` DONE_WITH_CONCERNS complete after the final plan-status
  commit; no prohibited side effect occurred, and no push, PR, merge, release,
  deployment, publication, worktree removal, or branch deletion was performed.

## Finish gate

Return one of `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`.
`DONE` requires every contract item, synchronized guidance, fresh focused/full
  verification, persisted required review artifacts, a committed clean branch,
  and no prohibited side effect. Report branch, worktree, commits, changed
  paths, examples, checks, review artifacts, limitations, and next step.

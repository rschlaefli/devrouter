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

Only managed linked workspaces represented by the DevPod/route/ownership
surfaces are included. Direct `runtime: docker` cleanup is outside this
command.

## Report contract

Use one stable row shape for human and JSON output. Keep these fields
orthogonal rather than deriving one state from another:

- workspace identity: `workspace`, `branch`, `repo`, `worktreePath`,
  `devpodId`;
- ownership: `present|missing|locked|conflict`;
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

## Non-goals

- No edits in the primary checkout and no Codex-native worktree.
- No push, PR/MR, merge, release, deployment, publication, real cleanup,
  worktree removal, branch deletion, or mutation of existing `workspace gc`.
- No live network tests. Forge checks use synthetic GitHub/GitLab CLI JSON.
- No filesystem mtime activity, remote-branch absence inference, or secret/
  private-URL output.

## Progress

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
- `Next:` Commit the reviewed safety corrections, then wire the CLI command and
  stable human/JSON output as Slice 2.
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
- `Next:` Commit the verified patch-equivalence correction and smoke harness,
  then run the full repository verification suite before integrated-final
  review.

## Finish gate

Return one of `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`.
`DONE` requires every contract item, synchronized guidance, fresh focused/full
  verification, persisted required review artifacts, a committed clean branch,
  and no prohibited side effect. Report branch, worktree, commits, changed
  paths, examples, checks, review artifacts, limitations, and next step.

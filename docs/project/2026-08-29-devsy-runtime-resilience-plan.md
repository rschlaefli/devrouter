# Devsy runtime resilience 0.0.46 - implementation plan

Date: 2026-08-29. Branch: `rs/devsy-runtime-resilience` at exact `origin/main`
`ddb7e99` (clean worktree). Target: `main`. PR: pending.

## Problem

Parallel `devrouter ensure` runs across agent worktrees collide on the
machine-global Devsy/DevPod mutation lock; the loser fails after a bounded
60-second wait with a bare "already running (PID x)". Cold Devsy starts can
legitimately exceed 60 seconds, so the bound is too short, and a silent wait is
indistinguishable from a hang. Separately, a failed `devsy workspace up` whose
stderr reports an agent-binary acquisition failure surfaces only a generic
wrapper message with no remediation pointer.

## Decision (user-approved 2026-08-29)

The earlier fair-queue idea is replaced by the simpler fix. Keep the existing
hard-link lock and contention error. Raise the provider-only wait, make the
wait observable, record acquisition time in the lock record, and capture/replay
Devsy startup stderr with a narrowly classified remediation hint. No FIFO
ticket queue, no `DEVSY_AGENT_PATH`, no download or cache logic.

## Execution contract

- Boundary owner: self.
- Granted: in-scope edits in the devrouter worktree (src/core, tests, this
  plan, knowledge docs, CHANGELOG, upgrade prompts, package version, example
  pins, SKILL/ai-prompt); repo-native checks and build; local commits on the
  branch; a retained /tmp Git fixture for the live trial; Klicker pin update in
  the clean `trees/devsy-profile-dogfood` worktree; exact-head push and draft
  PR after final review.
- Withheld: merge, publication (npm release), OrbStack restart, machine
  `--workspace-runtime` preference change, provider registry/workspace
  deletion, worktree or branch deletion, secret values, OpenRouter calls,
  network Devsy download attempts, `DEVSY_AGENT_PATH` support, FIFO queue
  implementation, Klicker v3 integration beyond the existing branch base.
- Terminal: exact-head CI reported on the draft PR, final review recorded,
  Klicker pin committed with bounded profile qualification evidence, and both
  Progress sections current. Merge and publication stay separately gated.
- Pause: Devsy runtime or OrbStack unhealthy at trial time; no verified
  official agent binary available and download blocked; required check
  failures not attributable to this branch.

## Research

- Evidence: `src/core/file-lock.ts` acquires via hard link with owner token
  `pid:base64url(birth):uuid`, reclaims stale locks only after dead or reused
  PID proof plus nlink check, polls every 20 ms until the `waitMs` deadline,
  and reports `<activity> is already running for <target> (PID <pid>)`.
- Evidence: `src/core/devsy-mutation.ts` and `devpod-mutation.ts` hold
  machine-global locks `~/.config/devrouter/{devsy,devpod}-mutation.lock`
  with `waitMs` 60_000. `startDevsyWorkspace` spawns `devsy workspace up`
  with `stdio: "inherit"` (quiet: `["inherit", 2, "inherit"]`), so provider
  stderr is visible but uncaptured. The failure message is generic; exact
  ownership re-read then classifies `DevsyStartPostconditionError`, which the
  DevPod adapter normalizes. `failedStartMayHaveAttached` fails closed on an
  unreadable registry.
- Evidence: ADR 0003 owns machine-global serialization; the lifecycle knowledge
  page documents the startup flow; the 60-second allocation lock for worktree
  creation is separate and out of scope.
- Evidence: baseline focused suites pass on `ddb7e99` (29 tests across
  file-lock, devsy-mutation, devpod-mutation, including one real cross-process
  serialization proof).
- Evidence: the PR-40 plan records `DEVSY_AGENT_BINARY` as Devsy's own knob
  (forwarded implicitly via environment) and the verified official v1.16.2
  binary requirement where downloads are blocked. `DEVSY_AGENT_PATH` does not
  exist anywhere in the tree.
- Limitations: no network documentation for Devsy; local CLI and source
  evidence only. Vitest `spawnSync` mocks cannot express live `stdio:
  "inherit"` capture, so diagnostic tests assert spawn options and error text
  while cross-process tests prove live behavior.

## Unclarities / grill pass

- Assumption: contention is a handful of parallel agents, not an unbounded
  fleet, so a long bounded wait beats fairness ordering. Risk: a very long hold
  delays every contender past the extended bound. Decision: extended bound plus
  observable progress and an actionable timeout message; the queue stays
  rejected as premature machinery.
- Risk: adding a fourth lock-record field could confuse older readers.
  Decision: append-only field; older readers already treat non-canonical
  records as live-conservative, so no cross-version regression.
- Decision: quiet mode keeps provider stderr flowing to fd 2, so captured
  diagnostics never silence provider output.

## Skill routing

Full path per `$rs-sliced-development-workflow`. The native planner route is
misconfigured (glm-5.3-flash rejects its configured effort), so the planning
pass used the documented clean-context Sol/xhigh continuity fallback. The
2026-08-29 design re-evaluation replaced the FIFO plan; the user approved the
substitution.

## Test portfolio

| Risk / behavior | Existing evidence | Test obligation | Primary seam | Distinct realistic failure | Owning slice |
| --- | --- | --- | --- | --- | --- |
| Waiter observes throttled progress while blocked on a live holder | none | add new (real cross-process) | file-lock acquire loop | silent multi-minute wait looks hung | S1 |
| Extended provider-only wait drains a realistic queue; non-provider locks unchanged | devpod-mutation cross-process test | extend existing | mutation wait constants and lock options | second ensure still fails during a cold start | S1 |
| Acquisition timestamp is recorded; legacy and malformed records stay live-conservative | file-lock ownership tests | extend existing | lock record parsing | timestamp parsing regresses PID-reuse reclaim | S1 |
| Timeout message carries held and waited durations | none | add new | timeout branch message | operator cannot tell stale from active holder | S1 |
| Devsy up stderr is replayed live; known acquisition failure appends the hint, unknown failures do not | devsy-mutation start failure tests | extend existing | `startDevsyWorkspace` stderr handling | hint noise on unrelated failures; hidden output in quiet mode | S2 |
| Typed postcondition classification unchanged | existing devsy/devpod tests | retain (keep passing) | `failedStartMayHaveAttached` selection | rollback misclassifies possibly-started runs | S2 |
| Release metadata consistency | ai-prompt test, docs-policy and knowledge checks | extend existing | release checklist gates | prompt or docs drift breaks the upgrade flow | S3 |
| Cross-process contention with progress on real Devsy | prior PR-40/45 trial procedure | add new (manual evidence) | /tmp fixture with built CLI | lab tests pass but real fleets still collide badly | S4 |
| Klicker profiles start under 0.0.46 | PR 5646-era evidence | extend existing (manual qualification) | Klicker clean worktree ensure | repin breaks consumer startup | S5 |

## Delegation map

| Workstream | Slices | Execution owner | Starts after | Done when |
| --- | --- | --- | --- | --- |
| Lock resilience | S1 | main | plan commit | focused plus cross-process tests green, commit |
| Devsy diagnostics | S2 | main | S1 | diagnostic tests green, commit |
| Release | S3 | main | S2 | full validation checklist green, release commit |
| Live proof | S4 | main | S3 | exact trial evidence in Progress |
| Consumer | S5 | main | S4 | Klicker pin committed with profile evidence |
| Delivery | S6 | main | S5 | draft PR open, exact-head CI reported, final review recorded |

All slices stay in main: the scope is a few hundred lines coupled to one lock
seam, and delegation costs more than the work (subagent provider pool is
credit-limited today).

## Plan slices

1. S1 - Observable bounded provider waits
   - Route: main
   - Acceptance: focused file-lock and mutation suites green including the new
     cross-process progress test; provider-only wait raised; lock-record
     timestamp parsed conservatively.
   - Do: add an optional throttled wait-progress callback to the acquire loop;
     append an acquisition timestamp to new lock records; extend the Devsy and
     DevPod mutation wait constants to 600_000 with a stderr progress reporter
     on those two locks only; extend the timeout message with held and waited
     durations when known; update the lifecycle knowledge page wording.
   - Files: `src/core/file-lock.ts`, `src/core/devsy-mutation.ts`,
     `src/core/devpod-mutation.ts`, their test files, a hold fixture if reuse
     is insufficient, `docs/knowledge/managed-environment-lifecycle.md`.
   - Check: focused vitest suites, `pnpm typecheck`, `pnpm check`.
   - Commit: `fix(workspace): make provider lock waits observable`
2. S2 - Devsy agent-acquisition diagnostics
   - Route: main
   - Acceptance: diagnostic unit tests green; postcondition classification
     tests unchanged and passing.
   - Do: pipe `devsy workspace up` stderr through a bounded buffer that
     replays to fd 2 in both modes; on nonzero exit, if the buffered stderr
     contains the known agent-binary acquisition failure, append remediation to
     the generic message: allow Devsy to download its agent or set
     `DEVSY_AGENT_BINARY` to a verified official binary matching platform and
     Devsy version. Classification logic stays untouched.
   - Files: `src/core/devsy-mutation.ts`,
     `src/core/__tests__/devsy-mutation.test.ts`.
   - Check: focused suite, `pnpm typecheck`, `pnpm check`.
   - Commit: `fix(devsy): surface agent acquisition diagnostics`
3. S3 - Release 0.0.46
   - Route: main
   - Acceptance: `pnpm check:docs-policy`, `pnpm check:knowledge`,
     `pnpm check`, `pnpm knip`, `pnpm typecheck`, `pnpm test`,
     `pnpm build`, `pnpm test:package`, `git diff --check` all green
     (Linux-only process-test skips on macOS are expected).
   - Do: bump the package version and example pins, add the CHANGELOG entry and
     `upgrade-prompts/0.0.46.md`, update SKILL/ai-prompt only where the
     user-visible surface changed, update Progress.
   - Files: `package.json`, `examples/*/.devrouter.yml`, `CHANGELOG.md`,
     `upgrade-prompts/0.0.46.md`, `.agents/skills/devrouter/SKILL.md`,
     `src/core/ai-prompt.ts` only if needed, this plan.
   - Check: the full checklist as stated.
   - Commit: `chore(release): prepare 0.0.46`
4. S4 - Exact live Devsy trial
   - Route: main
   - Acceptance: Progress records exact evidence: two-checkout contention with
     observed progress lines and both successes; cold start with exact
     ownership; canonical stop; zero routes for the exact hosts.
   - Do: fresh /tmp fixture with a unique token; built CLI;
     `DEVROUTER_WORKSPACE_RUNTIME=devsy` per invocation; if download is
     blocked, use the verified official binary via `DEVSY_AGENT_BINARY` when
     a verifiable copy exists; delete nothing.
   - Check: exact runtime state lines plus `devrouter ls --json` route count.
   - Commit: none; evidence rides with the S6 metadata commit.
5. S5 - Klicker repin and profile qualification
   - Route: main
   - Acceptance: pin commit in the clean Klicker worktree; ensure passes on the
     mcp, ai, and manage profiles under Devsy with readiness evidence; no
     machine-preference change.
   - Do: bump the `.devrouter.yml` version pin to 0.0.46; run ensures from the
     clean worktree; record evidence.
   - Check: `devrouter -V --repo .` reports 0.0.46; ensures green.
   - Commit: `chore(devrouter): pin 0.0.46` on the Klicker branch
6. S6 - Final review and draft PR
   - Route: main
   - Acceptance: final review recorded against the exact committed range;
     branch pushed; draft PR open with a whole-branch description and exact-head
     CI reported; plan renamed with the PR number in a metadata commit.
   - Do: integrated final review (continuity per routing if the native route is
     misconfigured); PR body via `$rs-mr-description-writer`; push and open
     the draft PR against `main`.
   - Check: `gh pr view --json` exact head and checks.
   - Commit: plan rename and Progress metadata.

## Progress

- 2026-08-29: Plan written and committed after user approval of the
  re-evaluated design. Baseline focused suites green on `ddb7e99`. Next: S1.

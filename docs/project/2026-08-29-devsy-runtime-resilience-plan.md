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

## Decision (user-approved 2026-08-29, evidence-corrected 2026-08-30)

Keep the existing hard-link lock, make waits observable, and capture/replay
Devsy startup stderr with a narrowly classified remediation hint. The first
live fleet trial disproved the retry-only assumption: two later mutations
overtook a 600-second waiter, and timestamps written before acquisition made
queue time look like lock-hold time. Provider mutations therefore use a small
arrival-order ticket queue, a thirty-minute bound, and timestamps written only
at successful lock acquisition. No `DEVSY_AGENT_PATH`, download, or cache logic.

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
  network Devsy download attempts, `DEVSY_AGENT_PATH` support, Klicker v3
  integration beyond the existing branch base.
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

- Evidence correction: the first live trial placed two clients behind a real
  fleet mutation; a later mutation overtook both, and one client exhausted the
  600-second bound. Decision: provider-only arrival ordering plus a thirty-minute
  bound is required; the queue is not used for short repository-local locks.
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
| Fair provider-only wait drains a realistic queue; non-provider locks unchanged | devpod-mutation cross-process test | extend existing | mutation wait constants and lock options | later mutations overtake a long-waiting ensure | S4 correction |
| True acquisition timestamp is recorded; legacy and malformed records stay live-conservative | file-lock ownership tests | extend existing | lock record parsing | queue time is misreported as holder time or PID-reuse reclaim regresses | S4 correction |
| Timeout message carries held and waited durations | none | add new | timeout branch message | operator cannot tell stale from active holder | S1 |
| Devsy up stderr is replayed live; known acquisition failure appends the hint, unknown failures do not | devsy-mutation start failure tests | extend existing | `startDevsyWorkspace` stderr handling | hint noise on unrelated failures; hidden output in quiet mode | S2 |
| Typed postcondition classification unchanged | existing devsy/devpod tests | retain (keep passing) | `failedStartMayHaveAttached` selection | rollback misclassifies possibly-started runs | S2 |
| Release metadata consistency | ai-prompt test, docs-policy and knowledge checks | extend existing | release checklist gates | prompt or docs drift breaks the upgrade flow | S3 |
| Cross-process contention with progress on real Devsy | prior PR-40/45 trial procedure | add new (manual evidence) | /tmp fixture with built CLI | lab tests pass but real fleets still collide badly | S4 |
| Klicker profiles start under 0.0.46 | PR 5646-era evidence | extend existing (manual qualification) | Klicker clean worktree ensure | repin breaks consumer startup | S5 |
| Detached managed state cannot strand a provider handoff | degraded-state fail-closed test | extend existing | workspace ensure state preflight | prior Compose project disappeared but stale state blocks every retry | S5 correction |

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
   - Correction: the first run disproved retry-only fairness and true-duration
     assumptions. Add provider-only ticket ordering, a thirty-minute bound,
     true acquisition-time recording, and regression coverage before rerun.
   - Commit: `fix(workspace): queue provider mutations fairly`; final live
     evidence rides with the S6 metadata commit.
5. S5 - Klicker repin and profile qualification
   - Route: main
   - Acceptance: pin commit in the clean Klicker worktree; ensure passes on the
     mcp, ai, and manage profiles under Devsy with readiness evidence; no
     machine-preference change.
   - Do: bump the `.devrouter.yml` version pin to 0.0.46; run ensures from the
     clean worktree; record evidence.
   - Check: `devrouter -V --repo .` reports 0.0.46; ensures green.
   - Commit: `chore(devrouter): pin 0.0.46` on the Klicker branch
   - Correction: the first Devsy profile run proved that persisted managed
     state can outlive its exact Compose project and block a safe provider
     handoff. Rebaseline only when Docker proves that no container from the
     prior exact project remains; inspection failure and surviving containers
     stay fail-closed.
   - Devrouter commit: `fix(workspace): recover detached managed state`
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

- 2026-08-29: Plan committed after user approval of the re-evaluated design;
  baseline focused suites green on `ddb7e99`.
- 2026-08-29: S1 complete. Provider-only wait raised to 600 seconds with
  throttled stderr progress, acquisition timestamps added to lock records
  with conservative parsing for legacy and malformed records, and contention
  errors now carry held and waited durations. 34 focused tests pass,
  including real in-process contention. Next: S2.
- 2026-08-29: S2 complete. Devsy `workspace up` stderr is captured in a
  bounded tail and replayed to fd 2 (spawnSync cannot stream while the child
  runs; stdout stays inherited for live progress); the known agent-binary
  acquisition failure appends DEVSY_AGENT_BINARY/download remediation to the
  typed error message without changing classification. 15 Devsy tests pass.
  Next: S3 release.
- 2026-08-29: S3 complete. Full release checklist green: docs policy,
  knowledge validation, Biome, Knip, typecheck, 762 tests (66 files; the
  Linux-only process helper test skips on macOS), build, and packaged-CLI
  evidence. The bundled package-smoke script cannot complete inside this
  sandbox (its pnpm subprocess hits EPERM writing a temp file in the repo,
  before any output), so its checks were performed manually with `pnpm pack`,
  an isolated npm install, exact tarball member listing (46 members,
  including `upgrade-prompts/0.0.46.md`), a successful packed-CLI `--help`,
  and `devrouter -V` reporting installed 0.0.46 against the bumped example
  pin. Next: S4 live Devsy trial.
- 2026-08-30: S4 first trial produced actionable branch evidence under real
  fleet load. Both clients printed ten-second progress lines, but later
  mutations overtook them; client A timed out after 600 seconds and exposed an
  impossible epoch-scale held duration, while client B acquired the lock and
  then hit an external Docker Hub DNS timeout. Root cause: no arrival ordering,
  and the candidate timestamp was created before waiting. Active correction:
  provider-only fair tickets, a thirty-minute bound, and true acquisition-time
  records. The exact failed B runtime is being stopped non-destructively; no
  provider registration, worktree, container, volume, or route is deleted.
- 2026-08-30: S4 correction implementation passes docs policy, knowledge
  validation, Biome, Knip, typecheck, 764 tests across 66 files, build, and
  `git diff --check`. The three-process regression proves arrival ordering;
  stale queue leaders are reclaimed, and progress durations are elapsed times
  rather than epoch timestamps. The failed B runtime stop completed; fresh
  evidence is provider `NotFound` with zero exact routes, so its stale Devsy
  registration is retained under the no-deletion boundary. Next: commit the
  correction, run its simplifier gate, then repeat S4 with fresh exact tokens.
- 2026-08-30: S4 correction simplifier completed on `790fa98` with one accepted
  net reduction: remove duplicate success-path ticket cleanup. Its correctness
  handoff identified that legacy-conservative owner parsing could preserve a
  malformed queue leader with a live PID; queue tickets now require the
  canonical owner format, and the regression covers dead canonical plus
  malformed live-PID leaders. Focused Biome, 39 tests, and typecheck pass.
  Live C/D trial is active: D repeatedly reports provider queue position 2 led
  by C while both wait behind a legitimate installed-client fleet mutation.
- 2026-08-30: S4 complete. Devsy's default agent acquisition failed with the
  new actionable diagnostic. A locally existing official v1.16.2 Linux agent
  was copied into the disposable fixture and verified against its source hash
  (`31060b96486b5398f2aa3ee0875b2555782a2db0954a799d387be38ed4b4990d`).
  Fresh E/F linked worktrees then completed concurrently: the second reported
  queue position 2, both managed runtimes reached ready with zero drift, both
  HTTPS routes returned the fixture JSON, and both PostgreSQL TCP routes
  accepted connections. Canonical exact stops left C/D/E/F provider states
  `Stopped` and zero matching routes; nothing was deleted.
- 2026-08-30: S5 consumer pin committed in Klicker as `48669528f` on
  `rs/devsy-runtime-resilience`. The branch remains intentionally based on
  `bb495a1`; current `origin/v3` is one unrelated video-embed commit ahead.
  The first `mcp` run exposed detached managed state from absent Compose
  project `default-rs-b75ca`; the new exact-project preflight rebaselined on
  `default-rs-c760d` only after Docker proved the prior project had no
  containers. Regression coverage keeps surviving projects and unreadable
  Docker state fail-closed.
- 2026-08-30: S5 profile qualification complete under Devsy without changing
  the machine runtime preference. `mcp` had zero routes, only the local MCP
  process, and a live endpoint; `ai` had zero routes, only healthy LiteLLM,
  and no upstream model call; `manage` had exactly API/Auth/Manage routes,
  healthy Redis services, LiteLLM stopped, and live host responses. Every
  profile reported ready with zero drift. The final exact stop freed three
  routes; provider state is `Stopped` and exact route count is zero. Next: S6
  commit, full validation, final review, and draft PR.
- 2026-08-30: S6 pre-review validation complete. The detached-state recovery
  simplifier removed the generic Docker filter option and a redundant label
  comparison; the Compose-project query is now the only supported shape and
  its behavior is covered through the recovery caller. Current-source checks
  pass: docs policy, knowledge validation, Biome, Knip, typecheck, 765 tests
  across 66 files, build, package installation smoke, and `git diff --check`.
  The Linux-only process-helper test remains skipped on macOS. Next: commit
  the simplification, run integrated final review, and open the draft PR.

# Devsy agent readiness 0.0.47 implementation plan

Date: 2026-08-30. Branch: `rs/devsy-agent-preflight` at exact `origin/main`
`6f4a96f`. Target: `main`. PR: none.

## Goal

- Problem: Devsy v1.16.2 can exhaust its agent acquisition sources and fail
  cold workspace startup with `inject agent: agent binary not found`.
- Goal: make Devrouter-launched Devsy starts use one deterministic, verified,
  locally cached Linux agent and fail before provider mutation when that source
  is unavailable or invalid.
- Goal: give operators one explicit setup command and one network-free doctor
  check that repairs future agent failures before workspaces start.
- Non-goal: change Devsy workspace ownership, registry state, desktop display,
  inactivity shutdown, mutation queueing, stderr capture, or partial-start
  recovery.
- Non-goal: make desktop-originated Devsy starts consume shell environment or
  Devrouter-owned state. Devrouter remains the automation owner; the desktop
  app remains a viewer and manager of the shared workspace registry.
- Non-goal: write Devsy's private cache, download during ordinary `ensure`, add
  a dependency, or support unverified Devsy versions and architectures.

## Execution contract

- Execution owner: this main session.
- Autonomy: one approval of this reviewed plan authorizes S0-S5 without
  intermediate human checkpoints.
- Authority: edit the named branch and worktree; add the plan, ADR, source,
  tests, manuals, knowledge, generated guidance, and 0.0.47 release artifacts;
  run repository-native checks and required reviewers; create local commits;
  perform one official Devsy agent acquisition into Devrouter's cache through
  the built CLI for setup/doctor qualification.
- Boundary owner: self.
- Terminal: S0-S5 are locally committed, fresh checks pass, setup and doctor
  prove readiness without starting a workspace, required findings are
  resolved, and `Progress` is current.
- Delivery layer: reviewed and verified local release branch.
- Withheld: additional upstream integration, workspace runtime start, push,
  PR creation or update, merge, npm or GitHub publication, cleanup, and
  deletion.
- Pause: the installed Devsy CLI is not v1.16.2; official asset metadata
  conflicts with the pinned manifest; safe support needs a new architecture or
  configuration surface; acquisition needs another host; or required checks
  reveal an unrelated failure that cannot be isolated.
- Pause: if `origin/main` moves, report drift before any separately approved
  one-time integration.

## Plan identity

- Plan: `docs/project/2026-08-30-devsy-agent-readiness-plan.md`.
- Branch: `rs/devsy-agent-preflight`.
- Worktree:
  `/Users/rschlae/Git/personal/devrouter/trees/devsy-agent-preflight`.
- Target: `main`.
- Historical context:
  `docs/project/2026-08-29-pr-45-devsy-runtime-resilience-plan.md` delivered
  the 0.0.46 queue, diagnostics, and partial-start behavior that this package
  preserves.

## Research

- Evidence: `src/core/setup.ts` currently persists runtime preferences but has
  no Devsy agent preparation action.
- Evidence: `src/core/tool-diagnostics.ts` proves only that the active runtime
  CLI responds; it cannot distinguish agent-ready from agent-missing Devsy.
- Evidence: `src/core/devsy-mutation.ts` inherits `DEVSY_AGENT_BINARY` but only
  reacts after `devsy workspace up` reports the collapsed provider failure.
- Evidence: Devsy v1.16.2 tries `DEVSY_AGENT_BINARY`, a same-platform host
  executable, its private cache, and HTTP download in that order. It collapses
  all source errors to `ErrBinaryNotFound`.
- Evidence: Devsy's private cache is `~/.cache/devsy/agents` by default and is
  selected by target Linux architecture. It is not a documented integration
  contract and remains provider-owned.
- Evidence: the official v1.16.2 GitHub release publishes:
  - `devsy-linux-arm64`, 124518562 bytes, SHA-256
    `31060b96486b5398f2aa3ee0875b2555782a2db0954a799d387be38ed4b4990d`;
  - `devsy-linux-amd64`, 133505186 bytes, SHA-256
    `4983c52a3536c5a91d1b5f356a1c3428778ebf3f896d9897f60bce3978abc839`.
- Evidence: a manually verified arm64 cache repair made Devsy 1.16.2 startup
  and remote agent injection succeed; exact stop left the provider `Stopped`
  with zero exact routes.
- Evidence: hashing the 124 MB arm64 asset on this host takes about 1.35
  seconds. The cost is acceptable for explicit setup, doctor, and pre-start
  integrity proof, but never for unrelated commands.
- Limitation: no baseline package check ran before planning because the new
  worktree has no installed `node_modules`; the exact source baseline is clean.
- Limitation: Devrouter cannot infer every provider-specific target
  architecture before Devsy starts. Native host mappings are deterministic;
  non-native targets require an explicit verified override.

## Decision

- Decision: explicit `devrouter setup --yes --workspace-runtime devsy`
  downloads the matching native agent. Generic setup and
  inactivity-timeout-only setup do not download it. No second flag is added.
- Decision: Devrouter owns the verified cache under
  `~/.config/devrouter/cache/devsy/agents/v1.16.2/`; Devsy keeps ownership of
  workspaces and its private cache is untouched.
- Decision: one fair `~/.config/devrouter/devsy-agent-cache.lock` serializes
  setup acquisition and rechecks readiness after lock acquisition.
- Decision: the pinned manifest supports `darwin/arm64 -> linux-arm64` and
  `darwin/x64 -> linux-amd64`. Other host mappings fail closed.
- Decision: only Devsy v1.16.2 is supported by this release. A different CLI
  version is `stale` and requires a matching Devrouter release plus rerunning
  setup; ordinary start never falls back to an unverified download.
- Decision: an operator-provided `DEVSY_AGENT_BINARY` remains authoritative,
  is never replaced, and must be a readable regular file matching one pinned
  asset's exact size and digest. The operator remains responsible for matching
  a non-native workspace target.
- Decision: start validates the selected source before taking the Devsy
  mutation lock. A ready managed source is injected only into the copied child
  environment; `process.env` and the desktop app environment remain unchanged.
- Decision: doctor reports `ready`, `missing`, `stale`, or `invalid`, performs
  no network access, omits filesystem paths, and recommends exactly
  `devrouter setup --yes --workspace-runtime devsy` when repair is possible.
- Decision: setup streams into a same-directory private temporary file while
  hashing and counting bytes; only an exact match is fsynced, chmodded, renamed,
  and directory-fsynced. Failed acquisition preserves prior cache state.
- Decision: direct release HTTPS remains the primary transport. A connection
  failure may fall back to the authenticated GitHub CLI asset endpoint pinned
  by immutable asset ID; both transports feed the same size and digest gate.

## Primitive impact

| Product primitive | Disposition | Contract delta | Consumers |
| --- | --- | --- | --- |
| Machine setup | Extend | Explicit Devsy selection prepares one verified matching agent | CLI operators and agent harnesses |
| Workspace-runtime start | Extend | Devsy starts require deterministic preflight and never download implicitly | `ensure` and `workspace ensure` |
| Machine diagnostics | Extend | Doctor exposes values-free agent readiness and exact repair | humans and JSON automation |
| Devsy workspace | Reuse | Registry, lifecycle, desktop visibility, and provider ownership stay unchanged | CLI and desktop app |

The cache is internal Devrouter-owned machine state, not a new product
primitive.

## ADR gate

- Decision: create ADR 0006 for Devrouter-owned verified Devsy agent
  acquisition.
- Evidence: the owner boundary is hard to reverse after release, surprising
  because Devsy normally acquires its own agent, and results from a real
  trade-off among Devsy's private cache, hidden start-time downloads, and a
  Devrouter-owned verified source.
- Do: add
  `docs/adr/0006-devrouter-owned-devsy-agent-acquisition.md` and update the ADR
  index. Record the boundary and rejected alternatives without implementation
  procedure.
- Reopen trigger: Devsy exposes a stable prefetch/cache API, publishes an
  integrity-verifying acquisition command, or the desktop app must start
  Devrouter-managed workspaces independently.

## Skill routing and planning review

- Skills: `$rs-product-primitives` fixed the reuse/extend boundary;
  `$rs-sliced-development-workflow` owns slices, commits, reviews, and finish;
  `$domain-modeling` owns ADR 0006; `$rs-local-runtime-lifecycle` applies only
  if a runtime is later authorized and touched.
- Planning specialist: configured read-only `planner` on GPT-5.6 Sol xhigh,
  child `01a05140-a1da-7f32-94aa-b0846ff79f9a`, returned `DONE`.
- Accepted: explicit Devsy setup as the only download trigger; Devrouter-owned
  cache; pinned manifest; pre-mutation validation; network-free doctor states;
  explicit override precedence; ADR 0006; five implementation/release slices.
- Accepted: keep supply-chain, architecture, and tightly coupled setup/start
  work in the trusted main session.
- Product ruling: none remains.

## Feature-wide test portfolio

| Behavior or risk | Existing evidence | Test obligation | Primary seam | Distinct realistic failure | Slice |
| --- | --- | --- | --- | --- | --- |
| Version and architecture manifest | none | add new | `devsy-agent.test.ts` | wrong asset selected or unsupported host accepted | S1 |
| Digest, size, and atomic publication | atomic-file and lock tests only | add new | `devsy-agent.test.ts` | truncated, substituted, or partial asset becomes active | S1 |
| Acquisition concurrency | generic fair-lock tests | add new | `devsy-agent.test.ts` | duplicate downloads or partial replacement | S1 |
| Explicit override precedence | inherited env behavior only | add new | `devsy-agent.test.ts` | override replaced, leaked, or wrong artifact accepted | S1 |
| Setup trigger semantics | `setup.test.ts` | extend existing | `runSetup` action report | generic setup downloads or explicit setup omits preparation | S2 |
| Network-free doctor states | `tool-diagnostics.test.ts` | extend existing | `global.devsy-agent` | wrong level, path disclosure, or network access | S2 |
| Fail before provider mutation | reactive Devsy failure tests | extend existing | `startDevsyWorkspace` | lock or provider spawn reached while unready | S3 |
| Existing queue, stderr, and recovery | 0.0.46 Devsy mutation suites | retain | existing provider seams | readiness gate regresses fair queue or typed recovery | S3 |
| Guidance and release consistency | docs/prompt/release checks | extend existing | docs and release gates | shipped CLI lacks matching repair workflow | S4-S5 |

## Delegation map

| Workstream | Slices | Execution owner | Dependency | Acceptance boundary |
| --- | --- | --- | --- | --- |
| Plan contract | S0 | main | none | reviewed plan committed and indexed |
| Verified source | S1 | main | S0 | manifest, validation, acquisition, atomicity, and concurrency checks pass |
| Operator workflow | S2 | main | S1 | explicit setup and network-free doctor contracts pass |
| Runtime gate | S3 | main | S1-S2 | child injection and pre-provider failure checks pass |
| Ownership guidance | S4 | main | S2-S3 | ADR, manuals, knowledge, and generated guidance agree |
| Release and finish | S5 | main | S1-S4 | 0.0.47 checks, setup/doctor proof, and final review pass |

Execution-tier skip reason: security-sensitive supply-chain work, architecture
ownership, and tightly coupled setup/start integration remain with `main`.

## Slices

### S0 - Persist the approved execution contract

- Route: main.
- Acceptance: this plan records decisions, authority, tests, slices, and
  `Progress`; the project index links it.
- Do: update `docs/project/index.md` and commit this plan alone with that index.
- Check: `pnpm check:docs-policy`, `pnpm check:knowledge`, `git diff --check`.
- Commit: `docs(project): add Devsy agent readiness plan`.
- Review: documentation-only; simplifier and slice reviewer not required.

### S1 - Build deterministic verified acquisition

- Route: main.
- Acceptance: both pinned assets can be identified and validated; native setup
  can stream, verify, and atomically publish one; failure preserves the prior
  file; concurrent setup performs one effective acquisition.
- Do: add `src/core/devsy-agent.ts` and
  `src/core/__tests__/devsy-agent.test.ts` with the pinned manifest, source
  inspection, streaming download, cache lock, and atomic publication.
- Check: focused Vitest, typecheck, Biome, and Knip.
- Commit: `fix(devsy): acquire verified agent binaries deterministically`.
- Review: one `simplifier` and one security, concurrency, and architecture
  `slice-reviewer` in parallel on the immutable slice.

### S2 - Make setup explicit and doctor actionable

- Route: main.
- Acceptance: only setup with explicit `--workspace-runtime devsy` acquires;
  setup reports preference and acquisition separately; doctor renders the four
  frozen states and exact repair without paths or network.
- Do: integrate the source into `src/core/setup.ts` and add
  `global.devsy-agent` in `src/core/tool-diagnostics.ts`; extend setup,
  diagnostics, doctor, help, and JSON-output tests as required.
- Check: focused setup, tool-diagnostics, and doctor tests; CLI help/build
  output; JSON stdout integrity; typecheck and Biome.
- Commit: `fix(setup): prepare and diagnose Devsy agent readiness`.
- Review: `simplifier`; add a slice reviewer only if implementation introduces
  another trust or state boundary.

### S3 - Gate Devsy start and inject the verified path

- Route: main.
- Acceptance: missing, stale, or invalid sources fail before the provider lock
  and `workspace up`; ready managed and explicit sources reach the child
  unchanged; existing queue, stderr, and postcondition behavior remains green.
- Do: resolve readiness before `withMutationLockAsync` in
  `src/core/devsy-mutation.ts`, inject the managed path only into the child env,
  and replace reactive download guidance with the exact setup repair.
- Check: focused Devsy mutation tests prove no lock/spawn on failure, managed
  injection, explicit precedence, redaction, and unchanged 0.0.46 behavior.
- Commit: `fix(devsy): require verified agent readiness before start`.
- Review: one `simplifier` and one security, lifecycle, and cross-system
  `slice-reviewer` in parallel on the immutable slice.

### S4 - Record ownership and operating guidance

- Route: main.
- Acceptance: ADR, manuals, active knowledge, generated guidance, and bundled
  skill describe one setup/start/desktop contract.
- Do: add ADR 0006 and update `docs/adr/README.md`,
  `docs/GETTING_STARTED.md`, `docs/DEVCONTAINER.md`, architecture ownership,
  managed lifecycle, change/verification map, `.agents/skills/devrouter`,
  `src/core/agents-md.ts`, and affected AI prompt snapshots.
- Check: docs policy, knowledge check, agent/prompt tests, local links, and
  `git diff --check`.
- Commit: `docs(devsy): document managed agent ownership and repair`.
- Review: documentation-only; simplifier and slice reviewer not required.

### S5 - Prepare release and prove the package

- Route: main.
- Acceptance: 0.0.47 artifacts agree; full checks pass; the built CLI performs
  one authorized official acquisition and network-free doctor reports ready;
  integrated final review has no unresolved required finding.
- Do: bump package and example versions to 0.0.47; add the changelog section
  and `upgrade-prompts/0.0.47.md`; update `Progress`.
- Check: canonical validation checklist; built-CLI
  `setup --yes --workspace-runtime devsy`; built-CLI read-only doctor; no
  workspace runtime start. Run DevPod smoke only when its prerequisites and
  exact scope make it applicable.
- Commit: `chore(release): prepare deterministic Devsy agent acquisition`.
- Review: one integrated `final-reviewer` over the committed full range with
  correctness, maintainability, security, architecture, and plan-compliance
  lenses.

## Expected PR evidence

- Whole-branch substantive size and exact changed paths.
- Focused and full validation results, including package smoke.
- Setup action showing one verified native asset and doctor showing `ready`
  without a path.
- Explicit statement that no workspace runtime was started and no Devsy private
  cache was mutated by the package qualification.
- Push, PR creation, CI, merge, and publication remain outside this plan's
  current terminal.

## Progress

- 2026-08-30: refreshed `origin`, fast-forwarded primary `main` from 0.0.45 to
  the approved 0.0.46 commit, and created the clean
  `rs/devsy-agent-preflight` worktree at `6f4a96f`.
- 2026-08-30: official Devsy v1.16.2 source and release metadata verified for
  acquisition order, cache behavior, both Linux assets, sizes, and SHA-256
  digests. The repaired machine cache still hashes to the official arm64
  digest; Devsy reports v1.16.2.
- 2026-08-30: `$rs-product-primitives` selected extensions to setup, start, and
  diagnostics without a new product primitive. The configured planning pass
  returned `DONE`; accepted decisions are recorded above.
- 2026-08-30: the user approved the reviewed S0-S5 execution contract.
- 2026-08-30: S0-S1 are complete at `d17aa42`. The 14 acquisition tests,
  typecheck, Biome, and Knip passed; the supply-chain slice review was clean.
  The simplifier's Low helper extraction was declined because the two explicit
  gates make the pre-lock fast path and inside-lock race recheck visible.
- 2026-08-30: S2 is complete at `05c154b`. The 37 focused diagnostics tests,
  typecheck, Biome, Knip, build, and JSON setup readback passed. Its test-only
  simplifier finding was accepted and verified.
- 2026-08-30: S3 is complete at `5aeec56`. The 22 mutation and 14 acquisition
  tests, typecheck, Biome, and Knip passed; the lifecycle slice review was
  clean. Its test-mock simplification was accepted and verified.
- 2026-08-30: S4 is complete at `125a7b8`. ADR 0006, manuals, knowledge,
  bundled skill, generated guidance, and prompt assertions agree; the focused
  tests, docs policy, knowledge, Biome, and diff checks passed.
- 2026-08-30: a live setup attempt exposed the machine's direct GitHub release
  transport failure while authenticated GitHub API access remained healthy.
  Commit `bb08415` adds a pinned asset-ID GitHub CLI fallback through the same
  streaming size and digest gate. Its 50 focused tests, typecheck, Biome, docs
  policy, knowledge validation, build, and the 799-test full suite passed.
- 2026-08-30: S5 release artifacts were committed at `f4f8f25`. The built CLI
  acquired the official arm64 asset with
  `transport=github-cli`; the Devrouter cache is mode `0700`, 124518562 bytes,
  and has SHA-256 `31060b96486b5398f2aa3ee0875b2555782a2db0954a799d387be38ed4b4990d`.
  Network-free doctor reports 25 ok, zero warnings, and zero errors. Devsy's
  private cache retained its prior mtime and digest; no workspace was started.
- 2026-08-30: the first integrated final review rejected prerelease CLI
  acceptance and source-first stale remediation. Commit `c0756d6` parses the
  complete SemVer token and centralizes stale-first repair guidance across
  setup, doctor, and start. Its simplifier pass returned `DONE`.
- 2026-08-30: canonical checks pass on `c0756d6`: docs policy, knowledge,
  Biome, Knip, typecheck, build, package smoke, and 805 tests across 67 files.
  The Linux-only process script remains correctly skipped on macOS because
  `/proc` is unavailable. Opengrep reports only eight pre-existing findings in
  unchanged CI, shell-run, and route-regex code.
- 2026-08-30: routing smoke remains an environment-only gap accepted by final
  review. The host process returned 200 directly and the mounted route file was
  correct; the long-running shared Traefik process did not reload that router,
  so HTTPS returned 404. Restarting shared Traefik was withheld to avoid
  disrupting unrelated tasks. Exact smoke routes and containers were cleaned.
- 2026-08-30: the second integrated final review found that Devsy telemetry
  made the diagnostics probe violate the network-free contract. Official
  Devsy v1.16.2 source defines `DEVSY_DISABLE_TELEMETRY=true` as its supported
  opt-out. Commit `ff8ea4d` scopes that value to the complete synchronous
  diagnostics probe and restores any caller value afterward.
- 2026-08-30: all corrected-head checks pass: docs policy, knowledge, Biome,
  Knip, typecheck, build, package smoke, and 806 tests across 67 files. A built
  doctor run with Devsy debug logging and the caller's opt-out set to `false`
  reported 25 ok, zero warnings, zero errors, and no PostHog request.
- 2026-08-30: the correction simplifier confirmed that the complete synchronous
  diagnostics scope is required. Commit `17d8c96` inlines its only single-use
  helper without changing subprocess coverage or caller restoration. All
  canonical checks and the built 25/0/0 doctor proof pass on that commit.
- Current: S0-S5 are complete. The final-review findings are resolved and the
  final reviewer must now verify `17d8c96` plus this current Progress record.
- Delivery: required local reviewed release branch. Push, PR, merge, npm or
  GitHub publication, cleanup, and deletion remain withheld.
- Next: complete final review, then report the exact local head for the
  separately approved delivery step.

# Correct reliability evidence and complete explicit stop recovery

## Approval summary

The user approved fixing the unowned sleep-qualification and replaced-population
stop gaps, and reconciling the roadmap on 26 October 2026. This is an executable
batch under the existing reliability roadmap. The later instruction to merge
and proceed with verification authorizes merging
[PR #156](https://github.com/rschlaefli/devrouter/pull/156) and scoped live
qualification on disposable fixtures.

The sleep verifier must distinguish actual wake events from scheduled wake
requests, require a live session immediately before the observed suspend, and
reject a changed executable between preparation and verification. The old Q20
receipt is insufficient and will be labelled accordingly. Source regression
tests qualify the verifier; a fresh operator-observed suspend remains separate.

The stop repair reuses the committed implementation from draft
[PR #130](https://github.com/rschlaefli/devrouter/pull/130), integrated with current
main. Explicit repair may adopt a replacement population only with unchanged
provider and daemon identity, positive absence of the old population, exact
configuration/mount/runner proof and stable repeated observations. Ordinary stop
must retain its refusals; repair cannot delete data or bypass uncertain ownership.

The existing student-docs task remains the consumer owner. Its current work is
application finishing; this package changes neither its branch nor its runtime.
Cloud-preview tasks, their branches and their plans remain independently owned.
Release, global installation and consumer mutation remain separate. The
operator performs the actual machine sleep after fixture preparation. Local
commits, task-branch push and draft delivery are authorized. Roadmap reconciliation describes verified source and evidence
boundaries without publishing private environment data.

## Execution details

Base: `e0111372b136107815a29fe0bd42897628697c1c` (`origin/main`, 0.5.5).
Branch: `rs/reliability-evidence-repair`; worktree under `trees/rs/`.
Execution mode: standard. Main owns integration, stop-recovery decisions and
roadmap reconciliation. One executor owns the bounded sleep-verifier change.

### Delegation map

| Work | Owner | Dependency and acceptance |
| --- | --- | --- |
| Sleep verifier | executor | Hardened plan; focused import-safe regression suite |
| Stop integration | main | PR #130 source `ffed1680f02fcfa56876607de0e4f8c5c1c02d08`; recovery and orchestration regressions |
| Roadmap reconciliation | main | Verified source findings; docs and knowledge checks |
| Integrated verification and delivery | main, with configured reviewers | Committed combined diff; full checks, review and draft CI |

Stop reuse affects `src/cli.ts`, `src/commands/stop.ts`,
`src/commands/__tests__/ensure-stop.test.ts`, `src/core/managed-stop-recovery.ts`,
`src/core/__tests__/managed-stop-recovery.test.ts`,
`src/core/reliability-lifecycle.ts`, `docs/DEVCONTAINER.md` and
`docs/knowledge/managed-environment-lifecycle.md`. Extend existing lifecycle tests
for persistence boundaries. The original PR ref remains untouched. Acceptance
concerns this task branch and excludes consumer-runtime verification.

1. Harden this derived plan. Reuse PR #130 source on the isolated branch and
   inspect integration against current lifecycle fencing, custom provider homes
   and Compose identity normalization. Preserve neighbouring-resource refusals.
2. Repair sleep event recognition, select the first completed suspend since
   preparation rather than an unrelated later cycle, and require a successful
   renewal within the 30-second lease before sleep, with no intervening refused
   renewal. Verify the preparation bundle hash before invoking the CLI. Test
   these evidence gates through synthetic power/renewal inputs without sleeping,
   Docker, provider calls or global state changes. Helpers may stay in the script
   with an import-safe main guard; the focused test belongs at
   `src/core/__tests__/host-suspend-qualification.test.ts` so Vitest discovers it.
   Importing the script must cause no effects. Bundle mismatch must refuse before
   any CLI invocation.
3. Extend existing stop tests where missing: command routing and repair/delete
   refusal, absence/ownership/configuration races, pre-persistence fencing,
   pre-persistence recovery failures leaving the prior baseline intact, and
   ordinary-stop refusal. Post-persistence failure must retain the replacement
   baseline and stop intent, refuse unproven cessation and allow a revalidated
   retry; exercise this through the lifecycle orchestration tests as well.
   Run focused tests first, then repository checks, full tests and package smoke.
4. Update `docs/project/2026-09-13-reliability-release-plan.md` current status,
   retract Q20 closure, distinguish
   shipped source from unfinished integrated-canary/consumer evidence, and
   reconcile delivered work in the dated project records. Keep the quarantine decision
   open; do not close other PRs or infer consumer recovery.
5. Simplify and review the committed package, resolve substantive findings, push
   the ordinary task branch, create a draft PR and verify hosted CI.

## Test portfolio

| Risk | Obligation | Primary evidence |
| --- | --- | --- |
| Scheduled wake interpreted as resume | Add synthetic regression | Actual power-event parser |
| Expired/refused session or later sleep produces a pass | Add synthetic regression | Pre-suspend renewal and pair selection |
| Prepared and verified executables differ | Add regression | Bundle identity gate before runtime invocation |
| Explicit repair adopts foreign/changing resources | Extend existing tests as needed | Existing managed-stop-recovery suite |
| Repair reaches effects before fencing or allows deletion | Extend existing tests as needed | Command and orchestration tests |
| Published CLI omits wiring | Reuse package smoke and full CI | Built CLI, installed package |

## Progress

- Planner: revised once for test discovery and pre/post-persistence boundaries,
  then APPROVED. Independent Gemini 3.8 Flash planning challenge: APPROVED;
  reports retained under ignored `docs/project/_local/reviews/`.
- PR #130 source reused without modifying its original branch. Added retry of an
  already-proven baseline and regressions for state/fence/population changes.
- Sleep parser, pre-suspend heartbeat and bundle-identity gates implemented with
  synthetic regressions. No live fixture or consumer runtime was started.
- Current roadmap summary retracts Q20 closure and reconciles shipped source
  with open acceptance. Resource accounting is correctly listed as delivered.
- Baseline: 89 focused tests passed. Integrated stop suite: 216 tests passed
  across recovery, command and orchestration suites (including later additions).
- Full-suite first attempt hit sandbox `ps` EPERM; locks correctly refused.
  Host-context verification on pinned Node 24 passed: 2,968 tests, 13 Linux-only
  skips; process-helper shell tests require Linux /proc. Built CLI help and
  isolated packed-distribution smoke passed.
- Coupled agent guidance updated for `stop --repair`; the solution record
  `docs/solutions/test-failure/suspend-receipt-without-live-session.md` preserves
  the false-positive cause and prevention. No new runtime abstraction added.
- Optional Jev check unavailable: no established profile located; claims checked
  directly against source, release records and regression outputs.
- No merge, release, global install or other task's source/runtime changed.
- Live Q20 and consumer acceptance remain unqualified until new exact-target
  evidence exists. No fixture is started as part of source verification.

### Delivery evidence

- Draft [PR #156](https://github.com/rschlaefli/devrouter/pull/156) owns this
  package. [PR #130](https://github.com/rschlaefli/devrouter/pull/130) remains unchanged; no other task branch was updated.
- Installed synthetic controller, capacity and lifecycle qualification passed
  using the same product bundle as `e7ef8234`; later changes affect only the
  sleep qualification script/tests. Synthetic providers reported no unexpected
  calls, and the controller qualifier confirmed its controller stopped.
- Simplifier: removed one duplicated expiry-boundary assertion; focused tests
  retain both boundary outcomes. No further abstraction/reduction justified.
- Final reviewer: one preparation-window heartbeat finding accepted and fixed
  in `b664cfe2`; focused regressions and typecheck pass. Same-reviewer correction
  verification passed with no remaining findings in that range. The risk reviewer
  then identified a distinct setup-time bundle drift window: the checkpoint
  hashed bytes after startup. The digest is now captured before startup, checked
  around every CLI invocation and heartbeat renewal, and retained in the
  checkpoint; drift cannot silently relabel the producer. Same-risk-reviewer
  correction passed with no further findings and 10 focused tests, including
  both heartbeat subprocess cases. Final hosted CI passed on `5464b382`
  ([run 40287258714](https://github.com/rschlaefli/devrouter/actions/runs/40287258714)).
- At pre-merge source delivery, real-provider setup, routing and devcontainer
  smoke were not run. The separately authorized post-merge qualification follows
  below; consumer recovery remains separately owned.

### Authorized merge and live verification (2026-10-26)

- [PR #156](https://github.com/rschlaefli/devrouter/pull/156) merged as
  `1df0d0a627d44ab7c31cb5de9106db050eb469a5`. Its tree equals the reviewed and
  tested candidate `5464b382`; natural post-merge
  [CI 40297747596](https://github.com/rschlaefli/devrouter/actions/runs/40297747596)
  passed all ordinary checks and installed synthetic qualifications.
- A build of the merged tree reproduces CLI SHA-256
  `86fa8d2eb56533f828399bf010ad1d8788050875f3b39d762736664a24395198`
  and lifecycle worker SHA-256
  `dd7e169db492a69ec0522d3a3f8b17854a025827ba9ae25bf90184f1f27c6dde`.
- Real-provider disposable-fixture qualification passed configuration-drift stop,
  retained-data resume and final non-destructive stop. The exact provider reports
  stopped and the fixture routes are absent. Its volumes remain retained.
- The same disposable fixture then exercised external container replacement with
  volumes preserved: ordinary stop refused and preserved its prior baseline;
  explicit repair proved and stopped the replacement population; repeated repair
  succeeded; resume preserved the exact data marker; final stop succeeded.
  These are synthetic qualification results, not consumer recovery evidence.
- Q20 has a fresh fixture prepared against the merged bundle, with successful
  ongoing renewals. Verification remains pending the operator's actual sleep and
  wake. The qualifier will refuse a stale session or changed executable and
  perform its exact cleanup after the live verification. The fixture is retained
  only for this pending operator-observed test; it is not a consumer environment.
- Detailed task-owned fixture receipts and producing logs are retained privately;
  other task branches, checkouts and runtimes were not changed. No release or
  global installation occurred.

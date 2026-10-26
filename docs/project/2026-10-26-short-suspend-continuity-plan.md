# Invalidate controller authority after short macOS sleeps

## Approval summary

This executable batch continues the user's approved reliability roadmap and
instruction to fix unowned lifecycle gaps while preserving other sessions.
The corrected suspend qualifier exposed a short-sleep hole: unchanged wall and
monotonic clock deltas can leave an old session renewable. A longer suspend
already exercises the existing discontinuity path; it does not cover this hole.

Extend the existing discontinuity contract with macOS's read-only wake identity.
Sample the kernel value before session authority and capacity evidence are
used. A changed identity follows the current generation-invalidation path,
retaining unresolved consumers and resetting grace. Missing macOS evidence
refuses fresh authority rather than silently relying on timers. Other platforms
retain their current timer behavior and are not claimed qualified by this fix.
No dependency, daemon, persisted schema or public CLI change is required.

Verification covers the reproduced short gap, unchanged epochs, unavailable
evidence, delayed observations and capacity collections, plus exact old-generation
refusals and retained-consumer protection. The terminal condition is reviewed
source, repository checks and a draft PR with truthful roadmap status. Local
commits and ordinary task-branch delivery are already authorized. Merge, release,
global installation and consumer mutation remain separate. A real short-sleep
test still needs the operator after source qualification; no shared host sleep
will be induced and no other owner's runtime will be changed.

## Execution details

Base: `0638021761325ee3cffaf3d8099fe43a56db8085`, target `main`.
Branch and worktree: `rs/short-suspend-continuity`, `trees/rs/short-suspend-continuity`.
Execution mode: standard. Boundary owner: this Devrouter maintenance task.
The existing [evidence PR #159](https://github.com/rschlaefli/devrouter/pull/159)
retains its branch and failed/pass receipts.

### Model and implementation

Reuse session generation, retained consumer, protection grace and capacity
evidence generation. Host wake identity is ephemeral clock evidence, never the
wire's controller-incarnation epoch and never authority to stop an environment.

| Product primitive | Disposition | Preserved contract |
| --- | --- | --- |
| Consumer session | Extend existing discontinuity evidence | Invalidate only its generation; retain unresolved consumers and require fresh observation |
| Capacity evidence | Extend existing clock generation | Drop stale duration/admission evidence; preserve charged resources and ownership |
| Desired lifecycle intent | Reuse | Wake cannot grant parking, clear explicit stop, or prevent an already-committed exact stop |

Add `src/core/host-wake.ts` and its focused test because session authority and
capacity collection are two concrete callers. On macOS, read the absolute
`/usr/sbin/sysctl -n kern.wake_abs_time` with bounded output and timeout, strict
unsigned-decimal parsing and no shell. Treat the decimal string as opaque so
64-bit kernel counters lose no precision. Non-macOS returns `undefined`; command
failure or malformed output returns `null`, an explicit unavailable value.
No cached read may bridge a grant, and raw host values stay private.
Apple's XNU `IOPMrootDomain.cpp` defines the counter as read-only and updates it
on wake. Existing wall and monotonic checks remain additive.

Use a bounded synchronous probe so final pre-enqueue checks never yield. An
internal server option injects a deterministic reader for tests. Initial
`undefined` means unsupported platform. After any supported value, including
`null`, `undefined` means unavailable and cannot restore timer-only authority.
Initial/repeated `null` denies grants; entering unavailability invalidates once,
recovery to a string invalidates again, and equal strings preserve authority.
Reader exceptions mean unavailable. Ordinary tests use synthetic readers.

Inject this reader into `ControllerSessions` at production server construction;
unit callers can provide synthetic epochs. Every existing `tick` call then
samples it, including post-await validation and monitor publication. Epoch
change or loss uses the existing discontinuity retention/parking-revision path.
The tick persists invalidation without throwing for unavailable wake evidence.
Granting methods check availability separately, so the server timer stays alive
and exact release and durable stop reconciliation remain available. Protection
cannot satisfy consent while evidence is unavailable. Recovery requires a new
generation. Exact release remains explicit withdrawal. Recheck live demand
before resume.

Extend `CapacityEvidenceClock` with optional wake identity, sampled by the
production capacity clock. Changes or unavailable identity reset the tracker
generation, cancel in-flight collection and clear cached admission evidence.
Preserve timestamp watermarks so repeated pre-wake samples cannot become new
evidence; explicitly prevent reuse of an accepted sample from an older epoch.
Do not block completion of a previously committed exact stop operation.

### Ownership, checks and sequence

Main owns wake-source verification, cross-system design, integration and final
proof. One executor owns the settled capacity implementation and its tests;
main owns session/server changes and host-wake helper. Disjoint writes only.
One planner critiques this frozen draft before implementation. Committed risk
review covers authority, unavailable evidence, async publication and capacity
races; integrated final review follows repository checks.

| Slice | Owner | Dependencies, acceptance and stop |
| --- | --- | --- |
| Wake probe and session/server/monitor fences | main | Approved critique; deterministic probe, unavailable/recovery and IPC/async grant regressions pass; no runtime |
| Capacity wake generation | executor | Shared helper contract settled; owns capacity-accounting/controller and their tests; cancel/drain/replay regressions pass; no other paths or external effects |
| Documentation and integrated delivery | main | Both implementations pass; update managed lifecycle knowledge and existing reliability records; finish at reviewed draft CI |

Test portfolio: add `src/core/__tests__/host-wake.test.ts` for command bounds,
strict parsing and failures. Extend controller session/server/monitor tests for
short gaps, retained consumers, exact release and sustained unavailable evidence
through IPC and the timer while committed stops remain live. Extend capacity
accounting/controller tests for cancelled collections and old-epoch replay.
The same-epoch replay behavior in `capacity-accounting.test.ts` remains valid;
prior-wake accepted samples cannot be reused. No tests pin documentation text.
Documentation paths: `docs/knowledge/managed-environment-lifecycle.md`,
`docs/project/2026-09-13-reliability-release-plan.md`, and this derived plan.

1. Add focused regressions that fail for a changed epoch across a short gap.
   Verify old renew, publish and consent refuse, retained protection remains,
   and an unchanged epoch preserves ordinary use.
2. Implement the shared probe and integrate session and capacity seams. Check
   unavailable evidence and recovery, delayed publication/collection and sample
   replay. Extend existing files by default; avoid a new clock framework.
3. Run focused tests, docs/knowledge checks, Biome, Knip, typecheck, full tests,
   build and package smoke. Synthetic controller/capacity qualification checks
   the installed wiring; no real consumer runtime is needed for source proof.
4. Update current knowledge and this derived plan with source evidence and the
   outstanding exact-artifact short-sleep verification. The existing evidence
   PR owns its dated receipt updates, avoiding parallel edits to its status row.
   Keep detailed host receipts private and do not recreate the shared index.
5. Commit the coherent package, simplify and review the immutable range,
   correct verified findings, push and deliver a draft PR with CI evidence.

## Progress

- Independent planner: APPROVED after correcting unavailable-evidence liveness,
  synchronous reader transitions and explicit ownership/test boundaries.
- Three new session regressions failed against the baseline; the correction now
  passes 146 focused host/session/server/monitor tests and 85 capacity tests.
  Typecheck passes. Added coverage includes old-epoch sample replay, cancelled
  and drained collections, exact release and committed-stop liveness.
- Source implementation is complete. Full verification passes: 3,118 tests,
  13 Linux-only skips on macOS, typecheck, docs/knowledge, Biome (one pre-existing
  unused import warning), Knip, build, package smoke and installed synthetic
  controller/capacity qualification. The focused installed Opengrep scan reports
  no findings in the six changed executable source files.
- Simplification removed duplicated capacity wake-state branches; the unchanged
  85 capacity regressions and typecheck pass. Installed lifecycle qualification
  and shipped-skill tests pass. The rebuilt capacity qualifier passed on retry;
  one initial-observe refusal is preserved privately and not counted as a pass.
- Risk review and integrated final review remain pending. No merge, release,
  installation or consumer mutation.
- Source mapping completed independently; production grant paths and both clock
  consumers identified. Read-only kernel probe succeeds; both implementations
  are integrated with no dependency or protocol change.
- Live proof: long-suspend evidence belongs to the previous unchanged artifact;
  short-suspend acceptance remains open. No runtime is retained by this package.

### Merged-artifact live result

[PR #159](https://github.com/rschlaefli/devrouter/pull/159) and
[PR #160](https://github.com/rschlaefli/devrouter/pull/160) were merged after the
user approved that exact sequence. The merged source revision is
`4de6ddea661c69780af4cc9b9047f42158a0e994`; its executable source matches the
reviewed candidate. [Post-merge CI](https://github.com/rschlaefli/devrouter/actions/runs/40354315637)
passed. Risk and final source reviews passed; their earlier pending entries
above describe the pre-delivery stage.

The operator-controlled short-suspend test **failed** against unchanged merged
artifacts. The CLI SHA-256 was
`7d65df9a1766e73479a3a5c80b53883d5a7f44e0e719a38ffca7f7feabc49b18`;
the lifecycle worker SHA-256 was
`5f4f68e9d7bb14b9890c06c768a8c8d78d6ac86f004ec0123e7b4eda61d833b5`.
The fixture had a successful renewal within its lease before the recorded
two-second Sleep / DarkWake-to-FullWake cycle. The kernel counter stayed equal
to its pre-suspend value. The old generation remained renewable and could obtain
protection evidence; no discontinuity invalidation or retained-consumer record
was produced. Re-observation did not issue a new generation. The route continued
to serve the expected synthetic response, which does not establish session
invalidation. Capacity admission across this suspend was not exercised.

The failed receipt, checkpoint, heartbeat, baseline and wake diagnosis are
retained privately. Exact cleanup and a subsequent recheck confirmed the
controller and heartbeat stopped, the recorded container was absent, and no
fixture container or route remained. No fixture runtime is retained. No release,
global installation or other task's source/runtime mutation followed this test.

The deterministic tests still prove the fences when their injected epoch changes;
the live failure disproves the assumption that this kernel counter changes on
every relevant short suspend. Apple's
[root-domain implementation](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOPMrootDomain.cpp)
updates the counter after `sleepKernel()` returns. Its sleep/wake UUID is
published earlier, during full-to-dark transition, and can later be cleared.
That UUID is a candidate signal, not qualified replacement evidence: this run
did not capture its pre-suspend baseline.

Next source work must establish a bounded signal for this transition, preserve
unavailable-evidence refusals and exact release/committed-stop liveness, and add
unchanged-counter regression coverage. Any replacement must handle pre-sleep
publication and UUID clearing. A new unchanged-artifact real short-suspend test
and cleanup remain necessary before closing RF09 / Q20. This failed attempt does
not authorize another merge, release, installation or consumer mutation.

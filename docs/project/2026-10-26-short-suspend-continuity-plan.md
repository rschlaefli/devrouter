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
The existing evidence PR #159 retains its branch and failed/pass receipts.

### Model and implementation

Reuse session generation, retained consumer, protection grace and capacity
evidence generation. Host wake identity is ephemeral clock evidence, never the
wire's controller-incarnation epoch and never authority to stop an environment.

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
proof. One executor may own the settled capacity implementation and its tests;
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
4. Update current knowledge and the existing reliability status with source
   evidence and the outstanding exact-artifact short-sleep verification. Keep
   detailed host receipts private and do not recreate the shared project index.
5. Commit the coherent package, simplify and review the immutable range,
   correct verified findings, push and deliver a draft PR with CI evidence.

## Progress

- Next action: independent plan critique, then the first failing short-gap test.
- Source mapping completed independently; production grant paths and both clock
  consumers identified. Read-only kernel probe succeeds; implementation absent.
- Live proof: long-suspend evidence belongs to the previous unchanged artifact;
  short-suspend acceptance remains open. No runtime is retained by this package.

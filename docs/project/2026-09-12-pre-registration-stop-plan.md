# Recover stop before Devsy registration

## Approval summary

A managed startup refused by port preflight can leave a linked workspace with
an owner record but no provider registration or retained runtime baseline.
The current stop requires that registration, leaving the lifecycle in stopping.
The completed startup outcome cannot be repaired by journal settlement.

Add a narrowly guarded absence proof to canonical stop. It applies only to a
present ledger-owned linked managed Devsy checkout with no retained state and
no registration. Prove both registries, runtime, local Docker populations and
routes absent. Pin and revalidate owner identity and the Docker daemon through
final settlement. Keep worker drainage, lifecycle fences, registered stop and
retained recovery intact. Unreadable or changing evidence must refuse recovery.

Authority is the user's executable batch: reproduce, implement, test, review,
commit, push the isolated branch and create/update a draft PR. No global CLI
installation, release, merge or consumer mutation is authorized in this package.
The original task owns its consumer merge and runtime retry. Completion means
reviewed source, passing required checks and CI, plus an exact tested revision
and supported local-build stop command. Consumer recovery needs separate live
proof from its owner; synthetic tests do not establish it.

## Execution details

Baseline: `c43a4aec0185e3a00dacb8d92a66416b1627aa34` (0.0.73).
Branch: `rs/pre-registration-stop`; worktree: `trees/rs/pre-registration-stop`.
Full path: absence admission crosses an ownership and lifecycle proof boundary.
One regression package, exempt from the size floor because it unblocks a task.

### Proof contract

Use a reusable read-only proof receipt in `managed-devsy-stop.ts`. Return no
receipt for registered, retained or non-linked paths, preserving their current
behavior. For the eligible absent case, require an exact record, token, path,
Git common directory and present unlocked Git ownership. Require successful
reads of both provider registries with no ID or path match. On DevPod executable
ENOENT only, opt into the validated local legacy registry described below. Reject Devsy timeout/spawn failure regardless of
error text. Require positive runtime not-found.

Pin a supported local Unix Docker endpoint and daemon ID. Extend the existing
Docker inspection module with a bounded pinned absence scanner: complete ID
list, complete schema-valid inspection response, stable population, and no
container matching checkout compose directory, local-folder labels, checkout
bind mounts or provider-runner ID. Running and stopped residue both refuse.
Require no exact canonical routes; never remove an unexpected surviving route
as part of this exception. Repeat all evidence and compare receipts.

Capture a receipt in the stop worker after previous-worker drainage under the
existing provider lock. Canonical managed stop repeats proof, reports
proven-absent, and propagates runtimeAbsent. Final lifecycle settlement holds
the provider lock, repeats the proof against the captured owner/daemon receipt,
and retains the existing fence, no-worker and zero-route checks. No direct
journal edits, new lifecycle event, schema, CLI flag or dependency.

### Delegation Map and slices

1. Test mapping: explore owner, completed. Acceptance: existing seam pointers
   and refusal coverage. Production source and runtime data excluded.
2. Coupled reproduction, proof and integration: main owner. Route: main;
   execution-tier skip reason: critical-path coupling of absence receipt,
   provider lock, route handling and settlement. Acceptance: exact red failure,
   guarded green recovery, fresh next-ensure admission, refused evidence races.
3. Independent verification: simplifier plus slice-reviewer on immutable
   implementation commit, followed by final Claude reviewer. Main owns findings
   disposition, full verification and draft delivery. No specialist writes or
   external effects. Acceptance: terminal scoped reports and resolved findings.

Existing implementation paths: `src/core/managed-devsy-stop.ts`,
`src/core/devpod-environment.ts`, `src/core/devsy-workspaces.ts`,
`src/core/workspace-lifecycle.ts`, `src/core/reliability-lifecycle.ts`.
Extend their existing `src/core/__tests__/*.test.ts` files as required by the
portfolio. Update only the affected paragraph in
`docs/knowledge/managed-environment-lifecycle.md`. This plan is the sole new file.

### Test portfolio

| Risk | Obligation | Seam and observable behavior |
| --- | --- | --- |
| No-registration deadlock | Extend existing | Managed stop red-green exact failure; lifecycle completed failed ensure, failed stop, settle unchanged, retry stop, admitted next ensure. |
| False absence | Extend existing | Both registries and Docker unreadable/missing/malformed; stopped/running containers, runner, routes, ownership mismatch all refuse without mutations. |
| Evidence races | Extend existing | Owner, common directory, registration, daemon, state or population changes during observations or before settlement refuse. |
| Result propagation | Extend existing | Canonical linked stop reports stopped and runtimeAbsent without provider mutation. |
| Worker and journal safety | Extend existing | Preserve completed outcome; live-worker/fence refusal and existing registered/interrupted recovery tests. |
| Documentation wording | None | Review semantic contract; no content assertions. |

Run focused tests first using pinned Node 24.16.0 and pnpm 11.6.0, then docs
policy, knowledge, Biome, Knip, typecheck, full tests, build and packed CLI smoke.
No service-dependent test requires starting the consumer or shared router.
Run relevant Opengrep and repository commit hooks; inspect staged secrets and
every diff hunk. Review immutable implementation before final draft delivery.
Finish with same-head CI and the exact supported local built CLI stop command.

## Progress

- Fetch succeeded; primary checkout is behind target and has unrelated untracked
  files. Implementation is isolated and those files remain untouched.
- First regression ran on unmodified production source: managed-devsy-stop test
  fails with `Initial managed stop requires one exact Devsy registration.`
- Planner round 1: REVISE. Accepted pinned local daemon, strict provider evidence,
  captured settlement receipt, explicit ownership and portfolio findings above.
- Native planner round 2 APPROVED. Optional AGY challenge was unavailable:
  headless read_file permission was denied; no provider permission was bypassed.
- Implemented the shared pinned proof, strict provider error handling, result
  propagation and final settlement receipt comparison. Public primitives are
  unchanged: canonical stop supplies the existing stop-proof event only after
  absence evidence; no new command, state or owner was introduced.
- Native checks pass on Node 24.16.0 / pnpm 11.6.0: docs policy, knowledge,
  Biome, Knip, typecheck, 2,191 Vitest tests across 142 files with four workers,
  build and package smoke. The unchanged controller-session test timed out
  under default local parallelism, passed alone and in the bounded suite.
  Linux /proc shell tests skip on macOS; CI remains required.
- Opengrep: 210 rules across the five changed production files, zero findings.
- Semantic scope is 465 added and 6 removed source/test lines before review;
  the additional baseline-recovery test file needed two import-boundary mocks.
  No existing production comments or unrelated formatting were changed.
- Required immutable reviews and draft delivery remain pending. Consumer
  recovery remains outside this package and requires live absence proof.


### Authorized Devsy-only amendment

The original task conveyed explicit user approval to recover Devsy-only installs
without installing or running DevPod. Main owns this coupled correction
(critical-path coupling of registry source, receipt and public result).

Extend `devpod-registry.ts` with an opt-in `readLocalWhenMissing` fallback only
on exact executable ENOENT; existing caller semantics remain unchanged. Export
a shared resolver for DEVPOD_HOME or the user's .devpod directory. Read every
context's workspaces/ID/workspace.json, as defined by upstream DevPod
[config directory](https://github.com/loft-sh/devpod/blob/5a0efcbff6610ab114b421f68a890739a452e66b/pkg/config/dir.go)
and [workspace storage](https://github.com/loft-sh/devpod/blob/5a0efcbff6610ab114b421f68a890739a452e66b/pkg/provider/dir.go).
An absent root/contexts/workspaces directory or an empty complete scan proves
no local legacy registration. Every existing node must be readable, of the
expected type and not symlinked; reject partial records, malformed JSON, mismatched
IDs, unknown source shapes, oversized input and changed filesystem evidence.
Bound context/entry counts and record bytes. Check all entries, including hidden
ones, without copying raw records or printing their contents. Project only ID
and local source path; a validated Git/image/container source without localFolder
projects an empty path. Skip path comparison for that empty path, but always
compare ID. This prevents empty paths resolving to the caller's current directory.

The shared proof captures the resolved legacy home and sorted ID/path projection;
repeat and compare both during each observation and include them in the final
settlement receipt. Reader filesystem revalidation brackets each scan. Legacy
home/projection changes between worker capture and settlement must leave stopping
unproven, even if the replacement registry is empty.

Preserve runtimeAbsent through `environment-stop.ts`, `commands/stop.ts` and
supervised workspace-stop mapping. Proven absence reports providerChanged=false,
JSON retains runtimeAbsent=true, and human output describes absence without
interpolating an undefined provider ID. No prose assertions are added.

Extend existing devpod-workspaces, managed-devsy-stop, reliability-lifecycle,
environment-stop, workspace-lifecycle and ensure-stop tests for the amended
false-absence, evidence-race and result-propagation portfolio. No new files.
The red Devsy-only test precedes production changes. Reuse the original slice
reviewer for the coherent correction; run integrated final review and same-head
CI before final delivery. Earlier passing 9a0b256 evidence is a baseline only
for changed behavior. Optional AGY remains unavailable; native amendment review
is required. Documentation wording has no new test obligation.

Amendment planner Goodall: round 1 REVISE, round 2 APPROVED after empty-path,
shared-root receipt, and public result corrections. Amendment verification:
2217 tests / 142 files, docs policy, knowledge, Biome, Knip, typecheck, build,
package smoke pass. macOS process tests skip; Linux CI remains required.
Opengrep: 210 rules / 8 production files / zero findings.

The finish-gate lesson belongs in
`docs/solutions/runtime-error/pre-registration-stop-remains-stopping.md`.
Existing partial-shutdown notes cover surviving services after registration;
this new incident record explains why a completed journal cannot prove absence.
It is a retrospective solution, not an architectural decision.

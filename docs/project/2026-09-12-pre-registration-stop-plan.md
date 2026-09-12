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
reads of both provider registries with no ID or path match; missing competing
CLI is unknown, not absence. Reject Devsy timeout/spawn failure regardless of
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
- Optional AGY plan challenge pending; native planner round 2 APPROVED.
- Tests, implementation, reviews and delivery remain pending.

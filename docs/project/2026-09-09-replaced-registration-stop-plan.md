# Recover stop after a registration replacement

## Approval summary

Canonical stop currently rejects an exact linked workspace when Devsy has replaced
its registration UID, even when all original containers are positively absent.
The failed stop leaves lifecycle intent in `stopping`, preventing a subsequent
ensure before its recovery path can run. This package completes the existing
non-destructive absence reconciliation for this case.

Extend the absence proof to an exact replacement registration only when the old
and replacement generations have no remaining workload on the unchanged pinned
Docker daemon. Preserve Git ownership, source identity, provider context, retained
baseline bytes, stop fencing and route-removal proof. Do not delete registrations,
containers, volumes or source files, and do not reset the lifecycle journal.

Existing user authority covers the source correction, synthetic verification,
reviews, ordinary branch delivery and conditional merge/release. The consumer
owner controls its runtime. This task does not perform the reported OrbStack reset
or infer absence from the user's description of it.

Terminal: reviewed correction, required checks and CI, scoped delivery and release
under existing authority, followed by owner-run exact stop/ensure verification.
No success claim precedes actual proof. Unknown population, changed daemon, live
replacement workload or conflicting ownership remains a diagnostic failure.

## Execution details

Branch: `rs/replaced-registration-stop`. Target: `main`.
Baseline: `b5324f9c71a8b036112c7ab0d4c969cc508238c6` (v0.0.65).
Owner: main. Approval mode: executable batch under the existing roadmap approval.
Full-path risk: exact resource ownership and truthful cessation; independent review
is required. This urgent regression is a packaging-floor exception because it
blocks another task. No stack change is proposed.

The production seam is `proveManagedStop` in `managed-stop-recovery.ts`.
Keep retained-population stopping strict. The additional absence branch requires:

- One unchanged linked Git owner and exact Devsy ID/source path/context; only UID
  replacement is eligible, with both source-container values empty.
- No competing provider ID or path registration, including DevPod.
- Independently qualified replacement provider destination using the existing
  network provider inspector without an endpoint override. Require plain local
  Docker, exact owned registration and endpoint/daemon equal to the baseline.
- Same pinned daemon; every saved container explicitly absent; empty saved Compose
  project, working directory and both old/new provider-runner populations.
- Stable provider, Git ownership, retained state and daemon proof around population
  inspection and before the existing route cleanup and journal stop-proof effects.

Reuse the existing `proven-absent` return and canonical stop integration. No new
public command, persistent schema, permission or resource owner is introduced.
The existing ADR ownership model is unchanged; no new ADR is required.

Delegation Map (planner-reviewed; no dispatch in the planning pass):

| Work | Owner | Acceptance |
| --- | --- | --- |
| Proof implementation and synthetic tests | main | Replacement absence succeeds only through the existing canonical stop caller with zero provider/container effects and unchanged baseline; every new refusal fails closed. |
| Simplification | simplifier | One committed-range pass; findings reported, never a review gate. |
| Slice review | slice-reviewer | One read-only review of the committed correction covering ownership, cessation and fail-closed lenses; findings dispositioned by main. |
| Final review | final-reviewer | One integrated pass over the complete branch after checks; findings handled before delivery claims. |
| Delivery | main | Draft PR after checks; readiness, merge and release remain conditional on required review and CI passing. |

Merge/release authority: the existing conditional release checklist governs; this
plan does not itself merge or publish. Endpoint qualification remains pending from
the consumer owner; passing synthetic tests do not prove that incident resolved.

## Verification

Extend the existing managed-stop-recovery suite with synthetic replacement
registration. Verify success through the managed Devsy stop caller without any
provider/container effect or baseline rewrite. Preserve existing tests rejecting
UID drift when old containers exist, missing/ambiguous ownership and partial stop.

Cover each consequential new refusal: old/new runner remains, saved ID exists or
is unknown, project/working-directory residual, competing registration, context or
source identity changes, daemon drift, registration drift during observation and
retained-state drift. Verify the canonical lifecycle caller still supplies stop
proof only after exact routes are removed. Run affected stop/lifecycle tests and
repository validation; use host execution only when process identity is required.
No pressure injection, real OOM, shared VM restart, policy change or data deletion.

Update the owning changelog and relevant current stop documentation only for the
new behavior. Release artifacts are prepared separately after implementation.

## Progress

Implementation and synthetic verification are complete on this worktree. The
replacement-absence success path and twelve refusal cases pass in
managed-stop-recovery (63 tests), with managed-devsy-stop (43) and
devsy-exec-proof (12) unaffected. tsc, biome (275 files), knip, docs-policy,
knowledge validation and the tsup build all pass. The full vitest run reports
1489 passing with 70 failures across 10 files that require process-identity
file locks, which this sandbox denies; none of the failing files are touched by
this diff. The process test harness skips on macOS as designed. The local plain
Docker selection proof is reused from retained exec instead of requiring an
explicit endpoint pin, per the narrowing below.

The reported consumer state is stopped-by-user/stopping with an interrupted,
drained operation and no worker. Same-daemon inspection confirms all seven old
container IDs explicitly missing and one replacement registration with changed
UID. Stop proof is false. This is not a history-length problem or evidence that
the whole Docker daemon was reset.

Baseline tests pass: 92 tests across managed-stop-recovery and managed-devsy-stop.
A new synthetic regression fails at Retained provider identity changed, matching
the report. No implementation or live-runtime change yet. Planner review pending.

Planner Pauli identified replacement destination proof as missing. Accepted: use
the released provider-binding inspector without substituting the baseline endpoint.
Also repeat complete absence checks. Main rejects new cross-call generation-pin
plumbing unless a concrete unsafe interleaving is shown: this branch mutates no
provider or container, and each existing effect boundary independently proves the
current exact-owner generation empty on its qualified daemon. A separately proven
empty replacement is compatible with the same exact-path stop intent. Planner Pauli
withdrew the snapshot requirement after finding no counterexample and accepted the
qualified-destination approach with bounded obligations: call the released provider
inspector with the exact context and no endpoint override; require owned, plain
Docker, local endpoint equal to the baseline and matching daemon; compare evidence
before and after inspection; and test mid-observation appearance of old IDs,
project/directory population, either runner population, endpoint drift and
registration changes. Consumer endpoint qualification is still pending. Consumer endpoint qualification remains pending; do
not claim this fixes the live incident before that evidence is established.

## Checkpoint after usage-limit interruption

Checkpoint at plan-complete, pre-implementation. The approved plan file and the
failing synthetic regression exist in this worktree; the plan commit and all
further git index writes were denied by the account usage limit (resets Sep 15,
07:42). Do not treat this file as committed history until a later authorized
session commits it. Resume by committing the plan, then implementing
`proveManagedStop` replacement-absence classification exactly as reviewed above.
No runtime, consumer state or remote state changed during the interruption.

## Consumer destination evidence and required narrowing

Owner-supplied, values-free: replacement registration provider.name is docker with
plain DOCKER_PATH; workspace options carry no DOCKER_HOST. The provider-level map
contains an empty DOCKER_HOST value, so no explicit destination pin exists. Under
the current qualified-destination requirement, this replacement cannot prove an
endpoint and therefore cannot complete absence recovery even though the observed
default daemon matches the baseline. The owner correctly rejects substituting that
ambient observation for explicit pinning.

Required plan narrowing (main decision, recorded for review): absence recovery may
qualify the replacement through the same local plain-Docker selection proof used
by retained exec (workspace provider name docker, plain DOCKER_PATH, no ambient
custom command), then require the provider-resolved effective Docker endpoint to
resolve to the baseline daemon ID through the pinned baseline endpoint check.
Explicit workspace DOCKER_HOST is accepted when present and equal, but is no longer
required; an unpinned workspace whose effective daemon equals the pinned baseline
is eligible. Any custom docker path, custom context, non-docker provider, or
different effective daemon remains a diagnostic failure. This matches existing
managed-exec trust: the same provider selection already proves where retained exec
runs. Implementers must reuse the existing inspection helpers, not ambient env.

# Recover stop for a baseline-backed absent runtime

Status: planner approved in round two; implementation and focused verification in progress.
Owner: main. Branch: `rs/absent-runtime-stop`. Target: main at `1397bdd`.

## Outcome and authority

Allow canonical stop to finish for a ledger-owned linked checkout when its Devsy
registration and original containers are gone, but a valid saved stop baseline
still proves which daemon and population must be inspected. After proven stop,
ordinary ensure may prepare the environment again. Preserve retained baseline and
interrupted history. Do not reconstruct provider registration or claim deletion
succeeded.

The approved roadmap authorizes source implementation, checks, reviews, ordinary
branch publication and draft delivery. Consumer runtime verification stays with
its existing owner and requires fresh proof at execution time. This package does
not publish a release, modify machine capacity policy, restart the shared VM,
delete data, or repair legacy records without baselines. Registered NotFound and
primary-checkout fallback behavior remain unchanged.

## Proof and implementation

Select a distinct absence branch only after valid baseline validation and explicit
missing registration. Never interpret arbitrary retained-population errors as
absence. Keep baseline capture and the nonempty baseline schema strict. Reject
source-container baselines in the new branch.

Inspect each saved full container ID at the saved local endpoint with bounded
Docker calls. Only an exact missing-object error naming that ID proves absence.
Reject existing stopped or running containers, wrong-ID errors, mixed output,
permission failures, timeouts and malformed responses. Also require empty saved
Compose-project, Compose-directory and provider-runner populations. Derive runner
identity from the saved UID when its byte length is 16 or 40, otherwise provider ID.
Check saved daemon identity before and after collection.

Require exact ledger ownership, persisted workspace token, a present unlocked and
non-prunable linked worktree, and stable Git common directory. Read both provider
registries freshly even when runtime selection is overridden. Reject unavailable
registries or matching ID/path registrations in either provider. Repeat ownership,
registration and retained-generation checks after collection.

Return an explicit absent result alongside the unchanged retained-container proof.
Carry the distinct proven-absent stop outcome through the managed adapter and
provider wrapper without reporting a provider mutation. Under existing workspace
then provider lock order, revalidate immediately before fenced route removal for
only the exact workspace/path. Avoid recursive provider-lock acquisition.

Keep live Traefik removal verification. A retry after route metadata removal must
still prove the original desired router names absent; empty metadata alone cannot
settle a previously failed unload. Recollect the complete absence proof under the
provider lock at final settlement. Require current fence, drained prior worker and
zero exact-path routes before recording stop-proof. Retain interrupted history.

## Ownership and acceptance

Main owns the tightly coupled identity, stop, route and settlement integration;
these seams cannot be independently changed without coordinating their contract.
A bounded Docker helper and its isolated tests may be delegated after plan approval.
Main verifies integration and owns all publication and consumer coordination.

Focused tests cover exact-ID errors and endpoint pinning, UID byte rules, partial
or replacement populations, daemon drift, owner/token loss, registry conflicts,
registration appearing mid-proof, and retained-record drift. Adapter tests prove
no container/provider mutation on absence. Lifecycle tests cover scoped route
removal, failed live unload and retry, superseded fences, undrained workers,
preserved interrupted history, and ordinary ensure admission after settlement.
Legacy and primary fallback failures remain covered unchanged.

Run affected Vitest suites, typecheck and formatting checks, then repository checks
required by the source diff. Commit implementation separately from release work.
Run dedicated simplifier and risk review, then integrated final review before draft
delivery. Reuse passing evidence when its source and acceptance boundary are unchanged.
Owner-coordinated consumer verification follows reviewed source, using fresh saved
daemon/ID/population proof. Do not induce host OOM or mutate another task's runtime.

## Progress and review disposition

A consumer has a saved baseline and missing registration. Read-only inspection
independently confirmed all seven original IDs absent on the saved daemon, with
empty project, directory and runner populations and matching daemon before/after.
This is diagnosis evidence, not a durable stop proof. No runtime mutation occurred.

The separate legacy consumer has no baseline or historical daemon evidence and
remains outside this package. Its initial retained-population guard rejects empty
Docker state; generic legacy final settlement already accepts empty populations.
Do not change historical cessation semantics to accommodate that case here.

Planner Erdos round one returned REVISE. Accepted all four findings: make this
baseline-only contract operative, require exact missing-ID evidence, independently
prove full checkout and both-registry ownership, and carry absence through route
cleanup and settlement without a false provider mutation. The reviewed advisor's
legacy reconciliation proposal remains unimplemented because it changes semantics
and does not establish historical daemon continuity.

The guest-budget source slice `5bbb3bd` and review checkpoint `aec3ba5` are committed
and pushed on `rs/capacity-admission`. Production ownership/factory wiring resumes
after this bounded stop recovery package; no live capacity policy was activated.

### Implementation checkpoint

Remote refresh confirms the branch remains based on main `1397bdd` without drift.
Main owns identity, route and lifecycle integration. Executor Hubble produced the
bounded Docker helper and synthetic tests; main corrected its environment assertion
to inspect key presence without serializing inherited environment values. The child
reported environment values exposed by a failed assertion; the user was informed.
No credential values are included in source or this record.

The implemented route retry proof uses retained desired app names across both
protocols. Before removing routes in the absent branch, reject names outside that
retained set; retry checks the same names even when metadata is already empty.
Final settlement independently checks live removal. Mutable repository configuration
is not needed. Normal retained capture and ensure proof remain unchanged.

Initial focused tests passed except the provider-lock process fixture, which the
sandbox prevented from reading its own process identity. A scoped host rerun passed
all 13 provider-mutation tests. Source checks use the existing shared Node/pnpm
installation because this repository has no root devcontainer or service dependency
for these tests. No consumer runtime has been modified by this package.

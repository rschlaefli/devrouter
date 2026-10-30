# Retained maintenance transition and restoration

## Approval summary

Status: planning only. Approval mode: direction-only until the provider and
legacy-client feasibility checks below pass. The human-approved follow-up from
the existing disposable-restart owner requested this separate proposal. That
approval covers preparation and return of the proposal, not execution.

A retained environment needs a temporary isolated Compose population, a single
repository-owned maintenance command, and restoration of its original preserving
runtime. Recommend one bounded `maintenance run` operation spanning entry,
literal exec, data-ready verification and restoration under the existing checkout
worker/fence. Named volumes and bind identities must survive. Replacing selected
containers discards their writable layers; stateful-service replacement makes
this materially broader than primary-only app replacement.

Devrouter owns infrastructure proof and command transport. The repository owns
application data semantics, writer checks and the read-only data-ready verdict.
No reset, seed, migration, credential rotation or data repair is inferred. An
unknown command outcome never authorizes replay or ordinary restoration.

First approval to consider after critique: a source-only feasibility batch,
ending with executable native evidence and a reviewed implementation-ready
contract, or an exact provider/compatibility blocker. Implementation, live
qualification, ready/merge/release, installation and consumer adoption/data
operations each remain unapproved. The proposed later qualification uses one
new synthetic fixture, cached immutable images, at most 2 CPU/2 GiB and 60
minutes including terminal stop. It runs benign preservation checks only.

## Execution details

### Evidence and current capability boundary

Baseline: released Devrouter `525b4e23f2e4cb0ac3319a1abedde59020680d28` (0.6.3).
The separate [app-replacement draft](https://github.com/rschlaefli/devrouter/pull/171)
at `f84a174f9f5bc875de0c63c2196713e10072ecd1` is unchanged-configuration,
primary-only replacement. Its source review passes; release and live acceptance
are separate. It does not establish retained overlay apply/restore support.

- `src/core/devcontainer-profile.ts:616` starts exact services with
  `--no-recreate --no-deps`; retained checks compare their rendered configuration.
  Editing an overlay in place is not an apply contract.
- Official Devsy 1.24.0 source
  `1f47cd185bd134b45cdce12b947f6c601d76d329`,
  `pkg/devcontainer/compose.go:1168`, removes the primary on recreate;
  `compose.go:1210` retains existing services with `--no-recreate`.
  That composition alone cannot replace the other containers whose network or
  published-port configuration must change.
- Retained `ensure --repair` and `stop --repair` prove existing populations;
  neither requests a maintenance reconfiguration. Variants remain process inputs
  under [ADR 0013](../adr/0013-runtime-variants-independent-of-profiles.md).
- `src/core/repo-config.ts:723` rejects unknown `managedRuntime` keys. An opt-in
  maintenance stanza could reject legacy startup for that checkout. This alone
  is insufficient: legacy exec does not necessarily parse that configuration.
- Worker operations already have kinds ensure/exec/stop, a checkout fence,
  provider mutation serialization and typed exec outcomes. Strict journal
  enumeration rejects unknown fields/entries. The separate replacement work
  demonstrates keeping infrastructure phases distinct from application outcomes.

No existing supported 0.6.3 alternative meets the complete retained-isolation
and restoration guarantees. Primary replacement cannot apply the overlay;
variants cannot select it. A separate fresh disposable environment changes the
retained-data target and requires its own authority. Raw Compose/provider
commands, private imports and intentional failures are not supported substitutes.

### Product primitives and ownership

| Primitive | Disposition | Owner and boundary |
| --- | --- | --- |
| Exact managed environment | Extend | Devrouter proves a temporary population and restores its frozen original model and storage identities. |
| Fenced lifecycle operation and typed exec | Compose with explicit intent | One existing worker spans infrastructure entry, one literal command and restoration. No separate supervisor or global lock system. |
| Repository application data | Reuse | The consumer owns command semantics, writer/paired-destination proof and positive data-ready evidence. Devrouter never decides that partial data is safe. |

Main Devrouter task owns this proposal and future infrastructure source delivery.
The requesting task retains its consumer source, runtime and data-operation
approvals. The app-replacement branch and documentation draft remain separate.
No package stack, consumer adaptation or release is created by this plan.

### Proposed public contract

Proposed syntax, not implemented: `devrouter maintenance plan`, `status`, `run`
and restoration-only `resume`. Use one named literal declaration under the
existing `.devrouter.yml` `managedRuntime.maintenance` stanza. It references
repository-relative Compose overlays, an existing maintenance profile, literal
command argv, a literal read-only data-ready probe and a read-only cessation
probe for command-owned application/database work. Path validation remains
repo-scoped. No new Devrouter config file or shell/template interpreter is added.
[ADR 0007](../adr/0007-keep-ci-profile-planning-repository-owned.md) still prevents
profile-plan bindings from becoming executable orchestration.

`plan` is side-effect-free and reports a frozen digest, allowed effects and
refusals. `status` reports phase and evidence availability without secrets.
`run` owns one admitted manual exec operation with explicit maintenance intent;
it starts from a proved healthy running exact checkout. Entry, command and
restoration remain within that worker's lifetime. Success is reported only after
restoration, readiness and the operation's final outcome are durable.
`resume` can perform restoration only after positive fresh data-ready proof,
host-worker cessation and attempt-bound container-command cessation. Container
cessation includes descendants; the repository additionally proves that its
command-owned database/background work has ceased. Host process-group drainage
alone does not establish these facts. No probe runs through an unproved or newly
started application context. Missing safe probe context returns a blocker.
Resume never reruns the maintenance body or silently rearms entry.

Initial scope is manual managed Compose, Devsy 1.24.0, a pinned local Unix Docker
endpoint, no allocated-network claim or capacity-managed/enrolled state. The
source-only feasibility batch must prove that this provider/version can perform
the precise transition. A necessary provider-source/API change returns a blocker
for separate authority; it is not silently included.

### Entry, preservation and restoration

1. Freeze source and hook bytes, descriptor/generated digests, ordered Compose
   inputs, original profile/variant/resource sets, image identities, selected
   provider definition/daemon, exact old container IDs and every named/bind
   mount. Render models in memory; persist only bounded identities and hashes,
   never resolved environment values. Reject anonymous/unattributed storage.
2. Validate both complete models and their dependency closure before effects.
   The final overlay may change only networks, published ports and dependency
   selection within the declared maintenance population. Refuse image, mount,
   volume name/target, command, user, entrypoint, environment or resource changes.
   No implicit Compose dependency may restart an excluded writer.
3. Withdraw exact routes and stop repository processes/excluded services with
   ownership proof. Verify old selected containers stopped before replacing
   their network/port configuration. Preserve named volumes; declare writable
   layer loss for every replaced service. Use existing provider serialization
   only around infrastructure mutations, never across the data command.
4. Prove the actual isolated network membership, absence of published bindings
   and shared-network attachments, complete intended service population, fresh
   primary/session/helper identities and healthy stateful dependencies.
   Daemon-wide reverse namespace references include stopped/foreign containers.
   Unavailable or changing evidence refuses; rendering is not live isolation.
   The single literal repository command is a guarded wrapper. Its first stage
   proves actual paired destinations and writer exclusion before invoking any
   maintenance body; guard failure prevents every maintenance effect. The wrapper
   owns the application predicate, not Devrouter. Keep exclusion valid through
   data-ready verification: freeze and revalidate exact private-network membership,
   unpublished bindings, stopped writer identities and shared-storage access.
   Known writers outside the checkout fence require positive exclusion/control
   proof; unknown writer access refuses. The checkout fence alone is insufficient.
   Qualification assumes cooperative managed actors, not hostile host/Docker
   administrators; it makes no universal writer-prevention claim.
5. Restore only after known successful command completion and positive
   repository-owned data-ready verification bound to this attempt/generation.
   Restore the frozen original model, not edited current defaults. Re-prove
   provider, source, images, storage and actual old/new identities; changed
   ownership/configuration, port conflicts or incomplete evidence block return.
   Start preserving hooks/writers only after data-ready and restored-population
   proof. Publish routes last, then prove infrastructure and application health.

The original app, stateful-service, network and session container identities may
change. All declared persistent mount identities and synthetic data must remain.
Ephemeral host port numbers may change and require new proof; fixed declarations
must match exactly. No broad recreation/down, volume removal, network pruning,
credential rotation or initializer replay is part of this operation.

### Durable phases, unknown completion and legacy clients

Extend the existing operation store with an exact-identity maintenance attempt
outside the strict journal directory, using its private-file/atomic-write and
fenced authority patterns. Keep original/target fingerprints, proved populations
and monotonically acknowledged infrastructure phases. Root journal shapes stay
unchanged. Entry/restoration dispatch authority is single-use; acknowledgment
failure, cancellation, stop or new request IDs never rearm a destructive step.
Application/transport outcomes remain separate from infrastructure phases.

The proposed opt-in config key rejects legacy startup only for an adopted
checkout. Source feasibility must test every legacy effect path, particularly
exec and controller recovery. A single root exec operation must remain active
until restoration is proved; no inner command completion may prematurely settle
it. After worker loss, legacy interrupted-exec admission and the config guard
must prevent ordinary startup/exec from exposing an incomplete maintenance
state. Canonical non-destructive stop remains available with exact ownership.
This protection is a hypothesis requiring executable old-reader/entrypoint
proof, not an established compatibility claim.

Do not add unknown top-level journal fields or a new global-format fence.
Existing `writtenByVersion` guards may themselves reject an older CLI after a
future release writes a newer record. Test the actual future package version,
not merely an unchanged-version source build. Coordinate matching CLI adoption
before activation; mixed-version availability is unqualified until demonstrated.
No maintenance-specific record may newly block unrelated workspace enumeration.

On failed/unknown command completion, retain isolation and evidence; never
replay the command or infer data-ready from a filename, missing process or exit
warning. Restoration-only resume first proves attempt-bound cessation of the container
command and its descendants plus its repository-owned database/background work.
Only then may it request a fresh data-ready verdict and restore. Retain both the
original unknown outcome and the no-replay receipt. A host worker's absent process
group is insufficient; a stale semantic receipt never substitutes for cessation. If that cannot be established, report the
exact missing proof and remain isolated/stopped for the data owner's decision.

On partial entry/restoration failure, preserve all observed identities and
withdraw unproved routes. Permit at most one exact canonical stop/repair through
proved known populations within the approved deadline. Mixed-generation stop
support must be demonstrated; existing stop --repair is not assumed sufficient.
If ownership or cessation is unknown, report unknown. Never clear fences, kill
unknown workers, adopt foreign containers, delete volumes or retry the transition.
A new private network left after restoration is reported; deletion is separate.

### Proposed finite source-feasibility batch

This batch needs new approval. It performs no runtime or data effects.

- Extend tests/prototypes only at existing config, worker/exec, operation-store,
  provider and managed-population seams. Establish literal contract validation,
  both-model safety, exact affected populations and old-client guards.
- Prove hook-suppressed retained apply and session rebinding for the changed
  population from exact provider source/native protocol evidence. In particular,
  primary-only recreate plus `--no-recreate` is insufficient for dependencies.
- Establish attempt-bound container-command ownership and cessation through the
  existing exec/provider protocol, including descendants and the repository's
  command-owned database/background work. If the protocol cannot supply this
  proof, return that exact blocker; host-worker drainage is not a substitute.
- Exercise real persistence, malformed/unknown records, dispatch acknowledgment,
  cancellation/worker-loss boundaries, no command replay, data-ready refusal,
  blocked restoration and canonical stopping of each partial known population.
  Cover writer/destination guard refusal before the maintenance body, continued
  exclusion through data-ready, and unknown-completion refusal before fresh
  data-ready/restoration when any command-cessation proof is missing.
- Return a reviewed implementation-ready contract with exact source/protocol
  evidence and proposed native test portfolio, or the precise provider/API or
  compatibility limitation. A required new lifecycle engine, upstream change or
  broader data/ownership contract returns a material decision before implementation.

A later implementation package reuses existing CLI, config, exec worker/store,
provider and population/stop modules. Its exact files and ADR are settled by the
feasibility result. It requires normal checks, integrated independent review,
CI and draft delivery. Planning alone does not start that package.

### Proposed later synthetic qualification

Separate approval is required after reviewed source/CI/package proof. Use ONE
new linked synthetic checkout, exact cached immutable images and the official
verified agent. No image pulls/builds, provider/CLI installation, paid inference,
consumer data, reset or migration. Cap aggregate running fixture resources at
2 CPU/2 GiB and total elapsed time at 60 minutes including five minutes reserved
for canonical stop. Preflight destination, daemon, cache/image identities,
storage headroom and all required synthetic identifiers before creation.

The minimal fixture has an app, a stateful dependency and an excluded writer
sentinel. Initialize fixed synthetic parent/child values in isolated main/shadow
databases once. Verify actual values/cache markers before entry, while isolated
using a benign read-only maintenance command and data-ready probe, and after
restoration. Prove network/port/writer exclusion, retained named/bind mounts,
expected changed containers/session identities, restored readiness and final
canonical stop with zero exact routes and no worker. The fixture proves this
infrastructure contract only, not a real reset or arbitrary consumer topology.

Native tests cover fault/unknown-completion/cancellation; live fault injection
requires separate authority. First material failure ends the qualification
branch, records bounded evidence and permits one proved stop/repair attempt
within the reserved deadline. Retain data/artifacts. No second fixture,
transition retry, reset/reseed, cleanup or prune.

### Remaining approvals and terminal condition

1. Source-only feasibility batch above; its terminal is reviewed executable
   contract evidence or an exact blocker, with no runtime effects.
2. Implementation and native/review/CI/draft delivery once feasibility resolves
   the contract. Any provider-source/API change stays separately owned.
3. One exact bounded synthetic qualification, including disclosed writable-layer
   loss for every selected replaced container, after source/package gates.
4. Ready/merge, release and receiving/global installation as a named conditional
   delivery sequence with actual version compatibility and adoption evidence.
5. Consumer declaration/guard adoption and any real maintenance/reset/data
   operation in that owner's separately reviewed and approved batch.

This planning task ends with one critiqued proposal returned to the requesting
owner and explicit unqualified seams. No current consumer is declared unblocked.

## Progress

Root outcome: a supported retained maintenance/restore contract that protects
storage and lets the existing consumer owner execute useful work under its own
authority. Current authorized terminal is this planning proposal only. First
useful acceptance is the public capability boundary and provider/legacy-path
feasibility specification. Released 0.6.3 and primary-only replacement do not
close that boundary. Main owns this separate planning worktree; critique is complete and portable return is being prepared. The first critique found two real gaps: host
worker drainage does not prove container/database command cessation, and the
writer/destination predicate lacked an executable stage. Both are corrected by
an attempt-bound cessation gate and a guarded literal wrapper whose exclusion
persists through data-ready. Focused independent critique approved both corrections. The reviewed contract
is frozen; feasibility and all later effects still require their named approvals.
No implementation, runtime, release, install,
reset or deletion occurred in this planning batch.

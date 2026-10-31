# Retained maintenance transition and restoration

## Approval summary

Status: source-only feasibility complete. Coordinated CLI adoption and the
detailed consumer requirements handoff were approved on 2026-10-31. The consumer
requirements handoff has now arrived after sending-side approval. A qualified
execution context and private source/input/evidence protocol remain missing;
public implementation remains separately scoped. The focused
independent review found the proposed contract not implementation-ready. Main verified the load-bearing findings with
additional zero-provider-effect hook and released-CLI probes. The original
source-only authority covers this result and ordinary task-branch delivery;
public maintenance implementation and runtime/data effects remain unapproved.

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

The approved batch ends with executable native evidence and a reviewed
implementation-ready contract, or an exact provider/API/compatibility blocker.
Implementation, live qualification, ready/merge/release, installation and consumer
adoption/data operations remain separate. The proposed later qualification uses
one new synthetic fixture, cached immutable images, at most 2 CPU/2 GiB and
60 minutes including terminal stop. It runs benign preservation checks only.

## Execution details

### Evidence and current capability boundary

Baseline: released Devrouter `525b4e23f2e4cb0ac3319a1abedde59020680d28` (0.6.3).
The separate [app replacement](https://github.com/rschlaefli/devrouter/pull/171)
is merged at `d2fba69eaad9bc6464d412776e9241b66ea33f32`, with a complete tree
equal to reviewed `f84a174f9f5bc875de0c63c2196713e10072ecd1` and passing
[merged-main CI](https://github.com/rschlaefli/devrouter/actions/runs/41121149134).
Its review, package-byte proof and one bounded synthetic qualification passed.
It is unchanged-configuration, primary-only replacement and remains unreleased.
It does not establish retained overlay apply/restore support.

- `src/core/devcontainer-profile.ts:634` starts exact services with
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

### Source-feasibility evidence — 2026-10-30

The provider's structural-overlay recreation route is unsuitable: exact official
Devsy 1.24.0 code dispatches whole-project `compose down`, without `--volumes`.
A native source-derived Go probe captures that argv with no provider effects.
This rejects one route; it does not establish that an upstream change or new
lifecycle engine is necessary.

A second Go probe extracts 20 original provider functions and verifies a new
synthetic primary with unchanged source signature, image, lifecycle contract,
metadata, runner/service labels and persisted Compose invocation. Structural
recreation remains unrequested and label lookup returns the new primary ID.
Changed structure, image, metadata, runner, service and feature inputs refuse;
malformed persisted invocation also refuses. Frozen valid empty image metadata
and the in-memory inventory are fixture adapters. General image-metadata parsing,
actual Compose execution and provider hook behavior are not qualified by it.

Six mocked TypeScript cases compose the existing pinned stop/absence and
namespace guards with a temporary exact-ID removal and a minimally pinned
selective-start variant. They verify the full provider-generated file chain,
explicit service subset, endpoint pinning despite conflicting host environment,
no project down/volume deletion/broad recreation, and refusal before mutation
for host PID mode, namespace consumers, anonymous storage or changed inventory.
Missing fresh stopped proof refuses removal/startup at a synthetic callback.
That fixture does not establish actual stop-inspect-remove ordering; stateful
running/stopped/absent observations remain a required implementation check. Every
child launch is mocked.

The existing native portfolio adds 31 exec, 103 pinned-container/exec-proof and
20 selected persistence/model checks, all passing on Node 24.16.0/pnpm 11.6.0.
The last command selects 20 tests and deselects 166; these are not platform skips.
Go 1.27.3 runs the two standard-library-only source probes. No CLI/provider was
installed, and no Docker, application, database or container runtime was started.
The source-only proof artifacts and exact hashes are retained in the task's
existing private review area; they are not shipped product implementation.

A bounded Opus 5.5 feasibility consultation found no need for a new supervisor
or upstream change from the evidence so far. Its requested identity-replay and
pinned-sequence experiments pass as scoped above. Focused review and follow-up probes expose the unresolved compatibility and
consumer-protocol limits below. The candidate contract is not implementation-ready.

### Approved rollout decision — 2026-10-31

The user approved coordinated CLI adoption before first retained-maintenance use.
All participating agents and harnesses sharing Devrouter journals must use the
same qualified release; later upgrades repeat that coordination. Older clients
may refuse both the changed checkout and global journal enumeration. No
mixed-version or unrelated-workspace availability promise is made for them.
Preserve existing writer guards and every receipt. Do not introduce another
machine-global registry, erase state or bypass old-client refusal.

This resolves the operational compatibility ruling below. Before any later
activation, the release owner still proves exact package/version compatibility,
participating client paths and harness pins, adoption and downgrade limits.
The approval chooses the rollout policy; it does not authorize publication or
installation. Unknown or competing writer versions remain a refusal.

The user also approved transfer of the reviewed detailed consumer requirements.
The sending-side approval requirement was subsequently satisfied and the handoff
has arrived. That messaging block is closed. The detailed coordination payload
and its owner-reported review are retained privately; receipt supplies neither
an implemented probe nor consumer/runtime/data authority.

The received proposal confirms that the currently available context cannot
supply the complete semantic proof. A jointly reviewed frozen-source, private
restricted-input and fresh evidence-delivery contract remains necessary.
Correlation IDs and a successful command exit do not authenticate predicates.
No complete unchanged-context implementation is established. The existing
consumer owner retains its source, data semantics and execution-context decision.

A bounded Devrouter source check found reusable stdin byte delivery in
`managed-post-start.ts`, but retained exec in `devsy-exec.ts` inherits streams
and `DevsyExecProof` binds the running primary. They do not expose a private
bounded probe protocol for other managed targets. This identifies missing
contract work without proving a new engine or verifier environment necessary.
Frozen multi-target orchestration and a separately qualified verifier context
remain unselected alternatives; neither is implemented or authorized here.

### Candidate existing-seam contract (not implementation-ready)

- Freeze both complete rendered models and the provider's actual recorded
  Compose invocation and generated override bytes, not only repository
  `composeFiles`. Keep the logical provider descriptor/signature unchanged.
  Maintenance profile selection is an internal service/process subset, not a
  Devsy structural-overlay request. Preserve provider labels from verified
  original artifacts; do not forge Docker's actual ConfigFiles label. Verify
  the expected original or maintenance file chain for each phase.
- Under the existing root worker/fence and provider serialization, stop each
  exact selected full ID and re-inspect its stopped state before a bounded
  exact-ID removal. The new removal verb uses no force or volume flag and must
  prove absence. Start only the missing selected services through the existing
  Compose seam, extended with explicit endpoint arguments/environment and
  `--no-recreate --no-deps --no-build --pull never`. Recheck image and existing
  named/bind storage identities before creation and actual mounts afterwards;
  missing retained storage refuses rather than permitting Compose to create it.
  Retain original networks, create only the declared private network, and never
  change an external/shared network's configuration or perform project down.
- Keep the root exec active across entry, command, cessation, semantic probes
  and restoration. Inner command completion never settles the root worker.
  Before the body, prove its exact primary target, private PID namespace and
  no daemon-wide namespace consumers. After body completion, or a restoration
  request following unknown completion, stop and re-inspect that exact primary.
  This proves cessation of its namespace's command processes and descendants
  under the supported isolation assumptions; host-worker drainage alone does not.
  The [Linux PID-namespace contract](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
  and [Docker stop contract](https://docs.docker.com/reference/cli/docker/container/stop/)
  support this composition. Its actual runtime behavior is still unqualified.
- Require one declared `probeService` in the already-running, exactly proved
  stateful population. Run the literal repository-owned read-only cessation
  command, then its fresh data-ready command, through a pinned exact-ID exec
  seam. Preflight the required executable/context and restricted paired
  destinations before entry. A stopped/missing probe context blocks; no implicit
  application restart, new mount/toolchain, administrator/default connection or
  bootstrap wrapper supplies it. A completed guard exit is a verdict only after
  the qualified guard actually runs in the current attempt, target and fence.
  Unknown probe completion supplies no verdict. Preserve unknown body completion
  and never replay it; restoration-only resume reports that distinction.
- Restore the frozen original model by the same selective sequence, reprove
  population, provider identity, mount/image equality and semantic readiness,
  then run only qualified preserving hooks/processes and publish routes last.
  Provider exec re-resolves a running primary by labels; no new session engine
  is introduced. The source probe below proves that fresh layers can replay provider hooks;
  direct Compose avoids that dispatcher. Pre-data-ready source/image entrypoint
  behavior and later preserving hooks require explicit qualification. No provider
  startup/recreate is an isolation or probe shortcut.

The permanent implementation belongs in the existing config, CLI, worker,
exec, operation-store, profile/population and stop modules. The temporary removal
and endpoint-pinned startup are bounded extensions of those seams, not authority
to issue operator-side raw commands. The commands' proposed purposes remain:
`plan` reports frozen models/effects, `status` reads the exact attempt without
startup, `run` owns one transition/body/restore, and `resume` restores only.

### Focused review outcome and blocking constraints

The focused Opus 5.5 review completed with findings on 2026-10-30. The core
selective composition is plausible and requires no demonstrated upstream change.
It identified the following requirements; the approved rollout decision above
now resolves the first policy ruling, while its qualification evidence remains:

1. **Older-client availability.** A closed probe uses checksum-matched released
   0.6.3 CLI bytes and isolated synthetic records. With a hypothetical 0.6.4
   `writtenByVersion`, actual released ensure, exec, stop and controller-recovery
   admission functions refuse before any provider effect, even with complete stop proof
   and the config guard removed/ignored. Its global journal enumeration also
   refuses with `Reliability journal entry is invalid.` A private maintenance
   receipt remains untouched and is not enumerated before the version change.
   This is the existing writer-version guard, not a maintenance schema change.
   It prevents claiming mixed-version availability or older-client canonical
   stop. More seriously, one newer record can stop an older global enumeration,
   so the current promise of unaffected unrelated-workspace enumeration is not
   proved for mixed versions. A blanket upgrade precondition changes operational
   compatibility and needs an explicit ruling, or a separately reviewed staged
   guard/delivery protocol. The probe's 0.6.4 stamp is hypothetical, not an actual
   release artifact; the chosen future version still needs its exact-package test.
   Identity/variant selection is a closed fixture; full worker IPC is excluded.
2. **Consumer-owned semantic probe.** The receiving source has no complete safe
   paired-target, writer, background-cessation and full-data-ready entrypoint in
   its dependency. Its owner must implement/review that API under separate
   consumer authority. Neither a schema/marker snapshot nor a bootstrap wrapper
   substitutes for it. Source references and context limits are recorded below.

The existing consumer owner clarified the stopped-probe question: bounded
diagnostics and a positively proved canonical stop are an accepted failure
branch, with retained data and incomplete/unknown fences. A stopped/missing
probe service may therefore be a terminal restoration refusal; ordinary restart
must refuse replay. Automatic probe-service restart is optional additional
capability, not a requirement of this batch and not something to add on that
owner's behalf. The focused review's contrary completeness assumption is
rejected on this scope evidence. If ownership/cessation cannot be proved,
shutdown remains unverified. No new recovery or implementation authority follows.

Two further source-derived Go cases resolve the hook question. The exact pinned
provider marker/eligibility functions show that a fresh writable layer makes
onCreate, updateContent, postCreate and postStart eligible again. The supported
skip flags suppress only postCreate/postStart/postAttach; onCreate/updateContent
remain. The probe records hook names instead of executing bodies. Therefore a
pre-data-ready `workspace up` is not a suppression mechanism. Direct frozen
Compose creation never invokes Devsy's setup dispatcher; its image entrypoint,
feature entrypoint chain and service command still need semantic validation for
writes/host control. Later ordinary startup requires every configured hook and
entrypoint to preserve data. The prior primary-only replacement contract
[ADR 0015](../adr/0015-explicit-stopped-app-replacement.md) explicitly requires
qualified preserving hooks; its successful fixture is no general hook-suppression
proof. In the receiving wrapper, seed/push requires the explicit
`--initialize-new-disposable` argument; preserving startup does not select it.

Other accepted review corrections are contract requirements for a future batch:
refuse missing/changed provider-generated paths instead of rewriting them; bind
all commands/probes to the same attempt/fence through an explicit protocol; keep
outcome-specific restoration rules consistent; reject host-control endpoints or
unknown escaped work; use stateful stopped/absent inspection fixtures; and name
only non-starting `stop --repair` for incomplete-attempt recovery.

### Proposed probe binding and restoration table

This is a proposed consumer API for the next contract review, not a shipped
interface. Deliver fixed `DEVROUTER_MAINTENANCE_ATTEMPT_ID` (UUID),
`DEVROUTER_MAINTENANCE_ENVIRONMENT_ID` and
`DEVROUTER_MAINTENANCE_RUNTIME_GENERATION` through the pinned exec environment.
The environment ID is the existing reliability identity hash; generation is its
canonical bounded nonnegative decimal counter.
No shell/template expansion is performed. A bounded single JSON verdict contains
`version: 1`, matching `attemptId`, `environmentId`, `runtimeGeneration`,
`probe: cessation|data-ready`, a fresh per-invocation `probeId` delivered as
`DEVROUTER_MAINTENANCE_PROBE_ID` (UUID), and `verdict: pass|refuse`. The wrapper's qualified
exit and complete matching verdict are both required; absent, malformed, stale
or unknown-completion output is unknown, never success. The repository owns the
semantic predicate; Devrouter owns actual dispatch, target/fence and receipt
validation. A future field name change is an API decision, not a routine guess.

| Body outcome | Fresh cessation and data-ready | Allowed action |
| --- | --- | --- |
| Success | Both positive, probe context proved | Restore frozen original population; report success only after restored readiness. |
| Known failure | Both positive, probe context proved | Explicit restoration-only resume may restore; retain/report original nonzero body result. No automatic body replay. |
| Unknown | Both positive, probe context proved | Explicit restoration-only resume may restore; retain/report original unknown outcome. Never infer body success. |
| Any dispatched outcome | Any proof missing, failed, stale or unavailable | Retain fence/isolation; report exact block. A stopped probe service is a named terminal block under the current contract. |
| Never dispatched | Original population freshly proved unchanged | May release ordinary preserving recovery only after proving no infrastructure effect; never rearm the original attempt. |

The cessation boundary also requires a private primary PID namespace, no
namespace consumers, no privileged/host-control execution path and no Docker
socket/endpoint that could create sibling work. Revalidate daemon-wide population,
private-network membership and shared-storage access after stopping. New or
unattributed attempt-related resources refuse. Database/background work is still
an independent consumer proof. Unknown host-control capability must refuse,
not be assumed absent from feature names or a missing explicit mount.

### Consumer protocol prerequisite

The existing consumer owner confirms that stopping the exact primary is
compatible with its contract. It also confirms that a complete dependency-native
read-only probe does not currently exist. Source inspection at public revision
`8d56d46fe389f6c0a2b2cce7476a3cf55293a23c` verifies:

- The [identity predicates](https://github.com/uzh-bf/klicker-uzh/blob/8d56d46fe389f6c0a2b2cce7476a3cf55293a23c/packages/prisma/src/disposableDatabase.ts#L56)
  use repository TypeScript/pg. Both restricted destinations and their common
  population/provider/storage binding remain required.
- The [bootstrap wrapper](https://github.com/uzh-bf/klicker-uzh/blob/8d56d46fe389f6c0a2b2cce7476a3cf55293a23c/.devcontainer/recover-bootstrap.sh#L54)
  installs/builds and changes configuration/markers; its preserving checks are
  not a complete attempt-bound cessation or semantic data-ready predicate.
- The [dependency mounts](https://github.com/uzh-bf/klicker-uzh/blob/8d56d46fe389f6c0a2b2cce7476a3cf55293a23c/.devcontainer/docker-compose.yml#L17)
  do not declare the repository Node/toolchain context needed by that verifier.
  Application HTTP readiness belongs after restoration, not before it.

A dependency-native adaptation is a possible future consumer design, not an
existing qualified capability. That owner must supply and review paired-target,
writer, database/background-cessation and full data-ready semantics, including
restricted credential/context delivery without implicit privilege. Devrouter
cannot invent those predicates or install a different execution context here.
This remains an explicit consumer API prerequisite; no current consumer is unblocked.

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
probe for command-owned application/database work, with an explicit `probeService`
in the already-running proved stateful population. Path validation remains
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
5. Restore only under the body-outcome table above, after positive fresh
   repository-owned cessation and data-ready verification bound to this attempt.
   Automatic successful completion restores on body success; explicit resume
   can restore a failed or unknown body without changing its recorded outcome.
   Restore the frozen original model, not edited current defaults. Re-prove
   provider, source, images, storage and actual old/new identities; changed
   ownership/configuration, port conflicts or incomplete evidence block return.
   Start preserving hooks/writers only after data-ready and restored-population
   proof. Publish routes last, then prove infrastructure and application health.

Every recorded provider-generated file must remain at its original path with
its frozen digest before restoration; missing, changed or regenerated files
refuse. This batch grants no rewrite of provider-owned files.

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

The proposed opt-in config key rejects the released parser for an adopted
checkout, but config alone cannot fence legacy exec. The released-byte probe
above tests ensure/exec/stop and controller recovery under a future writer stamp. A single root exec operation must remain active
until restoration is proved; no inner command completion may prematurely settle
it. After worker loss, legacy interrupted-exec admission and the config guard
must prevent ordinary startup/exec from exposing an incomplete maintenance
state. Canonical non-destructive stop remains available with exact ownership.
Released older clients refuse under that stamp even after canonical stop;
version-coordinated adoption is now the approved rollout policy and older
clients receive no availability guarantee. The new CLI must guard on the durable
attempt itself,
not only on removable config or an active root operation.

Do not add unknown top-level journal fields or a new global-format fence.
Existing `writtenByVersion` guards may themselves reject an older CLI after a
future release writes a newer record. Test the actual future package version,
not merely an unchanged-version source build. Coordinate matching CLI adoption
before activation; mixed-version availability is unqualified until demonstrated.
Private maintenance records must remain outside strict journal enumeration.
The existing global version-stamp refusal above is accepted under the approved
coordinated-adoption policy; no older-client unrelated-workspace availability
claim is made.

On failed/unknown command completion, retain isolation and evidence; never
replay the command or infer data-ready from a filename, missing process or exit
warning. Restoration-only resume first proves attempt-bound cessation of the container
command and its descendants plus its repository-owned database/background work.
Only then may it request a fresh data-ready verdict and restore. Retain both the
original unknown outcome and the no-replay receipt. A host worker's absent process
group is insufficient; a stale semantic receipt never substitutes for cessation. If that cannot be established, report the
exact missing proof and remain isolated/stopped for the data owner's decision.

On partial entry/restoration failure, preserve all observed identities and
withdraw unproved routes. Permit at most one exact non-starting `stop --repair` through
proved known populations within the approved deadline. Mixed-generation stop
support must be demonstrated; existing stop --repair is not assumed sufficient.
If ownership or cessation is unknown, report unknown. Never clear fences, kill
unknown workers, adopt foreign containers, delete volumes or retry the transition.
A new private network left after restoration is reported; deletion is separate.

### Approved finite source-feasibility batch

This batch has human approval. It performs no runtime or data effects.
Check command cessation first so an exact missing protocol can end the batch
before broader transition prototypes.

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

### Proposed next source implementation batch

Recommendation, not approved: coordinated adoption is settled. After the
consumer requirements handoff resolves the protocol and its ownership, implement
the candidate contract on one ordinary
task branch, using the existing config/CLI/exec worker, operation store,
`devcontainer-profile.ts`, `devpod-environment.ts`, `devsy-exec-proof.ts` and
managed stop/recovery seams. Add the narrow private attempt schema and canonical
ADR/manual/skill/AI-prompt updates required by this public capability. Preserve
all existing non-maintenance behavior. No upstream/provider source change or new
lifecycle engine is included; a newly necessary one returns a decision.

The feature-wide native portfolio is: (1) both-model and literal declaration
validation, (2) endpoint/exact population and dispatch guards, (3) real atomic
attempt persistence and no replay across acknowledgment loss/cancellation/new
requests, (4) root-worker/admission and legacy entry guards, (5) stopped-primary
cessation plus fresh safe-context probe sequencing, and (6) canonical stop of
each partial known population and restore-before-writer/route ordering.
Reuse the current qualified seams and source probes. New tests protect those
observable contracts, not prose, snapshots or the prototype's implementation.

An incomplete attempt must block ordinary ensure/exec even after canonical stop.
Restoration-only admission is a narrowly proved extension of the existing model;
it retains the interrupted body's history and never reclassifies it as success.
Keep private attempt records outside strict global journal enumeration. Unknown
phase/proof, data-ready failure or drift retains the fence and returns a precise
blocker. A never-dispatched claim may permit ordinary preserving recovery only
after fresh proof of the unchanged original population; it never rearms maintenance.

Run repository-native checks, meaningful focused/native regressions, package
checks, integrated independent review, exact-head CI and ordinary draft delivery.
Terminal: reviewed source and passing CI in a draft PR, with explicit consumer
probe prerequisites and runtime limits. No live qualification, consumer change,
ready/merge, release, install, deletion or data operation is included. Later
qualification remains the separately bounded proposal below.

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
branch, records bounded evidence and permits one proved non-starting `stop --repair` attempt
within the reserved deadline. Retain data/artifacts. No second fixture,
transition retry, reset/reseed, cleanup or prune.

### Remaining approvals and terminal condition

The source-only feasibility batch above is already approved. Its terminal is
reviewed executable contract evidence or an exact blocker, with no runtime effects.
The later approvals remain:

1. Implementation and native/review/CI/draft delivery once feasibility resolves
   the contract. Any provider-source/API change stays separately owned.
2. One exact bounded synthetic qualification, including disclosed writable-layer
   loss for every selected replaced container, after source/package gates.
3. Ready/merge, release and receiving/global installation as a named conditional
   sequence with actual-version compatibility and adoption evidence.
4. Consumer declaration/guard adoption and any real maintenance/reset/data
   operation in that owner's separately reviewed and approved batch.

This source-only batch ends with its reviewed contract or exact blocker returned
to the requesting owner. No current consumer is declared unblocked.

## Progress

Root outcome: supported retained maintenance/restore that preserves storage and
enables the consumer owner's useful work under its authority. The approved
source-only feasibility batch has reached its terminal with reviewed evidence
and exact compatibility/probe blockers. It has not produced an implementation-ready
contract. Main owns this branch and result; consumer authority remains separate.

First useful acceptance is complete: the structural-overlay route uses disallowed
project down, while frozen-identity replay and a pinned selective composition pass
source-only probes. Additional exact hook code proves fresh-layer replay, and the
checksum-matched released 0.6.3 CLI proves future-writer refusal in ensure, exec,
stop, controller admission and global journal enumeration even after stop proof.
The private receipt remains intact. The reviewed findings and limits above are
binding; no upstream impossibility or need for a new engine is inferred.

The user resolved the operational mixed-version/global-enumeration ruling
through coordinated CLI adoption. The approved detailed consumer handoff has
arrived, closing the messaging approval block. Its proposed API remains
conditional on a complete safe context, private restricted inputs and trusted
provider/consumer proof delivery. The bounded source check above identifies
those missing seams; it does not qualify live use or require another supervisor.

A proved terminal stop remains an accepted failure outcome; automatic probe
service restart is optional additional scope. The next maintenance decision is
a concrete source/input/evidence transport and full-context contract. Do not
ask for approval of an unspecified verifier or ship a permanently refusing API
as complete. Maintenance implementation and runtime/data effects remain gated.
The separate approved release-preparation package uses existing replacement
and diagnostics; it does not expand this contract or prove consumer recovery.

Native goal inspection currently returns none. No replacement goal,
public maintenance implementation, runtime, release, installation, reset or
deletion occurred. Native task binding still rejects the contained worktree plan;
actual human authority remains independently verified in the existing private
record without hook/client reconfiguration.

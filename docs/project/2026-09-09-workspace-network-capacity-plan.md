# Workspace network capacity and safe recovery

## Approval summary

Status: approved by the user on 2026-09-09; source execution active. Full-path package.

Make new managed workspace networks consume less address space and make exhausted
capacity diagnosable before provider mutation. Start with read-only diagnostics,
then add opt-in operator-owned address pools and explicit allocation for eligible
Compose workspaces. Recommend `/26` within this mode, with `/25` and `/24`
overrides and an endpoint-demand gate. This does not recover space inside existing
`/24` networks. An operator must separately approve usable address ranges before
this machine can gain capacity.

Existing networks, stopped runtimes, native Dev Container configurations, shared
Traefik networking, and Docker/OrbStack settings retain their current ownership.
No universal subnet is embedded. Unknown route or ownership evidence blocks new
managed allocation. Legacy workspaces retain their subnet on stop and resume.

User approval authorizes the source design choices below and implementation
through tested commits, ordinary task-branch pushes and one draft PR. No merge,
release, installation into the active host toolchain, host configuration change, network migration,
runtime experiment or destructive action is included. Success means synthetic
proof of allocation concurrency, recovery, route overlap, retained ownership and
compatibility, plus explicit reporting of unproven real-provider behavior. Packed
qualification may install only this built artifact in an isolated temporary test
prefix; it cannot replace the active CLI or install a new host tool.

## Execution details

### Approved decisions

| Choice | Recommended contract | Consequence and alternative |
| --- | --- | --- |
| Pool authority | Optional machine-owned `~/.config/devrouter/network-policy.json`, versioned strict JSON, scoped to Docker daemon identity; explicitly supplied disjoint private IPv4 pools and exclusions | Repository config cannot select address ranges. No policy preserves existing allocation behavior with diagnostics. Alternative is daemon-wide pool changes, outside this package. |
| Network size | `/26` default only for new eligible managed networks after policy activation; repository `managedRuntime.network.prefixLength` accepts 24, 25 or 26 within machine policy | Larger networks require explicit configuration. Never silently grow or shrink; fail with required headroom and actionable override. |
| Provider scope | Linked-worktree Compose default private bridge networks through existing Devsy and DevPod effective-config seams | Preserve image/Dockerfile-only, external/shared, explicit-IPAM and custom-driver networks. Report unsupported cases rather than pretend allocation applies everywhere. No Devsy fork required unless a concrete provider limitation is found. |
| Failure boundary | Fail before new managed allocation when routes, endpoint demand, daemon identity or ownership cannot be proven | Existing exact network reuse does not fail merely because new-network pools are full; incompatible drift or a newly observed route conflict blocks the affected start before dispatch without mutation; conflicts discovered after startup retain the runtime and claim, report not-ready and withhold route publication. |

### Evidence and ownership

Baseline: `rs/network-capacity` tracks `origin/main`, zero ahead/behind at
`1397bdd` on 2026-09-09. Isolated worktree is `trees/rs/network-capacity`.
Primary checkout remains unchanged at its earlier baseline, including pre-existing
untracked files. Project records resolve to `docs/project/`.

The existing Devrouter task explicitly retains reliability, memory admission and
lifecycle ownership on `rs/capacity-admission`, observed head `86ba2dd`. It confirms
no IPAM changes are planned. Its preferred seam is independent diagnostics from
current main and later effects within exact provider ownership boundaries. Never
hold provider locks while waiting for memory admission. Its controller/factory
work and unmerged branch are not dependencies of this package. Coordinate again
before changing provider mutation or lifecycle call sites; preserve its ownership.

Read-only aggregate Docker snapshot: context `orbstack`, server 29.4.0, Compose
5.1.2; 30 IPv4 default pools, each base `/24` and allocation size 24; 31 bridge
networks with `/24` IPv4 subnets, 30 inside those pool bases. All 23 bridges with
zero active endpoints still had retained-container references. Maximum active
endpoints on one bridge was 11. These observations are separate, non-atomic
snapshots and do not prove deletion safety or peak endpoint demand. Host route
metadata contained VPN interfaces; route values and container metadata were not
persisted. Guest routing visibility has not been qualified.

The scientific visuals and account-testing tasks own their runtimes. This package
has reserved no live subnet or network and will never operate those runtimes.
The visuals owner is independently investigating explicitly approved targeted
recovery; its changes may invalidate aggregate counts and do not authorize this
package to perform any cleanup.

Docker documents automatic allocation from configured pools and supports an
unspecified-address prefix request beginning with Engine 29. This is a possible
future daemon-managed mode, not an exhaustion fix for occupied bases. Compose
supports explicit network IPAM and separately owned external networks. OrbStack
exposes pool configuration as shared engine settings; this plan does not change it.
Sources: [Docker networking](https://docs.docker.com/engine/network/),
[Compose networks](https://docs.docker.com/reference/compose-file/networks/),
[OrbStack networking](https://docs.orbstack.dev/docker/network/).

### Primitive impact

| Product primitive | Disposition | Contract delta | Consumers and evidence |
| --- | --- | --- | --- |
| Managed workspace | Extend | Network demand and allocation readiness precede new provider effects; identity and stop semantics remain stable | ensure, workspace up, profile transitions; workspace ownership and mutation modules |
| Machine resource policy | Extend | Operator-authorized network pools are independent of memory admission and never granted by repo configuration | New diagnostics and new-network allocation; existing capacity owner retains memory policy |
| Network allocation | Create | One daemon-scoped subnet claim with exact workspace ownership, pending/attached/uncertain state and conservative reconciliation | Both provider adapters; Docker remains authoritative for actual network existence |
| Workspace cleanup report | Extend | Separate active endpoints, retained references and proven ownership; recommendations remain read-only | Existing cleanup commands, no new apply or prune mode |

[ADR 0009](../adr/0009-preserve-compose-network-ownership.md) records the accepted
network ownership and reservation trade-off. Existing workspace and memory
ownership remain authoritative for their respective contracts.

### Allocation and compatibility contract

Policy is absent by default. A validated policy names daemon identity, CIDR pools,
reserved exclusions, permitted prefix lengths and endpoint reserve (default 8).
The repository can request a larger subnet or declare an endpoint upper bound;
it cannot widen machine policy. Validate canonical IPv4 CIDRs, private ranges,
size containment, duplicates, intersecting pools/exclusions and structured values.
Keep existing `.devrouter.yml` as the sole repository configuration. Do not create
a global repository registry; allocator records contain only opaque owner keys,
network identity, claim state and subnet under Devrouter-owned machine state.
Keep canonical path/provider ownership evidence in the existing Git common-dir
owner record. Bind records to stable daemon ID as well as context; a context name
alone does not identify a daemon.

Bind every inventory, reservation, provider Docker destination and postcondition
inspection to one validated local endpoint and stable daemon ID. Reuse the existing
endpoint-pinned inspection primitive, clear conflicting Docker environment selectors,
and qualify each provider's explicit endpoint-forwarding mechanism before enabling
allocation. A mutable context name or inherited provider environment is insufficient.
If the provider cannot prove this binding, report diagnostics-only and block opted-in
allocation; do not write provider settings to compensate.

Derive network demand from the full resolved Compose service/profile union, not
just the selected warm profile. Count replicas and network memberships, retained
containers, helper attachments, explicit static reservations and bounded temporary
recreation demand. Aliases do not consume addresses. For ordinary IPv4 bridge
networks, `/26` has 64 total addresses; subtract network, broadcast and gateway
before provider-specific reservations. Eight additional spare addresses leave at
most 53 endpoints before other reservations. Unknown dynamic scale or attachment
demand requires an explicit upper bound; static IPAM remains outside allocation
scope. Validate requested demand plus reserve against the selected prefix, including
profile expansion. Report observed counts separately from inferred upper bounds.

Extend the current Compose service-name inspection to a bounded normalized model
using `docker compose --profile '*' ... config --format json --no-interpolate
--no-env-resolution`. Project only network membership, replicas and reservation
fields in memory; never persist or print the complete model or environment. Inspect
authored network declarations separately to distinguish an explicit fixed name
from Compose's generated default name. Unresolved interpolation affecting demand
requires a declared endpoint upper bound at least as large as every known lower
bound; contradictory bounds fail. Include allocation overlay bytes in the existing
configuration fingerprint, ownership marker validation and failed-start rollback.
A provider fixture must read the overlay and validate its subnet and membership,
not merely accept a generated-config path.

Use bounded, read-only inventories of Docker IPAM on all relevant networks,
all retained container network references, daemon pools, host interfaces and
LAN/VPN routes, and a qualified guest route source where the daemon is virtualized.
Exclude default routes as routing fallbacks, but preserve concrete LAN/VPN prefixes,
host routes and split-tunnel routes. A full-tunnel or ambiguous aggregate needs an
explicitly documented collector interpretation, never a blanket VPN exemption.
Normalize abbreviated masks, multiple interfaces and IPv4/IPv6 families separately.
IPv6 settings stay unchanged and are reported unsupported by the IPv4 allocator.
Missing, truncated, stale or inaccessible mandatory evidence is `unknown`, not zero
usage or safety. Initial support targets local Linux Docker and macOS OrbStack;
other contexts remain diagnostics-only until route visibility is qualified.
Use read-only Linux interface/route metadata for local Linux and macOS route/interface
metadata plus a qualified OrbStack guest route source. Collector command/version
fixtures must prove scope and failure behavior before support is enabled. An
unqualified guest collector keeps OrbStack diagnostics-only. Existing network reuse and a newly created network after exact claim/network/interface
proof may exempt only their exact connected route;
the same prefix on a different interface remains a conflict. Recheck route evidence
after startup and before readiness or route publication. New conflicts retain the
claim and runtime, return explicit not-ready status, and trigger no auto-delete.
The proof is a bounded snapshot; later VPN changes require a new diagnostic.

Choose the first aligned free block from the operator pool after subtracting all
existing subnets, pending claims, exclusions and conflicting routes. Never carve
space inside an existing `/24`, including a stopped workspace. Revalidate daemon,
policy, routes, ownership and availability immediately before dispatch.

Use one daemon-scoped allocation lock shared across the two provider paths,
nested only after the existing provider ownership lock. Memory admission and
preparation finish before either lock. Lock acquisition and inventory are bounded.
Persist the reservation atomically before provider dispatch; release the short
allocation lock before the long provider startup. Pending claims remain visible
to other allocators. Docker network creation is the final collision arbiter for
clients outside Devrouter's lock. On conflict, return an actionable failure without
blindly replaying the provider operation or leaving a misleading ready state.

Generate an ignored Compose IPAM overlay and effective Dev Container configuration
only after reservation. Preserve service network membership, aliases, isolation,
mounts, env, runServices and shared devnet. Scope managed allocation initially to
implicit/default private bridge networks with no explicit name, IPAM or external
owner. Multi-private-network requirements are diagnosed explicitly and must not
silently receive one shared network. Provider fixtures must demonstrate actual
forwarding of this config and ensure no competing native allocation remains.

Persist desired subnet across stop/resume and configuration refresh. Attach the
exact created Docker network ID to the claim after provider postcondition proof.
An existing non-managed network remains legacy-owned and unchanged. A pending
claim after crash or timeout remains unavailable until exact provider/network and
all-container evidence proves whether dispatch attached; age or a dead PID alone
never releases it. Positive no-effect proof may release a reservation record only;
this never deletes Docker resources. Unknown outcomes preserve the claim and
return the existing lifecycle operation reference. Do not build a second job or
retry controller. Policy edits and daemon changes cannot rename an existing claim.

Each claim records lifecycle operation ID, operation generation/fencing token,
provider identity, opaque workspace owner key, daemon identity, requested subnet,
config fingerprint and optional network ID. Under the allocation lock, compare
expected generation/state before transitions from reserved to attached or uncertain,
or release after proven no effect. Never acquire a lifecycle/provider lock while
holding the allocation lock; gather fencing evidence first and validate it without
reverse lock acquisition. Reuse existing lifecycle worker settlement to prove the
old operation cannot create a network later; absent-network snapshots alone never
release a claim. Stale/superseded operations cannot attach or release a newer claim.
Serialize reconciliation under the same lock. Atomic-write failures, including
a directory fsync failure after rename, prevent provider dispatch and leave the
reservation conservatively uncertain for reconciliation. Slice 2 includes this
minimum recovery before it can allocate at all.

| Existing state or change | Behavior |
| --- | --- |
| No claim, no policy | Preserve legacy allocation; diagnostics only; no automatic adoption |
| Legacy network, any policy | Preserve subnet and ownership; never adopt or migrate automatically |
| Attached exact claim, policy absent or pool removed | Claim takes precedence for exact reuse; retain subnet, perform ownership/route/headroom proof, report policy drift; no replacement allocation |
| New exclusion conflicts with attached claim | Retain state and report conflict; block affected startup without deletion |
| Prefix override after first allocation | Report migration-required mismatch; do not resize or silently ignore requested size |

| Remaining transition | Behavior |
| --- | --- |
| Claimed network missing with retained containers or unresolved dispatch | Retain claim, report repair-required; no replacement or blind retry |
| Claimed network missing with proven terminal no-effect and no references | Conditionally release reservation metadata; a fresh authorized ensure needs current policy and a new generation |
| Provider or daemon differs from claim | Block before effects; no cross-daemon adoption or automatic migration |
| Primary checkout or unsupported topology | Diagnostics and existing behavior only; explicit managed allocation request is unsupported; no new identity model |

A larger prefix applies only before the first allocation. Initial mutation support
is limited to linked worktrees with the existing durable owner record.

Network deletion, automatic prune and automatic stopped-workspace migration are
excluded. Recommendations require complete exact ownership, all-container checks,
provider and Git state, route/lock checks and a fresh inventory. Zero endpoints,
old activity or a missing worktree alone never qualify. Unknown/shared ownership
shows blockers, not deletion commands. Network removal does not remove retained
containers; their cleanup requires a separate explicit target-and-effect approval.

### Delegation Map

| Workstream | Slices | Owner | Dependency and acceptance boundary |
| --- | --- | --- | --- |
| Read-only readiness | 1: diagnose capacity | executor | Main approves schema and error semantics; synthetic reports show exhaustion and retained ownership |
| Allocation and provider integration | 2: allocate new networks | executor | After slice 1; main owns lock-order and ownership decisions with existing task; closed provider fixtures prove dispatch |
| Recovery and delivery | 3: reconcile and qualify | executor | After slice 2; main owns integration, reviews, docs and draft PR; fault matrix plus packed source proof |

### Smallest useful implementation slices

**Slice 1: diagnose capacity before mutation.** Route: executor. Add a bounded
network inventory and pure planning module, extend existing doctor/cleanup reports
and provider preflight for known exhaustion; preserve legacy reuse. Candidate
paths: new `src/core/network-capacity.ts`, network tests, `doctor.ts`,
`workspace-cleanup.ts`, existing output types and Docker failure guidance. Capture
all 30 occupied `/24` bases in synthetic fixtures without real machine values.
Acceptance: reports distinguish daemon pool exhaustion, configured-pool capacity,
endpoint capacity, route blockers, retained references and unknown evidence; a
preflight failure causes zero provider calls. One implementation commit.

**Slice 2: allocate a new managed Compose workspace safely.** Route: executor.
Add strict machine policy and optional repository prefix/endpoint request, pure
CIDR selection, atomic claims and ignored effective configuration. Integrate only
through `devcontainer-profile.ts`, `devsy-mutation.ts`, `devpod-mutation.ts` and
needed ensure call sites after owner reconciliation. Include minimum fenced claim
reconciliation and daemon pinning in this slice. Reuse existing lock/file
primitives and installed YAML support; add no dependency. Acceptance: two concurrent
processes and two providers compete for the last blocks without overlap; generated
configuration reaches each provider; collision, ownership conflict, full pools,
unknown routes and excessive demand cause no unauthorized effects. Preserve default
config when policy is absent. One coherent implementation commit.

**Slice 3: recover conservatively and qualify the package.** Route: executor.
Extend fault coverage for pending-claim reconciliation and exact network reuse across stop/resume,
profile changes and partial provider failure. Extend packed synthetic provider
qualification rather than invent another runtime harness. Update only owning
manuals, knowledge triggers and generated guidance affected by the new contracts;
keep migration instructions in eventual release-owned artifacts, without a version
bump in this package. Acceptance: the matrix below passes and produced counters
prove checks actually ran. Main reviews and publishes one draft PR after required
review gates. One implementation commit plus review corrections as needed.

### Acceptance evidence

| Boundary | Required synthetic proof |
| --- | --- |
| Concurrent allocation | Multi-process race, same workspace duplicate request, both provider routes, final free block, external Docker collision, context/provider destination switch between reservation and dispatch; unique claims or explicit failure |
| Capacity and endpoint headroom | Exhausted 30-base fixture, fragmented pools, larger prefix override, exact 53-endpoint base threshold and one-over case, replicas, helper and retained demand; actionable failure without provider mutation |
| Route overlap | LAN, VPN, enclosing/enclosed CIDRs, host routes, split/full-tunnel, default route handling, host/guest disagreement and unknown collector; successful first allocation with its new connected route, exact reused connected route versus identical foreign interface route, foreign route appearing before readiness retains runtime/claim and withholds publication; only verified candidates eligible |
| Ownership and recovery | Zero active endpoints with retained references; missing worktree; stale claim; crash before/after network creation; timeout/disconnect; delayed creation after caller death, superseded generation, concurrent settlement and fsync failure retain claim; no deletion calls |
| Compatibility and lifecycle | Existing `/24` and explicit custom subnet unchanged; stop/resume same network; full profile union; external devnet untouched; native view unchanged; both providers parse overlay, tampering and rollback, activation then policy removal, changed prefix, missing network and primary-checkout rejection; unsupported topology is explicit |

Focused Vitest tests use synthetic data and fake providers first. Then run the
repository checks applicable to source (`check:docs-policy`, `check:knowledge`,
`check`, `knip`, `typecheck`, tests, build and packed package qualification).
Use existing toolchain; no host package install. Before implementation resolve the
execution environment: this checkout has no root devcontainer configuration. If
repo-native checks require a new runtime, obtain exact experiment authority first;
do not start one just for documentation. Plan verification is host shell docs-policy
and diff inspection only. Runtime smoke commands that mutate shared networking are
not part of this approval.

Each substantive slice receives simplifier and combined risk-selected slice review
for ownership, data integrity and provider boundaries. One integrated final reviewer
checks the complete verified committed package before draft PR delivery. Planner
approval is independent from user approval. No UI/browser contract changes are
intended, so screenshots are not applicable.

### Rollout and runtime proof boundary

Source rollout stops at a draft PR with no live policy installed and no release.
No-policy users retain legacy subnet selection; diagnostics provide immediate value.
Changing to `/26` does not shrink existing networks. Future migration requires a
separate plan naming workspace, network, retained containers/volumes, disruption,
backup and rollback; none is authorized here.

After synthetic qualification, propose one isolated real-provider experiment with
exact provider versions, daemon, two disposable synthetic workspace paths, exact
network names and approved non-overlapping CIDRs. Ask separately for their creation,
endpoint attachments, stop/resume and removal, including precise cleanup commands
and effects. Revalidate routes and peers immediately before it. Test Devsy and
DevPod independently, warm reuse and the qualified endpoint limit; record provider
and Docker receipts. No host config/restart or peer runtime operations. If no
route-safe space or guest route visibility exists, stop at that blocker. Source
proof remains useful but cannot claim live recovery or universal `/26` compatibility.

### Progress

Source execution approved. Owner coordination and aggregate read-only revalidation complete.
Native planner completed three rounds: REVISE, REVISE, APPROVED. All findings
were accepted after source verification and closed. Review transcript:
`docs/project/_local/reviews/2026-09-09-network-capacity-plan-hardening.md`.
The prior supplemental mapping agent is no longer available; the native planner
and main-session source checks establish the verified integration seams. Claude architecture advice
completed DONE_WITH_CONCERNS; dispositions are recorded in the review transcript.
The accepted design preserves Compose ownership and fenced reservations; it rejects
pre-creation, reversed lock order and warning-only route safety as scope or contract
changes. Shared devnet endpoint capacity remains a separate diagnostic dimension.
Optional AGY rival pass returned no usable response after sandbox write errors;
it is unavailable, not a passed review. Docs-policy and whitespace checks pass.
Execution resumes from `1397bdd`, with zero target drift. Repository CI uses native
Node/pnpm for this CLI and there is no root devcontainer configuration; checks run
with that repository-native toolchain without creating a runtime. No policy
activation, runtime start/stop or deletion is authorized or performed.

#### Execution checkpoint

Approved plan committed as `1c14b20`; the task still tracks `origin/main` at
`1397bdd` with no target drift at the execution refresh. Dependencies installed
from the lockfile offline with lifecycle scripts disabled; no package definitions
changed. Native CLI checks require no managed runtime in this repository.

Executor Locke (`01a0865c-48e1-70c2-8807-b7d48e82cc6a`) owns the diagnostic
collector/model, focused tests and Docker error guidance. Main owns doctor/cleanup
integration, ADR 0009, provider pinning decisions and subsequent review. The
executor is active; continue the same owner, not a replacement. A narrowing
checkpoint directs it to stop discovery and produce the bounded module/API.

Baseline verification passed: 45 tests across doctor, cleanup and Docker error
guidance; documentation policy, knowledge validation and whitespace checks.
These precede new diagnostic implementation and are not feature acceptance.

Source-only Devsy inspection found that explicit provider options can persist in
the exact workspace. Invocation-only daemon pinning is not yet qualified; evidence
is in `_local/network-provider-evidence.md`. Do not compensate with shared provider
configuration writes. This does not block the independent diagnostic slice.

2026-09-09 continuation: branch remains one plan commit ahead of main `1397bdd`.
Existing Devrouter owner now works on `rs/absent-runtime-stop` from the same base,
with stop-recovery edits in mutation wrappers and lifecycle settlement. It confirms
additive diagnostics do not overlap; reconcile those wrappers before slice 2.
Lock order remains workspace, provider, then short network allocation lock.

Diagnostic implementation is in progress: bounded pinned Docker inventory, pure
IPv4 report, additive doctor and cleanup output, and address-pool error guidance.
69 focused tests pass across inventory, capacity, integration, doctor, cleanup and
error guidance. Typecheck, Biome, Knip, documentation and knowledge checks pass.
This is synthetic diagnostic proof only. Route collection remains unknown and no
provider allocation preflight or mutation integration is claimed complete.
Executor Locke completed its bounded model/tests; main verified and integrated
that result. Explorer James owns the remaining source-only endpoint-binding
question. No live network or runtime commands were issued during implementation.

# Managed fresh bootstrap

## Approval summary

Approval mode: **executable batch**. The human instruction in the requesting
chat on 2026-10-29 explicitly asks this owner to implement the reviewed cold
initialization contract and report when it is fixed and released. The trusted
delegation names regression/provider acceptance, independent review, CI and a
patch release. That sequence includes the repository's normal reviewed source
integration and release workflow; required checks and human gates remain binding.
The exact approval locator is retained privately beside the reviewed proposal.

Add an explicit fresh-only managed startup operation. A repository declares
literal bootstrap argv, target data-volume keys and shared-cache keys. One
durable pre-dispatch attempt prevents initialization replay after failure,
unknown completion, stop, replacement, settlement or journal rollover. Existing
ownership, admission, source/configuration, endpoint, population and drainage
checks continue to govern every effect. Partial data remains retained.

Qualification uses only new synthetic fixtures. The first real provider probe
has passed: skip-flagged creation preserves host preparation, public named exec
provides the tested user/workspace/Node/pnpm context, and ordinary startup runs
the original preserving hooks. No separately owned provider change is currently
required. Unsupported environment semantics must refuse rather than silently
substitute another context. The qualification is finite and version-specific,
not a claim about arbitrary images or consumer recovery.

Done means a reviewed implementation, regression and real-provider evidence,
passing CI, patch publication with immutable artifact identity, and the
authorized completion message to the requesting owner. Consumer installation,
runtime/database operations, reset/reseed, deletion and other owners' existing
environments are excluded. A necessary provider change or material departure
returns an exact decision to the human after independent work is complete.

## Execution details

Main owns branch `rs/managed-fresh-bootstrap` in the existing task worktree
`trees/rs/lifecycle-delivery`, based on main at
`1db1ae6768e5e57322eacebf66b6c1dfe7b00970`. Primary and other worktrees remain
with their owners. This is a full-path package because it changes a public
contract and protects data integrity. The existing private proposal and its
six finding dispositions remain the detailed contract and reusable plan critique.

### Primitive impact

| Product primitive | Disposition | Contract delta |
| --- | --- | --- |
| Exact managed environment/lifecycle operation | Extend | An explicit fresh-bootstrap request with one durable attempt and existing admission/fences. |
| Repository bootstrap | Compose | A literal initialization command precedes normal preserving source hooks; the repository owns DB identity/emptiness/schema semantics. |
| Resource ownership and retained data | Reuse | Exact provider/daemon/configuration/mount/population proof and non-destructive stop; no reset or deletion capability. |

### Implementation sequence

1. Extend the existing `types.ts`, `repo-config.ts`, `cli.ts`, ensure handler and
   worker request options and existing controller transport with `freshBootstrap` and `--initialize-new`. Reject
   malformed bindings, repair/recreation misuse and unsupported providers or
   execution contexts before initialization. Extend the existing durable
   operation store with one bounded receipt outside rolling operation history.
   Extend lifecycle authority helpers to claim/update it using the active worker,
   generation fence and admitted effect boundary. Tests cover real persistence,
   malformed receipts and preservation across settlement/rollover.
2. Add `src/core/managed-fresh-bootstrap.ts` and its focused regression file.
   This module serves lifecycle preflight and the ensure/provider composition.
   Resolve the full generated Compose model after preparation. Under both locks,
   prove no prior exact provider/runtime, capture complete bounded volume-name
   absence evidence, bind configuration/endpoint/daemon, and durably claim before
   dispatch. Prove new data volumes from exact current population and Compose
   labels, allowing only explicitly bound shared caches. Local data volumes with
   external/driver-backed retained storage refuse. Creation timestamps alone do
   not establish freshness; unknown evidence refuses.
3. Extend existing Devsy startup options and their DevPod delegation seam with
   one internal fresh-bootstrap composition. Its callbacks execute within the
   existing provider lock, avoiding nested lock acquisition. First start defers
   post-create/start/attach; after exact ownership and baseline capture, execute
   the declared argv through public named Devsy exec, then ordinary startup with
   original source hooks. Preserve the source/effective config provenance.
   Persist a strict stop baseline before initialization where proof permits.
   Failures/unknown completion retain the attempt and data; canonical stop
   requires the same ownership and drainage proof as other managed work.
4. Integrate through `workspace-ensure.ts`, retaining existing route publication
   and adapter ordering. Extend existing ensure/provider/worker/command tests
   for ordering, warm/repair exclusion, foreign/retained resources, concurrent
   changes, cancellation and no replay. Extend the existing lifecycle qualifier
   only where its installed-command seam needs coverage; keep one-off real
   provider scripts/receipts private. No new dependency or controller.
5. Update the owning lifecycle manual, knowledge paragraph, bundled skill and
   AI prompt for the actual contract. Record generic roadmap status. Run native
   checks, focused static analysis, independent integrated review and appropriate
   simplification of the coherent implementation. Prepare patch metadata and
   qualify its packed artifact before the approved reviewed integration/release.
   Verify release source, npm integrity and executable bytes; report supported
   configuration/commands, cleanup and remaining prerequisites to the owner.

### Acceptance

- Persistence and no replay: duplicate/new requests, unknown/failure/cancellation,
  settlement, rolling history, registration loss, ordinary startup and actual
  replacement cannot re-dispatch initialization. Missing evidence grants nothing.
- Positive ordering: host preparation and effective mounts, deferred hooks,
  initializer once, original preserving hooks, managed adapter/readiness and
  routes last. User, workspace, environment/toolchain and endpoint are qualified.
- Refusals: existing/foreign volumes, unknown ownership/completion, live worker,
  changed provider/daemon/configuration/mount/population, invalid DB identity or
  nonempty main/shadow DBs. DB checks remain consumer-owned; no inferred reset.
- Real synthetic work: actual DB values and relationships survive stop/resume
  and one application replacement. Verify the replacement and volume attachment;
  metadata alone is not content proof. Every touched fixture ends stopped with
  zero routes and retained data. Use small bounded resources and no broad prune.
- Delivery: all required source/CI/review checks pass on the held candidate;
  merged/released trees and packed/published bytes have separate exact identities.
  No consumer is declared recovered by the source release.

## Progress

- Delivery completed: PR #169 merged at
  `525b4e23f2e4cb0ac3319a1abedde59020680d28`, complete tree equal to reviewed
  `094d7d8d801ebccc0ff7cb00cec73aaef6583c89`. Release
  [v0.6.3](https://github.com/rschlaefli/devrouter/releases/tag/v0.6.3) and
  [release workflow](https://github.com/rschlaefli/devrouter/actions/runs/41075117143)
  pass. Registry integrity and all 105 package members match the tested package; the
  explicitly approved exact Volta installation also matches every member and
  all PATH-visible entries select 0.6.3. The registry omits gitHead, so source
  proof uses the actual tag, equal Git trees and complete package byte equality.
  The requesting recovery owner's notice could not be confirmed because its
  task host was unavailable; other authorized owner notices were delivered.
- Later receiving evidence confirms task-local 0.6.3 and official Devsy 1.24.0
  agent adoption. That owner's consumer has not started. Its required application
  replacement has no supported public 0.6.3 entrypoint; the proposed extension
  below records this newly verified acceptance gap.
- The existing consumer owner delivered the approved preserving post-create
  adaptation at `79cd33357a18e0581ee480f0e1837dacef17a666` in
  [draft PR #6652](https://github.com/uzh-bf/klicker-uzh/pull/6652).
  Native checks and independent review pass. Hosted codebase CI cannot run on
  the conflicting draft; the human approved a DEV-only exception to that
  prerequisite for this exact candidate. Consumer CI and merge remain blocked.
  Ordinary ensure conditionally selects retained repair; the preserving hooks
  also protect the ordinary provider-start branch. Empty-schema startup now
  refuses rather than initializing implicitly; fresh adoption remains separate.
- The one approved ordinary full-profile ensure completed in 86.426 seconds
  using selected 0.6.3, with a completed, drained operation and no runtime drift.
  Both marked restricted databases passed read-only identity/schema checks.
  The owner verified retained content, delegated login and sampled application
  interactions. Full acceptance is blocked by a consumer PWA server-render
  `localStorage is not defined` crash at `useDefaultLayout`; student manual and
  active-block selection remain unverified. Compact German evaluation also
  overflows horizontally. Canonical stop recovery completed in 74.827 seconds.
  Final readback proves the exact provider and original containers stopped,
  retained mounts and volumes, zero checkout routes and no active journal
  worker. The journal's last operation is an earlier drained `exec`; its ID is
  not evidence for a stop operation. Synthetic quiz state changes may persist;
  stop is not rollback. The startup allowance is consumed. The consumer owner
  retains the SSR correction; a further runtime attempt requires a new bounded
  approval.
- The consumer's focused SSR correction is now reviewed and pushed at
  `28950b8c0a16cbc40d55d3d7b9642658ddf19d8e`. Real-hook source regressions and
  isolated hydration pass. Actual corrected-head PWA checks and browser
  acceptance remain pending; the independently reviewed retest packet awaits
  new runtime and exact-head DEV CI-exception approval. The runtime stays stopped.
- Current continuation, 2026-10-30: the existing goal targets
  ordinary preserving startup plus owner-verified consumer acceptance. The
  source correction in PR169 is released from reviewed candidate 094d7d8d.
  Source acceptance does not close the consumer or provider qualification gates.
- The bounded isolated agent-acquisition probe used existing
  `prepareDevsyAgent` with task-local cache/lock paths. Official Devsy1.24.0
  Linux arm64 acquisition and verification passed; inspection changed from
  host-governed to managed-ready without changing shared setup. A new exact
  synthetic replacement captures per-source evidence: no explicit binary,
  incompatible Darwin executable, provider cache at1.19.0, and official1.24.0
  HTTP acquisition failing DNS lookup. This diagnoses that producing run, not
  every prior failure or a general transport outage. The replacement must reach
  terminal state and canonical stop; both subsequently completed, with stopped
  provider, zero routes and zero running attributed containers.
- The human explicitly approved the exact shared1.24.0 cache preparation and
  synthetic replacement. Existing verified acquisition populated that version's
  official manifest and Linux arm64 agent without changing provider selection
  or installing a CLI. Correct replacement then exited0; actual injected bytes
  match the official asset, the app container ID changed, named volume identities
  stayed equal, and actual main/shadow parent-child values survived preserving
  startup. Repeat initialization refused. Final canonical stop and provider/route
  readback pass. Producer remains executable source e138da8e; private receipts are
  `/private/tmp/devrouter-acquisition-20261030/verified-replacement-proof.json`
  and `approved-cache-proof.json`. The historical release hold below is resolved
  for this verified-cache combination; release/installation/consumer acceptance
  remain separate. Existing source reviews and exact-head checks are reusable.
- Read-only candidate doctor against the exact pilot reports consistent capacity
  history without modifying its journal or ledger. The candidate validator accepts
  the named private journal. No history restoration or guard bypass is needed for
  this observation. The pilot owner retains startup and hook-effect acceptance;
  no consumer mutation or database query ran in this continuation.
- Root outcome: explicit safe managed first initialization, then preserving
  everyday startup, without blocked or silently replayed initialization.
- Authorized terminal: qualified patch release plus owner notification, or a
  concrete separately owned provider/material-contract blocker.
- First useful acceptance: native provider deferral/literal exec/preserving
  replay. It passed on one new 1-CPU/512-MiB synthetic fixture with Devsy 1.19.0.
  Node/pnpm/user/workspace/PATH and declared remote environment matched. One
  initializer and one preserving/post-start invocation occurred; canonical stop
  proved provider stopped, zero routes and no running attributed containers.
- Source/tag qualification: Devsy 1.19.0 source
  `a48146d3712ed32bee7672571ded299b0e490914`. Internal hook replay/config-apply
  paths were rejected as substitutes after an offline installed-CLI probe showed
  missing login-probed PATH. The public composition is the qualified candidate.
- One independent source-level consultation returned findings on replay/context,
  host preparation and resource proof. The first provider fixture closes its
  positive replay/preparation/context uncertainty for that tested configuration;
  no universal environment equivalence or consumer-image proof is inferred.
- The versioned mount producer passes a pure synthetic transformation on pinned
  Node 24.16.0. Actual consumer package/mount populations remain owner-qualified.
- Product implementation is in progress; release remains pending. Current published CLI is 0.6.1.
- The parser, durable attempt, startup composition and explicit controller intent
  transport are implemented. Initial native suite: 3,452 passing tests, with 13
  platform skips. New refusal and exact Git-mount cases await the next check.
- Linked-checkout rendering reuses the existing Compose environment helper. Only
  the exact primary-service Git common-directory mount is admitted outside the
  checkout; this is required by the existing linked-worktree contract.
- Fresh initialization is restricted to observed Devsy 1.19.0. Existing ordinary
  startup retains its broader provider support. A matching controller is required
  for explicit initialization on an already capacity-managed environment.
- The native task-binding command cannot resolve a plan inside the task
  worktree beneath this primary checkout. Authority is recovered from the actual
  human instruction; no hook or client configuration was changed.

- Candidate package: [draft PR #168](https://github.com/rschlaefli/devrouter/pull/168).
  Initial exact-head CI passed. The later failure-retention correction and patch
  metadata require final-head CI. Substantive source/tests are about 1,400 lines;
  the single package follows one startup operation across existing transports.
- Product fixture proves initialization once before preserving hooks, generated
  dependency mounts, matching execution context, actual PostgreSQL parent/child
  values in both synthetic databases, repeat-request refusal and stop/resume.
  Its canonical final stop proves stopped provider and zero exact routes. An
  earlier fixture rejected ambiguous service DNS before initialization; it also
  ends stopped. No consumer acceptance or data operation is inferred.
- The initial failure exposed pre-helper process rollback. A focused correction
  retains the already-proven degraded baseline without additional resource or
  process mutations; its startup regression passes. Provider configuration is
  revalidated again immediately before each initialization/replay boundary.
- Simplifier returned DONE with no net preserving simplification. The internal
  source path is already canonicalized by workspaceEnsure, disposing its path
  spelling handoff. The final reviewer will cover the subsequent correction.
- Native suite: 3,470 passing tests and 13 platform skips; 177 focused tests pass
  after the final provider revalidation. Typecheck, docs/knowledge and packed
  0.6.2 smoke pass. Exact final-artifact qualification and integrated review remain
  pending; no release has occurred.


## Devsy 1.24.0 qualification extension — 2026-10-30

Approval mode: executable batch. Actual human authority is the requesting recovery
chat's approval of “qualify 1.24.0 and release a compatible patch if verification
passes”, answered “yes” in turn01a18c1b-2e4e-71c1-b2b5-f81a9c0543de. This extends
only the qualified fresh-bootstrap provider versions. Main owns the existing
clean task worktree on branch `rs/fresh-bootstrap-devsy-124`, based on released
main5118a8283d2ecd86854b42f58f22e8fb39a8c2c7. Existing ownership, storage,
context, replay and partial-data guarantees remain binding. No consumer
installation/adoption, global/provider setup changes, consumer runtime/database
work, reset/reseed, deletion or existing environment action is authorized.

Root outcome: the same safe fresh-only operation works on explicitly qualified
Devsy1.24.0 without downgrade or weakening version/storage/context fences.
First acceptance: official checksum-verified isolated1.24.0 host and Linux
agent, version-matched source inspection, and a new synthetic deferral/named-exec/
host-preparation/source-hook replay probe. The1.19.0 evidence remains valid;
only changed provider behavior needs new producing evidence. Reuse the original
plan critique and primitive table because the operation and guarantees are
unchanged. A newly discovered provider or contract gap returns a concrete
boundary instead of broadening this batch.

Sequence: qualify exact1.24.0 source/flags/options/markers/context; execute new
bounded synthetic success/failure/cancel/unknown probes with existing fixture
invariants; make only evidence-warranted compatibility changes and version
tests; update owning current guidance and patch artifacts; native checks,
independent final review and exact-head CI; source-identical merge and patch
publication; registry integrity/byte proof and completion handoff. Reuse prior
storage/Git/cache/worker regression coverage and exercise those actual seams
with the new provider. Every touched fixture ends canonical-stopped with zero
routes and retained data. Neither settlement nor lost registration/completion
may rearm initialization.

Terminal: compatible qualified patch publication and owner notification, or a
precise provider/material-guarantee blocker after independent work. The selected
global Devsy here remains1.19.0; qualification uses a task-local official1.24.0
binary and matching verified Linux agent without persistent provider setup changes.


Qualification progress: released 0.6.2 is main5118a828; its completed CI,
review, package and stopped-fixture evidence remain valid for the original
1.19.0 contract. The isolated 1.24.0 public-provider probe passed on a new
1-CPU/512-MiB fixture: host preparation survives skip flags, literal argv
remains literal, UID/workspace/Node/pnpm/PATH/declared remote environment match
source preserving hooks, initialization runs once and later ordinary up runs
post-create/post-start once. Canonical stop proves stopped provider, zero
routes and zero running attributed containers, with data retained. Official
source ref1f47cd185bd134b45cdce12b947f6c601d76d329 and verified Darwin/Linux
release assets underpin the probe. Native focused checks pass38 tests.

The compatibility candidate admits only exact1.19.0 and1.24.0; neighboring
untested versions still refuse. No knowledge concept changes: this expands
one explicitly qualified version without changing lifecycle, context, storage
or ownership invariants. Real product failure/cancel/unknown, linked storage,
final native/review/CI and publication evidence remain pending.


## Shared routing and orchestration follow-ups — 2026-10-30

Status: recorded for separate shared-tooling delivery. The human requested these
retro priorities be added to the plan. This records work and acceptance criteria;
it does not authorize shared configuration changes or fold them into the Devsy
compatibility release. Existing Devrouter lint, type, test and package CI checks
remain the baseline. Main coordinates handoff; the shared routing, hook and
qualification-tool owners implement their respective fixes.

1. **Role and default resolution.** Owner: shared model-routing/dispatch tooling.
   A named reviewer must retain its configured model when global defaults differ.
   Exercise disagreement among global defaults, role settings and the active
   tool's accepted models. Assert requested and resolved role/model/effort,
   explicit fallback provenance, and a useful source-capable review. Unsupported
   models must produce a specific launch failure rather than silently select the
   global default. The current native default dispatch rejected an unavailable
   Combo model; an explicit supported native fallback worked. That observation
   does not establish the underlying resolution cause.
2. **Separate launch, transport and review outcomes.** Owner: shared orchestration
   result classification. Preserve evidence for each boundary: process launched,
   transport delivered a model response, source tools ran, and review met its
   contract. The supplied retro reports 40 successful GLM simplifier source-tool
   operations, then two unusable blocked reviewer results with no source reads.
   Those reviewer results do not prove a general proxy outage. A WebSocket 426
   warning followed by a response does not prove terminal transport failure.
   Regression cases must retain successful source operations and response
   delivery while classifying empty-source reviews as incomplete. Verify the
   producing counters rather than inferring success from an output schema.
3. **Context and diagnostic overhead.** Owner: shared workflow invocation and
   diagnostic callers. Apply the existing scoped-read and output-budget rules;
   avoid adding another global instruction layer. Pass bounded path/field scopes,
   project large tool results before displaying them, and read only the relevant
   skill sections. Acceptance is a representative run with complete necessary
   evidence, compact summaries, explicit omissions and no repeated truncation or
   redundant full-skill loads. Preserve actionable errors and exact identities.
4. **Worktree-aware task binding.** Owner: shared task-alignment hook/runtime.
   Accept the approved plan beneath a verified task worktree's single artifact
   root while retaining the primary repository/session identity and real human
   authority locator. Cover primary and linked checkouts, matching Git common
   directory, canonical paths, and missing/stale/foreign plans or worktrees.
   Reject path escape and unrelated checkouts. Do not copy a plan into the clean
   control checkout or loosen binding merely to satisfy the current validator.
   The current command cannot bind the approved nested task-worktree plan.
5. **Qualification fixture preflight.** Owner: fixture harnesses, with shared
   orchestration validation for required inputs. Before dispatch, validate the
   exact new checkout/destination, source-path-resolved provider identifier when
   one is required, the exact generated descriptor and linked-worktree environment,
   and unique database aliases. Before data effects, qualify
   the complete target database identities; a generic shared-network service
   hostname is insufficient. Negative cases for ambiguous aliases and undefined
   identifiers must refuse before provider mutation or SQL effects. Preserve
   known failure versus unknown completion, partial data and final ownership
   proof. Include queue-aware deadlines: this run's first cancellation harness
   expired before provider creation, so it is not post-initialization acceptance.

Completion for these follow-ups requires producing shared-tooling evidence and
separately reviewed source changes under their owner's authority. A Devrouter
release, a fallback reviewer or a passing existing CI suite does not close them.


## Devsy 1.24.0 qualification checkpoint — release held

Historical checkpoint, superseded by the verified-cache qualification in
Progress above. The earlier failure evidence remains below; replacement now
passes for that prepared combination. Publication and consumer acceptance are
still separate gates.

Status: compatible source candidate in draft PR169; no merge, publication or
installation. The conditional release gate remains open because a correctly
configured provider replacement failed agent acquisition. The next boundary is
a scoped provider-acquisition diagnosis or qualification under a verified
provider preparation contract, without changing shared setup in this batch.

- Tested implementation/package revision:bd18e2d91315063092229077d2510716a5d2fdf5,
  version0.6.3. Native3475 tests pass with13 platform skips; docs, knowledge,
  Biome, Knip, typecheck, build, package smoke, scoped static checks and packed
  controller qualification pass. Independent final review inspected all11
  original paths and necessary provider source with no findings. Candidate
  CI41034938277 and documentation-head CI41036588463 pass. Later changes are
  project-status documentation; executable hashes remain equal to this producer.
- Isolated1.24 host and actual injected Linux agent match official release
  checksums. Deferral, host preparation, literal named-workspace exec, non-root
  context equality and original hook replay pass. Fresh product initialization,
  restricted-role PostgreSQL main/shadow retained values, failure/cancellation,
  preserving recovery, stop/resume and repeat-initialization refusal pass.
  Durable attempts remain ready/failed/initializing after final stop; no worker
  remains. Fresh storage, generated dependency mounts, explicit external cache
  and exact linked Git-common-directory seams were exercised.
- Two fixture defects were isolated from product behavior. The first cancellation
  deadline expired while queued before provider creation; it created no attempt
  or runtime. A new fixture reached initialization before cancellation. The first
  linked replacement omitted workspace environment and selected the default
  overlay; strict stop and recovery refused that mismatched population. Corrected
  preflight verifies exact provider/path, workspace/Git context and retained
  source/effective plan fingerprints before the same bounded replacement.
- The corrected replacement reached provider error
  `inject agent: [inject] open binary: agent binary not found` after its injection
  phase. This is producing provider evidence, not a general network/proxy outage
  diagnosis. Supported `stop --repair` then preserving ensure, actual retained
  database checks, replay refusal and final stop pass. That recovery does not
  establish a clean successful provider recreation or resolve agent acquisition.
  Hold the compatibility release until that remaining boundary is qualified.
- Fresh final checks account for five exact task fixtures: four registrations are
  stopped, the early queued fixture is positively absent, all have zero routes
  and zero running attributed services, and existing data/volume identities are
  retained. No deletion, shared provider configuration, global installation or
  consumer operation occurred. Published0.6.2 remains the available release;
  fresh initialization on1.24.0 remains unreleased and consumer recovery unknown.

## Proposed public managed application replacement — 2026-10-30

### Approval summary

Status: approved for the finite implementation and conditional synthetic qualification batch below. No merge, release or installation authority is included.

The receiving consumer requires a supported application-container replacement
before beginning its finite acceptance run. Released 0.6.3 can initialize and
resume its qualified provider combination, but cannot request that replacement
through its public managed CLI. The successful producer used internal locked
APIs. It does not supply the missing public operation contract.

Recommend an explicit `ensure --replace-app` intent, reusing the existing ensure
worker, ownership proofs and provider mutation lock. This is proposed syntax,
not a command in 0.6.3. First support only a positively stopped, manual Devsy
1.24.0 managed Compose checkout with unchanged configuration and declared named
volumes. Replace its primary application container and writable layer; preserve
named storage, bind mounts and dependency containers. Refuse anonymous or
unattributed volumes before effects because the provider removes the primary
with `rm -v`. Application hooks must have a qualified preserving contract.

New approval would cover implementation, native regression checks, independent
review, normal task-branch/draft delivery and one conditional synthetic provider
qualification described below. Publishing, global installation and real consumer
startup remain separate. Declining preserves current behavior and the receiving
consumer's preflight block. No runtime, tool installation, provider change or
data operation is authorized by this proposal or its critique.

### Verified contract and scope

Evidence baseline: released Devrouter
`525b4e23f2e4cb0ac3319a1abedde59020680d28`; its executable tree equals the
current documentation branch. Devsy source is
`1f47cd185bd134b45cdce12b947f6c601d76d329`.

- Public ensure registers no replacement option. Managed start, preflight and
  readiness failures throw before the legacy recreation fallback. See
  [CLI](https://github.com/rschlaefli/devrouter/blob/525b4e23f2e4cb0ac3319a1abedde59020680d28/src/cli.ts#L188)
  and [managed startup](https://github.com/rschlaefli/devrouter/blob/525b4e23f2e4cb0ac3319a1abedde59020680d28/src/core/workspace-ensure.ts#L1359).
- Internal `startDevsyWorkspace({recreate:true})` revalidates exact ownership
  under the existing provider lock. The producer additionally used the checkout
  lifecycle lock, but bypassed the public worker request/admission transport and
  explicitly excluded allocated-network claims. Its named-volume and actual
  synthetic-data evidence remains valid for that selected test.
- Devsy's Docker driver removes the exact primary ID through
  [its helper](https://github.com/devsy-org/devsy/blob/1f47cd185bd134b45cdce12b947f6c601d76d329/pkg/docker/helper.go#L434).
  Docker documents that `rm -v` removes anonymous volumes and retains explicitly
  named volumes. [Docker CLI](https://docs.docker.com/reference/cli/docker/container/rm/)
  The primary writable layer is replaced; this is not arbitrary-state retention.
- The intended receiving lane has no allocated-network claim or capacity
  enrollment. Ordinary Compose networks and external devnet are distinct from a
  Devrouter network allocation. Invalid history or other admission evidence still
  refuses; absence of enrollment never authorizes discarding evidence.
- Retained Compose overlay apply/restore remains a separate, unsupported
  transition. Descriptor hashes do not establish that contract; exact service
  startup uses `--no-recreate`, and retained checks compare actual service hashes.
  Variants retain ADR 0013's process-input meaning. A same-path overlay edit,
  raw provider command, private API import or intentional failure is no public
  replacement/reconfiguration procedure.

### Primitive impact and behavior

| Primitive | Disposition | Required contract |
| --- | --- | --- |
| Exact managed environment | Extend | One explicit primary-container replacement, retaining the same checkout/provider/project and declared persistent resources. |
| Lifecycle operation | Reuse and extend intent | Carry replacement through the existing fenced ensure request and worker. Admission, cancellation, drainage and unknown completion retain their meaning. |
| Repository application data | Reuse ownership | The repository owns preserving hooks and semantic data checks; Devrouter never infers a reset or replay permission. |

The public ordering is a proven canonical stop, the proposed explicit replacement
ensure, ordinary canonical exec acceptance and final canonical stop. The option
is never inferred by ordinary ensure or background recovery. It rejects repair
or fresh initialization in the same request, running/busy/unknown populations,
changed profiles/variants/configuration, incomplete ownership, anonymous mounts,
dependencies sharing the primary's network/PID/IPC namespace, allocated-network
claims and capacity-targeted/enrolled/retained-managed state
before preparation, journal dispatch or resource mutation. Invalid global
admission/history remains fail-closed.

Preflight binds the exact stopped generation, descriptor and ordered Compose
inputs, rendered service identities, provider/daemon endpoint, primary ID, named
mounts, dependency population and source/hook bytes. Revalidate at dispatch and
after provider return. Namespace absence must cover all containers on the selected
daemon, including stopped or foreign containers outside this project. Resolve
network/PID/IPC reverse references by full ID, accepted ID prefixes and names.
Incomplete or unstable inventory refuses. Repeat this proof while holding the
existing provider lock immediately before dispatch.

Persist replacement authority before destructive dispatch, not only in worker
options. Bind the durable attempt to the stopped generation, old primary ID,
preflight digest, operation and worker. Keep it through cancellation, canonical
stop, settlement, history rollover and new request IDs. An unknown attempt cannot
rearm. Observation may settle a proven completed or never-dispatched attempt;
it cannot replay the destructive action. A missing old primary after interruption
is not a fresh-create permission.

The existing operation store owns this receipt and its strict schema, private
file guards and fenced updates. Store it by exact identity under
`~/.config/devrouter/replacement-attempts/`, outside the strictly enumerated
reliability-journal directory. This is direct operation-authority lookup, not a
repository discovery registry or another lifecycle engine. Use existing journal,
workspace and provider locks; do not add a separate lock system. A receipt write
or journal acknowledgment failure grants no dispatch authority.

Keep existing journal shapes readable by released 0.6.3. A new unknown journal
field or entry would make its global enumeration fail. Prove compatibility with
that released reader and show that its guarded ordinary recovery cannot replay
the replacement or erase its receipt. Reconciliation of an unknown replacement
uses the matching implementation; no caller strips an authority record. If this
compatibility cannot be proved, stop before live qualification and return the
exact protocol limitation rather than broadening rollout or changing readers.

Success requires a changed primary ID, unchanged dependency IDs and persistent
mount identities, current helper/session/process ownership, preserving hook
execution and no initializer replay. Prove infrastructure before normal route
publication, then verify application readiness through the published routes.
Capture
the new stop baseline before application checks can fail. A failure retains
evidence and data, withdraws unproved routes, and exposes a bounded canonical
stop/repair path only when its existing proof requirements hold. No unknown
worker kill, automatic second replacement, volume deletion or fence clearing.

### Proposed finite execution batch

Boundary owner: this Devrouter task. Consumer source, runtime and reset planning
remain with their existing owners. On approval, use a separate repository-local
`rs/managed-app-replacement` worktree/branch from the freshly resolved main target;
preserve the existing documentation draft. Continue this multi-phase plan there.

1. Extend existing CLI/ensure, reliability request/worker/operation-store,
   managed stop/population and Devsy mutation seams and their existing tests.
   Include durable receipt schema, atomic persistence and compatibility checks.
   No Devsy provider source/API change,
   lifecycle state machine, global lock, dependency or repository registry.
   Add the explicit-intent decision as ADR 0015 (next free number at execution),
   and update the owning lifecycle manual/knowledge, bundled skill and AI prompt.
2. Run repository-native static/type/test/build/package checks. Review the whole
   committed source delta for correctness, preservation, integration and security
   before effects; handle one focused correction through the same reviewer.
   Ordinary task-branch pushes and a draft PR are part of the requested delivery.
3. Only after held-source review, required CI and exact packed-byte proof pass,
   qualify the public packed CLI on ONE new synthetic linked checkout at
   `/private/tmp/devrouter-managed-replacement-20261030/managed-replacement-q30`.
   Reuse the prior Node 24/Postgres 16 fixture's existing immutable images and
   verified Devsy 1.24 agent; use unique new named volumes and no existing
   consumer data. Missing images or agent prerequisites block this branch;
   no new image build/pull or provider installation is requested. Cap running
   fixture containers at an aggregate 2 CPU/2 GiB and the qualification at
   45 minutes, plus up to five minutes for terminal canonical stop. No paid
   inference or global installation.

The one fixture sequence initializes synthetic main/shadow parent-child data,
stops, resumes ordinarily once, stops, performs one explicit app replacement,
proves actual retained values/relationships and readiness, then stops and proves
zero exact routes. Record immutable image, CLI, source, provider and resource
identities. Canonical commands run once per declared step; this is not authority
for repeated fresh fixtures or replacement retries. Native negatives cover
faults without introducing live fault injection.

On the first material qualification failure, capture bounded evidence, cancel
only the recorded owned caller through supported drainage, and attempt one exact
canonical stop/repair within its existing proof contract. Refusal or uncertain
cessation remains unknown. Keep data and artifacts; no cleanup, reset or broad
prune. The terminal is a reviewed source/CI/draft package plus truthful public-CLI
qualification, or the exact blocked dependency. It does not itself publish a
release or unblock real consumer adoption.

### Test portfolio and evidence limits

| Consequential behavior | Existing evidence | Required added proof |
| --- | --- | --- |
| Public intent and compatibility | Ordinary managed ensure refuses legacy recreation; command tests cover current flags. | Extend parser/worker tests for explicit intent, incompatible options, alias parity and unchanged ordinary behavior. |
| Ownership and persistent resources | Existing stop/population/provider tests and selected internal replacement receipt. | Refuse unknown/running/stale/config/mount/anonymous-volume cases; include daemon-wide foreign/stopped namespace references by ID/name and under-lock races. Prove primary-only replacement and unchanged dependency/volume identities. |
| No replay or duplicated mutation | Existing durable initialization and worker/fence tests. | A stopped-generation/old-primary-bound durable attempt survives cancellation, stop, rollover and a new CLI request ID without replay. Existing 0.6.3 journal enumeration remains valid and older recovery cannot erase or replay replacement authority. |
| Post-mutation recovery | Existing managed stop and external-population repair tests. | A newly proved replacement publishes its own stop baseline; partial failures preserve evidence and valid stopping without unknown adoption. |
| Useful consumer work | Internal Devsy 1.24 synthetic replacement preserved actual data. | Exact packaged public command preserves main/shadow relationships through stop/resume/replacement and ends stopped. Actual consumer acceptance still belongs to its owner. |

Arbitrary overlay/network/port changes, data-service replacement, allocated
networks, controller enrollment and reset recipes are not qualified by this
batch. They require a separate transition design and explicit approval; the
populated-reset planning owner should keep that exact gap visible.

### Proposal progress

Source/contract investigation is complete; implementation and live qualification
are unapproved. The first useful result is a truthful public-command capability
boundary before the receiving owner creates its finite consumer runtime. The
independent plan critique approved the corrected scope after two verified
findings: durable authority must survive new request IDs, and namespace proof
must include foreign and stopped containers outside the managed project.
The existing operation store owns the receipt; released-reader compatibility
must pass before live effects. The next step is a concrete human ruling.
Provider-level preservation remains evidence, not public support.


### Replacement execution progress — 2026-10-30

Actual human approval: recovery task `01a188fd-2c10-7e10-b62a-de8509b08f20`, turn `01a18e16-4de1-7340-951c-c6f2a1957f8a`, user message `01a18e16-4eee-7682-ad40-c8c721303eca` answered “approved” to the explicit implementation/review/CI/draft plus conditional 2 CPU/2 GiB/45-minute fixture and five-minute stop card. Main independently read that human message and preceding card. The immutable reviewed proposal is `35801825e99da2f6ef1cab8ca1323cc9051f1051`; its independent plan critique remains applicable. This supersedes the proposal's pending-approval descriptions only for the named replacement batch.

Main owns `rs/managed-app-replacement` at `trees/rs/managed-app-replacement`, based on freshly fetched `origin/main` at `525b4e23f2e4cb0ac3319a1abedde59020680d28`. Full-path package; unchanged explicit-intent contract and critique are reused. Existing documentation draft PR #170 (https://github.com/rschlaefli/devrouter/pull/170), consumer ownership, maintenance planning and pending pilot runtime question remain separate. Root outcome is a supported preserving public replacement on the receiving path. First useful acceptance is durable no-replay and released-reader/guarded-recovery compatibility, before conditional live effects. Terminal is reviewed source/CI/draft plus truthful bounded packed-public-CLI qualification, or exact blocker. No source checks or new runtime effects have yet run.


Replacement candidate progress: implementation now carries explicit replacement through both public ensure aliases and the manual fenced worker. The existing operation store owns a strict private single-use receipt outside journal enumeration. Daemon-wide stopped/foreign namespace references, anonymous primary volumes, changed source/configuration, capacity/network state and unproved ownership refuse. A retained non-primary dependency is required to anchor released-client degraded recovery when the old primary is absent. This narrows the first supported population; the approved PostgreSQL fixture and receiving consumer already have that dependency. One attempt per exact checkout is conservative and never rearms. ADR0015 and owning lifecycle guidance record these limits. No release version or installation changed.

First native receipt/inventory run passed208 tests; managed stop/replacement preservation passed110 tests. The integrated native suite passed3507 tests with13 platform skips before final transport and corruption cases; final-head rerun is pending. Typecheck, Knip, docs and knowledge checks pass. Focused Opengrep auto rules report0findings across10 changed executable files. Build and isolated package smoke pass. macOS process-helper checks report the existing Linux/proc skip. The actual checksum-matched released0.6.3 worker reader/enumerator/writer accepts the candidate journal, retains the external receipt through stop/history rollover and refuses its guarded repair with a missing primary. This closed synthetic probe allowed0provider effects and excludes workerIPC/live recovery; exact candidate bytes are recorded privately. Native tests require host process inspection because sandboxed ps is denied; guards remain unchanged.

The configured Combo child route failed before source work with unknownmodel; main retains implementation. The native binding validator still rejects the contained task-worktree plan; actual humanauthority remains independently verified and recorded. No hook/clientconfiguration was changed. Source is nearing candidate commit; independent integrated review, CI, exact packedbytes and the conditional bounded live fixture remain pending. No new runtime was started and no consumer has been unblocked by this source work.


Candidate finish state: scoped public-intent/provider checks pass175 tests; the final suite passes3511 tests with13 platform skips except a new regression fixture's non-monotonic synthetic clock. The fixture correction passes all117 store tests and changes no product behavior. Candidate source remains subject to committed independent review and CI. Required focused native checks, typecheck, Biome (one pre-existing warning), Knip, docs/knowledge, build, isolated packed smoke and released-reader compatibility are recorded privately. Scope is one integrated ensure intent across its existing command/worker/store/provider/recovery seams, approximately1100substantive source/test lines. No new dependency, lifecycle engine, global lock, release metadata, runtime or consumer effect. Screenshots do not apply to this nonvisual CLI change.

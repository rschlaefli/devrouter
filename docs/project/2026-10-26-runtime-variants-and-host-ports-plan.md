# Runtime variants and workspace host-port discovery

## Approval summary

Status: Approved executable batch on 26 October 2026. User instruction:
"approved, go on" after presentation of both choices. Target: `main`, inspected at
`1df0d0a627d44ab7c31cb5de9106db050eb469a5`. Branch:
`rs/runtime-variants-and-ports`. No PR exists for this package.

Let a repository choose how its managed processes run without changing which
resources its profile selects. Add `devrouter ensure --variant <name>` and the
same option on `workspace ensure`. Pass the selected name to the repository
adapter, include it in process identity, and retain it through repair and
rollback. Repositories own commands, build plans, and build-generation identity.

For concurrent workspaces, let Docker allocate ephemeral host ports from the
consumer's Compose declaration. Add discovery of explicitly declared service
ports and expose the proven numbers to post-start and `devrouter env`. Devrouter
will not select a free port before startup or rewrite consumer Compose files.

The proposed first version supports variants on the manual managed lifecycle.
Non-default variants are refused for capacity-managed lifecycle requests and
enrollment because existing capacity admission describes profiles alone. Port
discovery works with either admission policy. Existing configurations retain
their default behavior. Switching a variant replaces only owned processes;
allocated ports may change when Docker recreates a service container.

Approval starts one source package: implement, test, review, commit, push the
task branch, and create one draft PR. Include bounded local qualification using
two synthetic checkouts, then stop their exact runtimes. Completion requires
passing applicable checks, integrated review, qualified variant/port behavior,
and verified cleanup by non-destructive stop. No new dependencies, paid cloud
resources, or recurring infrastructure costs are planned. Local Docker work and
configured model reviews consume existing resources; their duration is unmeasured.
Merge, ready status, release/publication, consumer adoption, deletion, and
cluster changes remain outside this batch.

## Approval choices

1. **Runtime selection.** Recommend a separate, declared `--variant` selector
   with a default of `default`, initially limited to manual managed runtimes.
   The alternative is repository-owned marker files until controller admission
   can also model variants. Approval includes owned-process replacement and
   exact repair/rollback; it does not permit arbitrary commands or environment
   overrides. Refuse unsupported requests before lifecycle intent, preparation,
   provider actions, or controller sessions are created. Preserve existing
   runtime and data on refusal. Success is default/CI/default switching with
   unchanged container identity and repeat-ensure process reuse. This choice
   authorizes source/test/docs changes, configured reviews, local commits,
   ordinary task-branch push and one draft PR, plus bounded synthetic local
   qualification ending in exact stops. Existing local compute and model usage
   apply; duration is unknown. Failed candidates use exact rollback or remain
   degraded; retained artifacts are reported. Terminal: reviewed source, passing
   applicable checks/CI and variant proof, stopped fixtures, and an accurate
   draft PR. Merge, ready, releases, adoption and deletion remain withheld.
2. **Host ports.** Recommend Docker-owned allocation plus declared discovery
   and export. The alternative is consumer-specific `docker port` discovery in
   a host launcher. Approval includes additive configuration/report fields and
   adapter environment injection, with loopback-only TCP bindings. A port is
   never promised before Compose starts or after its owner is recreated. If
   evidence is missing or ambiguous, report it and refuse dependent adapter or
   host-command launch. Success is two simultaneous synthetic workspaces with
   distinct ports, correct endpoint responses, and no cross-workspace mutation.
   This choice authorizes source/test/docs changes, configured reviews, local
   commits, ordinary task-branch push and one draft PR, plus bounded synthetic
   local qualification ending in exact stops on success or failure. Existing
   local compute and model usage apply; duration is unknown. Retain and report
   fixtures and data. Terminal: reviewed source, passing applicable checks/CI and
   port proof, stopped fixtures, and an accurate draft PR. Merge, ready,
   releases, adoption and deletion remain withheld.

Either choice may be deferred. Deliver approved choices together when both are
approved; if only one is approved, narrow this plan and its review scope before
execution rather than inventing a second package automatically.

## Execution details

### Evidence and current contracts

The primary checkout remains on its recorded older `main`; all planning files
live in the new repo-local task worktree based on current `origin/main`. The
target is resolved from the remote default and every related open Devrouter PR's
`main` base. Other task worktrees retain their owners.

Current executable evidence:

- `src/core/repo-config.ts` resolves profiles as resource unions;
  `src/types.ts` registers service/process dimensions. ADR 0005 owns their
  independence. Profiles have no runtime-task selection dimension.
- `src/core/managed-post-start.ts` injects profile/process selection into the
  exact validated container. `bin/devrouter-process` fingerprints adapter bytes,
  command, preparation, workspace, and caller-allowlisted environment. The
  adapter can replace that environment allowlist; a variant must therefore
  become a built-in identity input.
- `src/core/workspace-ensure.ts` persists managed state, publishes routes after
  proof, and replays the previous adapter inputs during rollback.
  `src/core/reliability-lifecycle.ts` and `src/core/reliability-worker.ts`
  transport manual lifecycle options. Controller supervision currently carries
  profile identity, without a variant dimension.
- `src/core/host-port-claims.ts` checks consumer-declared fixed bindings and
  deliberately excludes ephemeral bindings. It does not allocate ports.
  `src/core/host-env.ts` discovers loopback ports for routed TCP proxy apps;
  non-routed HTTP services need a declaration that is independent of routes.
- `src/core/devcontainer-diagnostics.ts` currently rejects every published port
  in the base Compose file, including the loopback ephemeral form documented in
  `docs/DEVCONTAINER.md`. The port slice must align this diagnostic with the
  supported loopback exception; otherwise static verification rejects the
  recommended configuration. Fixed-port admission also examines unselected
  services, but repairing that separate false-refusal behavior is outside this
  package because ephemeral declarations do not produce fixed claims.
- The public [Klicker CI-parity draft](https://github.com/uzh-bf/klicker-uzh/pull/6722)
  at `99d9ebb4083f48cbaf57d6cae491b43c6817662b` demonstrates a selector marker,
  a separate runtime-plan artifact, and build-generation identity. Those have
  different responsibilities; this package replaces only selector signaling.

The cloud-preview branches add CLI/schema surfaces but do not currently change
`workspace-ensure.ts`, `managed-post-start.ts`, or `host-env.ts` against this
baseline. Reconcile overlapping CLI/schema changes near delivery only if they
produce a concrete readiness blocker; do not modify another owner's worktree.

### Research

Question: can the runtime own port allocation, avoiding a reservation race?
Current [Compose port documentation](https://docs.docker.com/reference/compose-file/services/#ports)
supports automatic host-port allocation when the host port is omitted, and
explicit `host_ip` for loopback binding. The
[port command](https://docs.docker.com/reference/cli/docker/compose/port/)
reports actual mappings. Context7 `/docker/compose` corroborated syntax and
discovery but did not alone establish every ephemeral-binding detail; the
official reference supplied that evidence. The existing consumer Postgres
declaration is an additional source example, not new live qualification.

Main owns product/recovery decisions and external documentation checks. One
read-only explorer owns the existing host-port/host-env source map. Native
planner critique is required before presenting this plan. Optional opposing
review is unpassed: the AGY catalog probe produced authentication and sandbox
permission diagnostics; no review was run. Jev advisory checking was unavailable
because the operator could not initialize its uv cache; source checking remains
the evidence. No authentication/configuration repair is part of this task.
The complete unpublished plan is ineligible for the separate ChatGPT Browser
destination without specific sharing authority; use the trusted native reviewer.

### Primitive impact

| Product primitive | Disposition | Contract delta | Compositions and owner | Evidence/open ruling |
| --- | --- | --- | --- | --- |
| Managed environment | Extend | Select and record one process variant per checkout | Ensure, repair, rollback; Devrouter owns lifecycle | Proposed choice 1 |
| Resource profile | Reuse | Continues selecting resources independently | Existing profile unions and repository recipes | ADR 0005 and profile resolver |
| Managed process identity | Extend | Variant and discovered-port identity cause replacement | Repository adapter plus delivered helper | Helper and post-start source |
| Published service endpoint | Extend | Declare and discover a checkout-owned loopback TCP endpoint | Docker allocates; Devrouter proves/exports; consumer builds URLs | Proposed choice 2 |
| Host environment report | Extend | Report named service ports without requiring a route | Read-only report and host subprocess | Existing host-env contracts |

There is no new port allocator, global repository registry, task runner, or
consumer-specific CI primitive.

### Binding behavior

**Variants.** Add optional `managedRuntime.variants`, a unique list of additional
names. Names use lowercase alphanumerics separated by hyphens, at most 64
characters; at most 32 additional names are allowed. `default` is implicit and
reserved. Without this field, only `default` is accepted. Require a runtime
adapter and `managedRuntime` for non-default selection. Pass
`DEVROUTER_RUNTIME_VARIANT` as an argv-safe Docker environment assignment; never
interpret it as a task name, command, template, or secret.

An ordinary ensure without the flag selects `default`; selections are not
sticky. `--repair` without it uses the retained variant. Explicit repair with a
different variant refuses before effects. Legacy state without the field reads
as `default`. Persist candidate and rollback selections together with existing
managed state. A failed transition replays the prior variant, ports, and process
set only after current exact-owner proof; uncertain restoration stays degraded.
An unsupported retained variant never silently becomes `default` during repair.
Ordinary ensure encountering degraded state repairs with the retained profile
and variant first, then performs the requested transition when either differs.
A same-profile request can therefore transition from retained CI to omitted
`default`, or from retained `default` to explicit CI. Failed repair prevents the
requested transition. Do not return early based on profile equality alone.

The process helper always includes a non-default variant in identity, even when
an adapter replaces `DEVROUTER_PROCESS_FINGERPRINT_ENV` or passes an explicit
`--fingerprint`. Compose the explicit fingerprint with the managed identity;
its caller still owns preparation identity. Unset and `default` remain equivalent
and preserve legacy identity when no other new input is present. Test this as
process reuse/replacement behavior rather than pinning a hash implementation.

Refuse non-default variants before controller binding or manual admission when
capacity policy targets the checkout or its journal is already capacity-managed.
Also refuse enrollment/controller-start paths for a retained non-default variant,
so automatic resume cannot replace it with a default process. Preflight in
`superviseLifecycle` before its initial journal creation or controller dispatch,
and in `workspaceEnsure` before network recovery or host preparation. Recheck
the current execution policy inside the worker's revision-checked admission
transaction, before recording accepted intent. Enrollment reads retained variant
evidence inside `enrollStoppedLifecycle`'s same journal transaction, after the
expected-revision check and before conversion. A worker admitted first changes
the revision and blocks enrollment; enrollment committed first makes the worker
refuse the variant without accepted intent. Existing stopped-and-drained proof
prevents a concurrent active worker from publishing variant state during that
conversion. Controller dispatch must independently refuse retained non-default
state. Default variants retain existing capacity
semantics. Supporting variant-specific estimates and conflicting controller
consumers is a separate future contract, not an implicit addition to this plan.

Ensure JSON returns `variant`. Status/doctor report the committed active variant
and any positively known pending selection; absence of a flag on a read command
does not itself make an intentionally selected variant drift. Recovery guidance
must preserve the retained variant. `exec` runs the existing process environment
and gains no selector. `profile resolve/plan` continue describing resources only.

**Host ports.** Add optional `managedRuntime.devcontainer.hostPorts`, a map of at
most 32 safe lowercase kebab-case keys (maximum 64 characters), each containing
only `service` and integer `target` (1–65535). Services must be in the existing
base/profile service registry. These are TCP discovery declarations, not requests
to publish new bindings or start optional services. Reject duplicate service and
target pairs and generated-variable collisions. Consumer Compose owns publishing;
the recommended first-version form uses `host_ip: 127.0.0.1`, `target`, and no
fixed published port. Existing fixed-port conflict behavior remains authoritative.
Accept this loopback ephemeral exception in static diagnostics using structured
port parsing, for supported short and long syntax. Continue refusing fixed or
public publication there; ambiguous interpolation remains an explicit diagnostic
rather than a guessed safe binding. Keep the documented routed-TCP loopback
exception valid even without a new host-port declaration.

For selected services, resolve one running container with the exact checkout,
Compose project, service, and configuration identity used by managed ensure.
Accept one actual IPv4 loopback binding for the declared TCP target. Missing,
public, ambiguous, stopped, or unprovable bindings cannot become exported ports.
Unselected optional services are reported as inactive and do not block ensure.
First-version declared host ports support `127.0.0.1`; existing routed TCP IPv6
behavior is unchanged.

After service readiness and before adapter launch, expose each selected binding
as `DEVROUTER_HOST_PORT_<KEY>` with hyphens normalized to underscores. Inject an
empty value for inactive declarations to override stale container environment.
The value is host-facing metadata: container-to-container traffic still uses
the service name and target port. It does not make host loopback reachable from
a container and cannot be used during the same Compose interpolation phase.

Extend `env --json` with a named `hostPorts` section containing endpoint/status
and a bounded reason when unavailable. Resolve against retained exact managed
state and live container proof, not only an alias. For `env -- <command>`, remove
all reserved declared-port variables from inherited environment before adding
proven values. Refuse launch for unavailable selected declarations; omit inactive
ones. Keep reports read-only. Resolve fresh after service recreation and during
rollback; never replay a stale numeric binding from persisted state.

Include the sorted resolved key/port mapping in a non-secret managed identity
digest injected into the helper. It must survive a replaced caller environment
allowlist and compose with explicit fingerprints. Unchanged mappings reuse the
process; changed mappings replace it before readiness and route publication.
Do not store a port lease or promise stable numbers across recreation.

### Delegation Map and sequence

Ceremony: full path. Execution mode: standard because the runtime's exact model
ID is not established as a solo-allowlisted ID. Boundary owner: main session.
One branch and one draft PR contain the complete approved package.

| Slice | Accountable owner | Dependency and acceptance |
| --- | --- | --- |
| 1: variant lifecycle | Main; coupled lifecycle and identity decisions | Default/CI/default transition, reuse, repair, rollback, capacity refusal |
| 2: port discovery and export | Main | After slice 1; exact endpoint proof and changed-port replacement |
| 3: integrated qualification and guidance | Main | After both source slices; full checks, installed package, two-checkout proof and exact stops |

Main is the single accountable owner for each slice. Delegate the settled port
resolver/test subwork in slice 2 to one executor; main retains integration.
Delegate disjoint, settled documentation in slice 3 to one executor while main
qualifies the runtime. Each bounded assignment carries exclusive paths and its
acceptance rows; no path has simultaneous writers.

**Slice 1 — select and recover the runtime variant.** Extend existing
`src/cli.ts`, `src/commands/ensure.ts`, `src/commands/workspace.ts`, `src/types.ts`,
`src/core/repo-config.ts`, `src/core/workspace-ensure.ts`,
`src/core/reliability-lifecycle.ts`, `src/core/reliability-worker.ts`,
`src/lifecycle-worker.ts`, `src/core/managed-runtime-state.ts`,
`src/core/managed-post-start.ts`, `bin/devrouter-process`,
`src/core/managed-runtime-status.ts`, `src/core/status.ts`, `src/core/doctor.ts`,
`src/core/output.ts`, `src/core/capacity-enrollment.ts`, and
`src/core/reliability-operation-store.ts` for this contract.
Controller refusal may also require `src/core/controller-server.ts` and
`src/core/capacity-controller.ts`; constrain edits to admission/dispatch guards.
Extend their existing relevant test files and `scripts/test-devrouter-process.sh`.
Route: main; skip reason: critical-path coupling across durable lifecycle inputs.
Acceptance: portfolio rows V1–V3; focused tests, typecheck, helper process suite.
Commit: `enhance(runtime): select declared managed process variants`.

**Slice 2 — discover and export actual workspace ports.** Extend
`src/core/repo-config.ts`, `src/types.ts`, `src/core/host-env.ts`,
`src/commands/env.ts`, `src/core/workspace-ensure.ts`,
`src/core/managed-post-start.ts`, and `bin/devrouter-process`. Add
`src/core/managed-host-ports.ts` and its behavioral test file: ensure and host-env
are two concrete callers of the same owner/binding resolver. Reuse existing
exact-container proof rather than implementing a parallel ownership model.
The new test path is `src/core/__tests__/managed-host-ports.test.ts`.
Extend `src/core/devcontainer-diagnostics.ts` and its existing test file for the
loopback ephemeral exception, and verify its doctor/verify consumers through
their existing tests. Extend existing config, ensure, post-start, host-env,
env-command, and helper tests only for missing portfolio obligations.
Route: executor for the settled
resolver and tests, main for the shared integration seam. Acceptance: P1–P3;
focused behavioral checks and typecheck. Commit:
`enhance(runtime): expose owned workspace host ports`.

**Slice 3 — qualify and document the complete composition.** Add
`scripts/qualify-runtime-inputs.ts` with synthetic variants, a loopback service,
two-checkout coverage, and non-destructive exact stops in its finalizer. Add
`qualify:runtime-inputs` to `package.json`. The existing profile qualifier has
unconditional deletion and unrelated cohorts, so it is unsuitable for this
batch's stop-only authority; reuse its proven approaches without executing it
or changing its behavior.
Allocate a unique run root and exactly two test-owned checkout paths; refuse a
pre-existing collision instead of resetting it. Record each runtime as soon as
startup is attempted. The finalizer attempts and verifies exact non-destructive
stops for every attempted checkout even after an earlier failure, and reports
retained paths, containers, images and data. It never removes them.
Extend `scripts/package-smoke.sh` for the new installed CLI contracts.
Update `README.md`, `docs/DEVCONTAINER.md`, `docs/REPO_ONBOARDING.md`,
`docs/knowledge/consumer-devcontainer-contract.md`,
`docs/knowledge/managed-environment-lifecycle.md`,
`docs/knowledge/routing-and-runtime-contracts.md`, `src/core/ai-prompt.ts`,
`.agents/skills/devrouter/SKILL.md`, and
`.agents/skills/devcontainer-onboarding/REFERENCE.md` for their affected contracts.
Update `docs/project/index.md` and this plan's Progress. Add proposed ADR
`docs/adr/0013-runtime-variants-independent-of-profiles.md` and its index entry
using the existing ADR format; verify the number is still free before writing.
ADR 0005 stays accepted. Port discovery retains existing Docker/Compose ownership
and needs no separate architecture record. Keep migration instructions for a
later release prompt; this package does not bump versions or edit a release.
Route: main plus one disjoint documentation executor after contracts settle.
Acceptance: Q1, applicable repository checks, review and ordinary draft delivery.
Commit: `enhance(runtime): qualify variants and host-port discovery`.

### Feature-wide verification portfolio

| ID | Existing protection | Disposition and missing obligation | Primary seam/owner |
| --- | --- | --- | --- |
| V1 | Config/profile validation and argv-safe post-start | Extend existing: invalid/unknown variant refuses before effects; omission/default compatibility, both CLI entrypoints | Config/command tests; slice 1 |
| V2 | Helper identity and owned replacement | Extend existing: same variant reuses, changed variant replaces with default and explicit fingerprints despite a reset allowlist | Linux process suite; slice 1 |
| V3 | Profile repair, rollback, degraded recovery and exact owner refusal | Extend existing: worker transports selection; repair/rollback retain it; old state is default; same-profile degraded repair then variant transition in both directions; failed repair prevents transition | Ensure/state/lifecycle tests; slice 1 |
| V4 | Revision-checked admission and stopped enrollment | Extend existing: capacity-targeted preflight leaves intent/session/preparation/provider untouched; enrollment-first blocks variant admission; worker-first invalidates enrollment revision; retained CI cannot auto-resume as default | Worker/store/enrollment/controller tests; slice 1 |
| P1 | Fixed claims exclude ephemeral; host-env refuses foreign aliases | Add new resolver tests and extend config/diagnostic tests: exact non-routed service ownership, inactive/public/multiple/missing/stopped bindings, integer bounds; static loopback ephemeral acceptance, fixed/public refusal | `managed-host-ports.test.ts` and existing seams; slice 2 |
| P2 | Host-env endpoint exports and command exit codes | Extend existing: JSON availability, fresh binding after recreation, inherited-variable clearing, no launch on selected-port failure | Host-env/command tests; slice 2 |
| P3 | Readiness/route publication and process rollback | Extend existing: adapter gets current ports, changed ports replace processes, rollback resolves current prior-service ports | Ensure/helper tests; slice 2 |
| Q1 | Existing installed package smoke | Extend package smoke; add new bounded qualifier: two concurrent checkouts, distinct responsive ports, variant switching/reuse, one stopped while neighbor stays healthy, both finally stopped | Package script and `qualify-runtime-inputs.ts`; slice 3 |

Reuse passing coverage when its tested inputs remain unchanged. Add no tests
that pin documentation, example contents, prose, or an internal hash algorithm.
There is no browser interaction or layout contract in this CLI change;
endpoint probes and process/container identity checks are the relevant proof.

Run the smallest red/green seam first, then applicable repository gates:
docs policy, knowledge validation, Biome, Knip, typecheck, tests including the
Linux helper suite, build, and package smoke. Use the existing toolchain pinned
in `package.json`. Inspect whether checks are host-native or container-dependent
before running them. Linux-only process evidence requires the supported Linux
execution environment; macOS source tests do not substitute for it.

Qualify a locally built candidate without replacing the user's installed CLI.
Use only the two test-owned synthetic checkout runtimes and their routes; no
consumer runtime, shared-neighbor mutation, broad recreate/down/prune, or
data deletion. Read `rs-local-runtime-lifecycle` when qualification first touches
a runtime and again at finalization. Stop and prove both exact runtimes stopped.
Unavailable required runtime/tool evidence is a delivery blocker to report,
not a reason to claim acceptance from mocks or start unrelated infrastructure.

Each substantive slice has simplification and one risk review over the committed
range. The integrated final review follows verification and includes correctness,
contract compliance, maintainability, focused security, and architecture.
Use scoped configured routes and reuse qualifying reports. Review feedback can
correct the same approved contract; broader capacity support or new runtime
mechanisms return to the user decision boundary.

### Authority, recovery, and completion

Authority: the user approved both choices on 26 October 2026 with
"approved, go on". Approval mode: executable batch.

Authority after approval: the named source/docs/tests, local commits, configured
reviews, ordinary push to the task branch on the existing origin, one draft PR,
and the bounded synthetic local qualification above. Preserve user changes and
run staged secret/personal/production-data checks before each commit and body
update. Request no human reviewers or other notifications.

Recovery: refuse unknown identity or ownership before mutation; reuse existing
rollback/degraded paths for a failed candidate, re-resolving live ports. Failures
stop only dependent work. Do not undo uncertain runtime ownership by broad
cleanup. Source rollback uses a normal revert, without deleting retained data.

Pause only for changed public behavior, new dependencies/cost/data boundaries,
controller variant support, ownership uncertainty, exhausted required review
routes, or unavailable required verification. Refresh remote state at a new
session boundary and integrate `main` only for a concrete readiness need.
Follow one supported watcher for hosted checks after authorized draft delivery.

Terminal: complete reviewed source package, checks and Q1 passing, exact test
runtimes stopped, ordinary pushed branch, draft PR with accurate evidence and
passing required CI. Release, merge and later Klicker adoption need their own
named authority.

## Progress

- Planning investigation and independent critique complete; no source
  implementation, runtime qualification, commit, push, or PR has occurred.
- Baseline: `1df0d0a627d44ab7c31cb5de9106db050eb469a5`, task branch at 0 ahead / 0
  behind `origin/main` after fetch on 26 October 2026. Substantive delta: 0 lines.
- Remaining slices: 1–3, approved. Active slice: 1, runtime variant lifecycle.
  Required delivery: complete reviewed and qualified source package with a
  pushed branch, draft PR, passing required CI, and stopped synthetic runtimes.
- Planning-stage specialist: native planner
  `01a1779f-5b5c-7a72-b8ea-978ca48ebf9e`, round 1 REVISE; all five findings
  accepted and verified; round 2 APPROVED. Report:
  `_local/reviews/2026-10-26-runtime-inputs-plan-hardening.md`. Source-map
  explorer `01a17793-9af4-7540-aafd-3788afd4977e` completed and closed.
- Verification: documentation policy passed; every existing referenced local
  path resolves, four named proposed files are intentionally absent, no
  whitespace errors found. No source tests or runtime qualification run.
- Next action: commit this approved plan, then execute slice 1.

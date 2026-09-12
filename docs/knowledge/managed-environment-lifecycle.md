---
type: Workflow
title: Managed environment lifecycle
description: Describes exact-checkout startup, reversible stop, destructive teardown, and conservative garbage collection.
owner: repository maintainers
status: active
source_paths:
  - src/core/workspace.ts
  - src/core/workspace-lifecycle.ts
  - src/core/workspace-ownership.ts
  - src/core/workspace-ensure.ts
  - src/core/environment-stop.ts
  - src/core/workspace-gc.ts
  - src/core/devpod-mutation.ts
  - src/core/devpod-workspaces.ts
  - src/core/workspace-runtime.ts
  - src/core/devsy-mutation.ts
  - src/core/managed-devsy-stop.ts
  - src/core/devpod-environment.ts
  - src/core/devsy-agent.ts
  - src/core/devsy-workspaces.ts
  - src/core/devsy-exec.ts
  - src/core/managed-runtime*.ts
  - src/core/status.ts
  - src/core/doctor.ts
  - src/core/controller-monitor.ts
  - src/core/controller-observation.ts
  - src/core/controller-sessions.ts
  - src/core/network-*.ts
---

# Managed environment lifecycle

Managed network allocation precedes new provider effects only for policy-enabled,
eligible linked Compose workspaces. Claims retain the exact workspace, daemon and
subnet across stop/resume. Unknown outcomes retain their reservation; a saved
provider binding is an effect even without containers. Recovery releases only
reservation metadata after worker settlement and complete absence proof. Existing
networks remain owned by Compose. See the [network allocation contract](../DEVCONTAINER.md#managed-workspace-network-allocation)
and [ADR 0009](../adr/0009-preserve-compose-network-ownership.md).

## Purpose and boundary

Managed lifecycle commands bind one primary or linked Git checkout to one exact workspace runtime generation. The runtime is DevPod or Devsy, resolved per checkout path in `src/core/workspace-runtime.ts`: `DEVROUTER_WORKSPACE_RUNTIME` forces one runtime, an exact-path registry owner wins next (mixed fleets keep their checkouts separated), then the machine preference persisted by `devrouter setup --workspace-runtime`, then installed-CLI auto-detection (DevPod first when both are installed). Use these commands instead of direct DevPod/Devsy lifecycle mutations; direct provider commands do not participate in Devrouter's locks or ownership proofs.

## Startup flow

`src/core/workspace-ensure.ts:workspaceEnsure` is the canonical reconciliation path for both primary and linked checkouts:

1. Resolve the exact checkout and acquire its repository-local lifecycle lock.
2. Reconcile persisted identity, the exact-path Git-common-dir owner record,
   and both provider registries. For a new linked checkout, claim the readable
   legacy identity when free or a deterministic hash-suffixed fallback when it
   collides, then persist the checkout token within the same repository-local
   transaction.
3. Load the in-memory runtime config and reject any managed HTTP or TCP proxy upstream outside the checkout's alias namespace.
4. For Devsy, validate the pinned agent source before entering the provider
   queue. Missing, stale, or invalid sources fail with the exact setup repair;
   the verified path enters only the copied CLI child environment.
5. For managed runtimes, resolve the fixed published host bindings of the
   effective Compose model (`src/core/host-port-claims.ts`) with the same
   interpolation environment the start would use, and refuse before any
   session, generated-config write, or provider start when a running container
   already binds one (`hostPortConflicts` in the result names the binding,
   holder container, compose project, and owning workspace when attributable).
   Ephemeral bindings are exempt and consumer bindings are never rewritten.
   Unverifiable evidence refuses fail-closed; `doctor` reports the same
   comparison read-only as `repo.host-port-claims`.
6. Start or attach to the exact-path DevPod or Devsy workspace through `src/core/devpod-mutation.ts:startDevpodWorkspace` (or its Devsy dispatch), which serializes and revalidates provider ownership machine-wide. Contenders join a fair arrival-order queue, wait up to thirty minutes for the machine-global provider lock, and print one throttled stderr progress line every ten seconds while waiting; a timeout names the queue position or holder PID, the true lock-hold duration when known, and how long the contender waited.
7. Prove the expected Compose overlay, app-container mount, Git identity, health, and unique upstream aliases through `validateWorkspaceContainers` and preflight polling.
8. Run the managed repository adapter when applicable, atomically replace the checkout's proxy routes, prove that Traefik loaded desired file-provider routers and unloaded removed routers, and then verify HTTP readiness.
9. Spend at most one recreate on an already-existing exact runtime. Clear the route batch when a later proof fails.

A provider command can fail after creating recovery state. Devsy startup
therefore re-reads exact ownership while its machine-global mutation lock is
still held. An exact owner, conflicting evidence, or an unreadable registry is
classified as possibly started; the compatibility adapter preserves the
generated managed Dev Container configuration so canonical stop can still
parse the workspace. Only a successfully read registry with no exact owner
permits first-transition cleanup.

`src/core/workspace-lifecycle.ts:workspaceUp` creates or reuses a Git worktree,
choosing a deterministic non-conflicting default path when two long branch
names truncate to the same readable token or an unregistered directory already
occupies that path, then delegates startup to
`workspaceEnsure`. `--no-devpod` is create-only and publishes no routes; its
provisional identity is reconciled on the first managed `ensure`. Worktree
creation holds the repository ownership transaction through `git worktree add`
and gives concurrent creators 60 seconds to serialize; the machine-global
provider mutation lock waits up to thirty minutes in arrival order with throttled stderr progress
lines; ordinary ownership transactions retain their short wait.

## Profile transitions

The native Dev Container view remains full: its source configuration describes
the complete environment for Dev Container clients. Managed `ensure` derives an
ignored, marker-owned sibling configuration when `.devrouter.yml` declares a
`managedRuntime` registry and a selected profile. The generated file changes
only `runServices`, while the source file, relative paths, volumes, and
`postCreateCommand` remain untouched.

When a managed adapter is paired with `postCreateCommand`, the source
configuration must set `waitFor` exactly to `postCreateCommand` or
`postStartCommand`; invalid ordering is rejected before provider mutation. The
generated sibling preserves this lifecycle field.

The managed registry separates base Compose services, optional profile services,
and repository-owned process markers. Every profile keeps the primary service
and base services. Its `apps`, `devcontainerServices`, and `processes` selections
are independent; omitted optional dimensions are empty, so an app-only profile
does not start optional infrastructure. A profile can therefore start a
route-free capability such as an AI gateway or MCP server. The `*` wildcard
selects the complete registered dimension.

Profile changes in an existing workspace are warm. The reconciler validates the
candidate, writes the effective configuration, starts added exact services,
proves service health and candidate processes, stops dropped owned processes
and services by exact identity, and publishes the candidate routes last. It
proves both that selected routers loaded and that routers dropped by the profile
unloaded before persisting ready state. It does not recreate the DevPod, remove
containers, remove volumes, run `postCreateCommand` again, or use a broad
Compose project command. A failed transition retains the previous routes and
successful state when possible. A degraded transition is persisted; ordinary ensure
validates its retained ownership before transitioning directly to a differing desired
profile. Dropped processes need not start first; failed transitions preserve degraded
state without replaying the broken baseline adapter. Same-profile recovery repairs
the retained profile. Persisted state remains
authoritative while any container from its exact Compose project still exists.
When that exact project has disappeared, Devrouter treats the state as detached
and rebaselines from the currently observed exact workspace before proceeding.
This permits a provider or Compose-project handoff without weakening ownership:
an unreadable Docker state stays attached and fails closed, no container or
state is deleted, and any surviving prior-project container still blocks the
transition.

After an external reset, saved ready state is not a healthy rollback target.
If recreation fails after the exact candidate and its complete selected service
population are proved, the reconciler retains the candidate configuration and
matching degraded record, stops its processes, and removes unusable checkout
routes. Repair can then replay the selected profile; stop retains its existing
ownership checks. Incomplete candidate proof or failed cleanup is reported
explicitly instead of claiming recovery. An empty rollback process baseline
does not invoke the repository startup adapter.

Ordinary ensure automatically recovers a retained degraded record using its recorded
profile and unchanged configuration. Explicit `ensure --repair` limits the invocation
to this repair stage. It verifies exact provider, workspace and
container ownership before replay. Stopped primary recovery requires all project
containers stopped and no checkout routes; it starts only retained Docker IDs,
never provider bootstrap or Compose creation. The existing container entrypoint
still runs. Ready is persisted after resource and active route configuration proof.

Use `devrouter status --repo <path> --json` or `devrouter doctor --repo <path>
--json` to inspect the canonical profile, desired and active resources, exact
service/process statuses, fingerprints, and values-free drift. A fully stopped
exact runtime is a normal stopped state, not evidence that another workspace's
resources may be reclaimed.

## Continuous observation

The foreground controller observes explicitly enrolled managed linked checkouts.
Independent consumer leases share bounded probes while retaining separate runtime
and application requirements. Runtime readiness can remain verified when an
application fails its HTTP contract. Missing, stale, or conflicting evidence is
UNKNOWN. Publication revalidates checkout ownership, configuration, session
generation, and the manual operation journal revision; observation never changes
that journal or starts, repairs, or stops a runtime.

See [foreground consumer sessions](../DEVCONTAINER.md#foreground-consumer-sessions)
for enrollment, lease renewal, restart handling, and event continuity. Releasing
the last consumer preserves application data and runtime state; the caller still
owns the normal exact-stop lifecycle.

## Manual operation journal

Each managed workspace keeps one durable reliability record under
`~/.config/devrouter/reliability/`. The journal inside it has three jobs:

- **Duplicate-operation detection.** Every accepted operation request stores its
  request key and operation ID, so a retried CLI invocation joins or conflicts
  instead of starting a second lifecycle against the same workspace.
- **Crash recovery.** Each operation carries a `drained` flag and a status. A
  CLI or worker crash mid-flight leaves an `INTERRUPTED`/drained entry that the
  next command reconciles instead of silently assuming the operation never ran.
- **Intent fencing.** `desired`, `phase`, and the stop proof fence effects
  against concurrent intent: effects claim the current revision, and a stale
  fence refuses to mutate.

The journal is capped at `RELIABILITY_MAX_ITEMS` (128) entries. The cap bounds
the record (it must stay a small, atomically written, private file) and keeps
deduplication scans bounded; history beyond that horizon has no recovery value
because the current operation and the latest ensure result are always retained.
Rollover retires one drained terminal entry per accepted replacement —
including drained `INTERRUPTED` entries, which a crash is most likely to leave
behind. Liveness is an invariant, not an accident: from any state a crash can
produce, at least one canonical command must progress (`ensure` admitted and
dispatched, or a `stop` that settles its proof). The saturated-journal,
interrupted-ensure repro is asserted in
`src/core/__tests__/reliability-liveness.test.ts`, including randomized crash
walks.

If a lifecycle worker is provably gone and a record still refuses progress,
`devrouter workspace journal settle [path]` settles the recorded operation as
`INTERRUPTED` and drained under the workspace lifecycle lock. Settlement never
claims anything about workloads, routes, or registrations; it only marks the
operation unobservable so the normal stop and ensure supersede proofs apply.
Refusals name the blocking field and the canonical remediation instead of a
bare "blocked".

Records are stamped with `writtenByVersion`. A record written by a newer CLI is
refused with an upgrade instruction before any lifecycle step, so version skew
surfaces as one explicit message instead of new refusals mid-flight.

## Capacity admission (opt-in)

With an explicitly enabled controller capacity policy, enrolled managed linked
checkouts route `ensure` and `exec` through controller admission before
dispatch. The CLI follows the decision with bounded reconnecting waits that
survive controller restarts while the request stays queued, and worker results
are journalled atomically with the completion event. `stop` bypasses admission.
Checkouts without enrollment, and machines without `capacity-policy.json`
under Devrouter home, keep the manual lifecycle. See
[ADR 0008](../adr/0008-model-reliability-before-runtime-activation.md) for the
source contract and activation boundaries.

The policy's optional `recovery` block carries the bounded corrective-action
budget: per-scope process and service restart allowances, the aggregate action
cap an incident may not exceed, the incident window, the observation bound, and
the capacity-resume dwell. It defaults to disabled, so enrollment alone never
activates automatic corrective action. `decideRecovery` in
`src/core/reliability-model.ts` reads a journal state and returns one
recommendation — `start`, `continue`, `resume`, `blocked`, or `none` with a
machine-readable reason — without mutating state. The durable journal keeps no
observation history, so a live controller passes the capabilities it just
observed as failed instead of relying on persisted observations. The monitor
supplies those to `prepareRecoveryLifecycleOperation`, which opens one
journal-admitted corrective ensure through the same capacity queue an operator
command uses, and never supersedes an operation the queue still owns.

## Stop, delete, and inspect

| Command | Effect | Preserved state |
| --- | --- | --- |
| `devrouter stop <path>` | Stop the exact primary or linked environment, remove its canonical routes, and prove Traefik unloaded them. | Checkout and linked ownership record. |
| `devrouter exec <path> -- <command>` | Execute once inside an already-running exact runtime. | All lifecycle state; it does not start or recreate. |
| `devrouter workspace stop <target>` | Reversible stop for the resolved linked owner. | Worktree, branch, and owner record. |
| `devrouter workspace down <target>` | Delete the exact provider runtime and routes, then remove a clean unlocked worktree unless retained. | Branch; worktree and record only when explicitly retained or teardown fails before removal. |
| `devrouter workspace ls` | Join live Git, ownership, workspace runtime, and route evidence by exact worktree path. | Read-only. |
| `devrouter workspace cleanup --repo <repo> --inactive-for 30d --json` | Report orthogonal ownership, checkout, route, advisory activity, and integration evidence for managed linked workspaces; exact guarded commands are suggestions only. | Always report-only; no `--yes` or apply mode. `--check-merged` alone enables read-only origin and matching GitHub/GitLab checks. `--measure-size` adds storage consumption and remains read-only. |
| `devrouter workspace gc` | Report missing-owner cleanup candidates; `--yes` revalidates and deletes only exact ledger-owned missing resources. | Git worktrees, branches, legacy/unowned resources, and conflicting owners. |

`src/core/workspace-ownership.ts:inspectWorkspaceOwnership` reports `present`, `missing`, `locked`, or `conflict`. A status is evidence for a decision; it is not permission to delete by token alone.

`workspace cleanup` is advisory. It uses only valid DevPod/Devsy `lastUsed`, route
`updatedAt`, ownership `updatedAt`, and Git HEAD committer timestamps for
activity. Runtime `lastUsed` may be absent, provider-version dependent, or fail
to represent runtime interactions, so recent trustworthy evidence vetoes
quietness and missing, malformed, unavailable, or conflicting evidence becomes
unknown. Existing `workspace gc` and `workspace down` revalidate exact identity,
locks, checkout state, and ownership before any explicit mutation.

Storage consumption is opt-in under `--measure-size` because it walks each
worktree and asks Docker to size the attributed containers, which costs the
daemon a filesystem walk per container. It changes no state. Consumption
separates what deleting a workspace actually frees from what it does not:
`worktree` and `containerWritable` bytes are reclaimable and sum into
`reclaimable`, while `imageShared` bytes are image layers shared with other
containers, overlap across rows, and must never be summed. Container
attribution reuses the exact-identity predicate `ensure` and `exec` share, so
sibling compose services are outside a workspace's figures. Any figure that
cannot be trusted — an unreachable daemon, an unreadable path at any depth, a
sizing walk that exceeds its deadline, or a size the daemon declines to report
— is `unknown` with a reason rather than a partial or zero total, since a low
total reads as "little to reclaim" and is the misleading direction here. A
workspace with no attributed container is a measured zero, not unknown.

## Failure rules

Managed Devsy preparation through a local Unix Docker endpoint records stop ownership before application readiness.
When that baseline is present, stop verifies the recorded provider, pinned daemon,
exact container IDs and complete membership without reading mutable repository
configuration. Each stop effect claims the current lifecycle fence. Final
settlement revalidates the same baseline and requires zero exact routes. A present
invalid baseline never falls back or grants ownership of replacement containers.

A valid baseline also permits stop for a ledger-owned linked checkout with missing
registration when every saved ID is positively absent on the saved daemon and
project, directory and provider-runner populations are empty. Fresh checks of both
registries, present Git ownership and the retained generation bracket that proof.
The absent result does not report a provider mutation. Route cleanup revalidates
under the provider lock; retries and final settlement independently prove live
absence of retained desired app router names across both protocols. Routes outside
that retained set prevent cleanup. The baseline and interrupted history remain.
This exception does not apply to primary checkouts or legacy records.

A failed startup before registration also permits canonical stop for a present
ledger-owned linked managed Devsy checkout without retained state. Two observations
require both provider registries to be readable and absent for the exact ID and
path, positive runtime not-found, a pinned local Docker daemon with no checkout
or runner containers, and no canonical or live app routes. Stopped containers
also prevent this exception. Final settlement revalidates the original owner,
daemon and route references under the provider lock after worker drainage;
unknown or changed evidence leaves stop pending. A missing competing-provider
CLI is unknown evidence. The stop reports absence without a provider mutation.
Primary, unowned and registered workspaces retain their existing stop paths.

For retained managed Devsy state without that baseline, reversible stop proves the complete captured
Compose population under the workspace and provider locks. Provider and primary
state must agree. An already-stopped primary skips provider stop; residual
running service IDs are stopped only after ownership, context, source and
generated configuration, container identities and full membership are revalidated.
Unapplied Compose service edits do not require matching current service hashes
for stop; startup retains its service-configuration checks.
Final provider and complete-project stopped proof precedes route cleanup.
Unreadable evidence preserves routes. A guard-ordered `stop --delete` or
external teardown that removed the registration is the symmetric absence case:
when both provider registries positively lack the ID and path, Devsy reports the
runtime `not-found`, and the compose, runner, and workspace populations are
empty across two stable observations, the stop completes as proven-absent and
only routes are freed. If provider stop
fails, eligible residual cleanup may still run, but its original failure remains
nonzero and routes remain intact. This does not change legacy or delete paths.

- A Devsy start never performs implicit agent acquisition. Use
  `devrouter setup --yes --workspace-runtime devsy`; doctor checks the resulting
  readiness state without network access.
- Ambiguous Git paths, duplicate runtime IDs, owner conflicts, foreign aliases, dirty worktrees, and provider reassignments fail before destructive follow-up.
- Provider mutation succeeds before route removal; a provider failure retains routes and ownership. After canonical removal, stop/delete still fails closed if bounded Traefik inspection plus one serialized restart cannot prove the routers unloaded.
- Full down removes runtime, routes, worktree, then owner record. Failures stop that sequence and preserve later state.
- Garbage collection revalidates inside one ownership transaction; a workspace revived after a dry run is not mutated.

## Evidence and change guidance

The primary behavior gates are `src/core/__tests__/workspace-ensure.test.ts`, `workspace-lifecycle.test.ts`, `workspace-ownership.test.ts`, `workspace-gc.test.ts`, and `devpod-mutation.test.ts`. Preserve their exact-path, ordering, race, and no-side-effect assertions when changing this workflow. See [architecture and ownership](./architecture-and-ownership.md) for the owner boundaries and [identity drift](../solutions/integration/devpod-worktree-identity-drift.md) for incident rationale.

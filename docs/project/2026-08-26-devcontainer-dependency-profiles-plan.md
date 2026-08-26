# Dependency-aware devcontainer profiles plan

## Goal

- Extend devrouter profiles from route and readiness filters into an exact,
  opt-in runtime contract for routed apps, Dev Container-owned services, and
  repository-managed processes.
- Preserve native DevContainer behavior while letting managed `ensure` start
  only the selected service and process union on cold start and warm profile
  changes.
- Make route-free capability profiles valid, observable, deterministic, and
  safe to switch without recreating the primary container or rerunning
  `postCreateCommand`.
- Prove the generic contract against KlickerUZH before preparing the next patch
  release after `0.0.38`.

## Non-goals

- Do not make DevPod workspaces containerless; the primary Dev Container service
  always remains active.
- Do not infer service or process ownership from broad Docker names, ports, or
  process text outside the existing exact-workspace identity.
- Do not manage arbitrary host processes, production services, Kubernetes, or
  remote deployments.
- Do not change repositories that omit the new managed-runtime contract.
- Do not use `devpod up --recreate`, reset workspaces, remove containers or
  volumes, or rerun a consumer's `postCreateCommand` during a profile switch.
- Do not hard-code Klicker application or service names in devrouter.
- Do not publish a package, install or replace the host CLI, push, open or merge
  a pull request, deploy, access secrets, call external model providers, or
  delete branches, worktrees, containers, or volumes under this plan.

## Execution contract

- Authority: One approval authorizes reversible local work in the named
  devrouter task worktree: plan commit, bounded implementation delegation,
  repository edits, repository-native checks, local package artifacts, a
  provider-free Klicker consumer smoke, exact test-runtime start and stop,
  required reviews, Progress updates, and local conventional commits.
- Authority: Approval does not authorize push, pull-request creation, merge,
  release publication, host CLI installation or update, secret access, external
  provider calls, deployment, real or personal data, container or volume
  removal, branch deletion, or worktree deletion.
- Boundary owner: the main execution session owns architecture, integration,
  exact ownership decisions, rollback semantics, review disposition, and final
  proof. Delegated agents receive only their named slice and write scope.
- Terminal: A locally committed release candidate for the next patch after
  `0.0.38` passes the full devrouter checklist and a provider-free Klicker
  consumer smoke; its exact test workspace is stopped; owned routes, managed
  processes, and running profile-owned services are absent; Progress records
  `release_pending` because publication remains withheld.
- Pause: Stop if DevPod `0.6.15` supports neither the intended warm-add seam nor
  the exact Compose fallback, exact workspace ownership cannot be proven, a
  rollback leaves candidate routes, the generated config would dirty or
  overwrite consumer files, or a required check needs secrets, external
  providers, real data, deletion, installation, or publication.
- Pause: Stop if fresh state reveals overlapping work in the task worktree or a
  remote contract change invalidates this plan.

## Plan identity and package boundary

- Plan: `docs/project/2026-08-26-devcontainer-dependency-profiles-plan.md`
- Repository: `/Users/rschlae/Git/personal/devrouter`
- Branch: `rs/devcontainer-dependency-profiles`
- Worktree: `trees/devcontainer-dependency-profiles`
- Target: `main`
- Fresh base: `origin/main` at `308854e` (`0.0.38`), 0 ahead and 0 behind when
  the planning worktree was created.
- Pull request: not created. Push and pull-request creation are outside the
  approved local terminal.
- Downstream package: KlickerUZH plan
  `project/2026-08-25-devcontainer-dependency-profiles-plan.md` on branch
  `rs/devcontainer-dependency-profiles`.
- Packaging: This is an ordinary upstream package, not one member of a
  cross-repository stack. The downstream package waits for a published release
  and owns only consumer configuration and proof.

## Settled runtime contract

### Profile dimensions

- `apps`, `devcontainerServices`, and `processes` are independent optional
  profile dimensions. A profile must select at least one dimension.
- App selection retains the existing route dependency and readiness behavior.
- `managedRuntime.devcontainer.baseServices` names services required in every
  managed profile. The Dev Container's primary service is implicit and cannot
  be deselected.
- `managedRuntime.devcontainer.profileServices` is the complete registry that
  profiles may select through `devcontainerServices`.
- `managedRuntime.processes` is the complete registry of process markers that a
  managed post-start adapter may own. Devrouter passes the canonical desired set
  to the adapter and reports it; the repository remains responsible for mapping
  markers to commands and readiness checks.
- Every named Compose service is validated against the effective Dev Container
  Compose model. Every profile service must already be represented in the
  committed native `runServices` set. Every process marker must be declared in
  the registry.
- When the managed-runtime contract is absent, schema, startup, route, and
  service behavior remain exactly compatible with `0.0.38`.

### Selection semantics

- Resolve and validate the entire comma-separated selection before any runtime
  mutation. Trim tokens, reject empty or unknown tokens, de-duplicate, sort, and
  union each dimension independently.
- Omitted selection resolves to the one declared default profile. An explicit
  `full` profile uses a wildcard in all three dimensions and restores all apps,
  all native `runServices`, and all declared process markers.
- Reordered equivalent selections have one canonical profile name, process
  fingerprint, desired-state record, and route metadata value.
- A route-free profile is valid when it selects a service or process. It has no
  implicit API, Auth, route, app readiness, or application process.

### Native-full and managed-selective Dev Container behavior

- The committed consumer `devcontainer.json` remains native-full and is never
  rewritten. Native DevPod, VS Code, and Dev Container CLI use its original
  all-service `runServices` contract.
- Managed devrouter writes an atomic, ownership-marked, ignored sibling config
  beside the source `devcontainer.json`. It copies the resolved source config
  and changes only `runServices` to the primary service, declared base services,
  and selected profile services.
- Keeping the generated file in the same directory preserves relative Compose
  files, environment files, mounts, features, lifecycle commands, and variable
  substitution. The consumer must ignore the exact generated path. Devrouter
  refuses a pre-existing file without its ownership marker and refuses a Git
  repository where the generated path would appear dirty.
- `devpod up` receives the generated path before container startup. Profile
  selection is therefore available for cold service startup, not only for the
  later managed post-start adapter.
- Warm changes never pass `--recreate`. DevPod `0.6.15` is the intended seam for
  starting newly selected services from the effective `runServices` set.
- If characterization disproves that seam, the only fallback is exact Compose
  startup using the configuration, working-directory, project, service, and
  container labels proven to belong to the same DevPod workspace. Removal
  always stops exact container IDs after the ownership proof. If either proof is
  unavailable, fail without an all-on-then-stop workaround.

### Transition, rollback, and state

- Persist only the last successful canonical profile, desired service and
  process sets, source/effective-config fingerprints, exact workspace identity,
  and transition status in devrouter's existing local state area. Do not store
  environment values, commands containing secrets, response bodies, or
  credentials.
- Transition order is fixed:

  1. validate configuration, canonical selection, generated path, and exact
     workspace ownership without mutation;
  2. write the effective config atomically and start added services;
  3. prove service health, then invoke the adapter with the candidate profile
     and desired process markers;
  4. stop or replace obsolete owned processes and prove candidate process and
     internal app readiness while previous service dependencies still exist;
  5. stop dropped profile-owned services by exact container ID and verify the
     complete desired service and process sets;
  6. atomically reconcile routes, perform final route readiness, and only then
     persist candidate state as successful.

- A failed transition publishes no candidate route set and never records
  candidate state as successful. Restart dropped prior services, rerun the prior
  adapter state, and restore prior routes where exact prior state is known.
  Report explicit degraded drift when restoration is incomplete; do not claim
  the prior profile remained healthy.
- Unchanged desired state is idempotent: it neither replaces processes nor
  restarts services and routes.
- Stop and status use exact repository, checkout, workspace, provider, Compose
  project, service, and managed-process identities. Corrupt, stale, foreign, or
  ambiguous state is a refusal, not permission to broaden the target.

## Compatibility and failure semantics

- Existing configs without `managedRuntime` keep implicit-full startup and need
  no migration.
- Existing app-only profiles remain valid. Their JSON output gains additive
  desired/active runtime fields without changing existing field meanings.
- A managed-runtime config that does not classify every native `runServices`
  entry as primary, base, or profile-owned is invalid. This prevents a selective
  profile from silently losing an unmodeled service.
- A service may be reported as `starting`, `healthy`, `unhealthy`, `stopped`, or
  `drifted`; a process may be `running`, `stopped`, `foreign`, or `drifted`.
  Values-free status reports identity hashes and names, not environment values.
- Route publication is the final visible commit point. Runtime drift after that
  point makes `ensure` fail and status non-ready; it never silently widens to
  full.

## Product primitive and ADR gates

- Product primitive: No end-user product primitive changes. The contract is a
  developer-tool configuration and lifecycle seam, so no product-design pass is
  required.
- ADR: Armed. The public schema, runtime-generated config, persisted desired
  state, exact ownership rules, and rollback ordering are durable architectural
  choices. Add one ADR before implementation settles the schema. The ADR owns
  rationale; this plan owns execution and acceptance.
- Re-arm broader design if implementation would require DevPod recreation,
  repository-specific service knowledge, destructive Compose operations, or a
  new external data boundary.

## Research and evidence

- The Dev Container specification defines `runServices` as the explicit service
  startup set and defaults to all services when it is omitted:
  <https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainerjson-reference.md>.
- DevPod PR #1583 made warm `up` apply the same `runServices` service arguments
  as cold startup:
  <https://github.com/loft-sh/devpod/pull/1583>.
- Local DevPod `0.6.15` exposes `--devcontainer-path` relative to the project and
  `--recreate`. The plan uses the former and prohibits the latter for profile
  changes.
- Current devrouter `0.0.38` resolves profiles before `startDevpodWorkspace` but
  passes the profile only to managed post-start. Its schema requires non-empty
  `apps`, and its process helper exposes `ensure` only.
- The bounded characterization slice remains mandatory because upstream source
  behavior does not prove the installed provider's cold/warm lifecycle, label
  set, or stopped-service restart behavior.

## Planning review

- One required read-only `planner` reviewed both repositories and returned
  `DONE_WITH_CONCERNS`.
- Accepted: Use two linked package-local plans; arm the upstream ADR; keep native
  full; use an ignored same-directory effective config; validate independent
  app, service, and process dimensions; persist only last-successful state; add
  exact ownership, drift, rollback, and route-publication gates; pause before
  release-dependent consumer completion.
- Accepted with correction: The planner put Hatchet only in app profiles. The
  current Klicker `postCreateCommand` needs Hatchet during first workspace
  bootstrap, so the consumer plan keeps Hatchet in the managed base until that
  bootstrap is decoupled. Devrouter remains generic and does not encode this
  choice.
- Rejected: Publish candidate routes before stopping dropped dependencies. The
  plan instead treats route reconciliation as the final visible commit point so
  failed service cleanup can still roll back without exposing the candidate.
- No unresolved user decision remains if a pure capability profile may retain
  the idle primary container and declared bootstrap base services.

## Delegation and review map

| Slice | Owner | Dependency | Acceptance boundary | Review gate |
| --- | --- | --- | --- | --- |
| D0 plan | main | approval | Reviewed plan committed and Progress active | planner already complete |
| D1 characterization | executor | D0 | Cold/warm seam and exact fallback are proven or package pauses | main verifies evidence |
| D2 schema and ADR | main | D1 | Generic contract, compatibility, unions, and validation pass | simplifier + slice-reviewer |
| D3 lifecycle | main | D2 | Effective config, transition, rollback, and exact stop pass | simplifier + slice-reviewer |
| D4 status and diagnostics | executor | D3 | Desired, active, drift, and rollback state are values-free | simplifier |
| D5 guidance | executor | D2-D4 | Docs, knowledge, examples, skill, and upgrade guidance agree | main integration review |
| D6 release candidate | main | D5 | Full checks and consumer smoke pass; publication withheld | final-reviewer |

- Slices remain serial where they establish the next slice's contract. D4 and D5
  may overlap only after D3's observable status shape is fixed and their write
  sets are disjoint.
- Executor prompts must exclude credentials, unrelated private material, and
  external provider calls. Reviewers are distinct from implementers, and the
  main session verifies every result before integration.

## Test portfolio

| Consequential behavior | Stable seam | Required cases | Distinct failure |
| --- | --- | --- | --- |
| Backward compatibility | config resolver and workspace ensure | no profiles; existing app-only profiles; managedRuntime absent | existing consumers change startup |
| Independent profile dimensions | schema and pure resolver | route-only, service-only, process-only, mixed, wildcard, default, reversed order, duplicates, unknown and empty tokens | route-free capability is rejected or gains apps |
| Effective config fidelity | generated-config unit/fixture test | same directory; only runServices changes; JSONC input; relative paths; atomic marker; ignored-path and collision refusal | native mode or source config is changed |
| Cold selective startup | DevPod characterization fixture | base plus one selected service; omitted service absent; postCreate runs once | all services start or bootstrap reruns |
| Warm addition | DevPod characterization fixture | add one stopped service without primary recreation or postCreate | addition needs recreate or fails silently |
| Warm removal | exact ownership fixture | stop only dropped exact container IDs; retain volumes and foreign workspace | leaked or foreign service is stopped |
| Process lifecycle | helper tests and managed adapter fixture | ensure, stop, status, unchanged idempotence, foreign PID/PGID, corrupt state, rollback | stale or foreign process is signaled/stopped |
| Transaction and rollback | workspace ensure integration | invalid zero-mutation; service failure; process failure; route failure; prior restoration; degraded drift | candidate routes/state survive failure |
| State and status | state-store and JSON snapshot contracts | persist after success only; restart recovery; desired/active diff; values-free output | false ready or sensitive output |
| Exact cleanup | real local smoke | stop exact workspace; zero owned routes/processes/running profile services | test runtime leaks |

## Slices and commits

### D0: establish the package

- Do: Commit this reviewed plan first and register it in the project index.
- Check: Re-run freshness and dirty-state checks; verify only the plan and index
  are staged; inspect staged content for secrets and personal data.
- Commit: `docs(project): add dependency-aware profile lifecycle plan`.

### D1: characterize DevPod selective service lifecycle

- Do: Build a minimal local fixture that uses the installed DevPod `0.6.15`, an
  all-on native config, and a generated selective sibling config. Record cold
  omission, warm addition, stopped-service restart, labels, primary container
  identity, volume identity, and post-create count.
- Do: Select the intended DevPod seam when it passes. If warm addition fails,
  prove the exact label-derived Compose startup fallback. If neither is exact,
  mark Progress blocked and stop.
- Check: Run the fixture repeatedly, including a second unchanged ensure and a
  second workspace that must remain untouched. Stop both exact fixtures and
  verify no routes or running services remain. Do not remove volumes.
- Commit: `test(devpod): characterize selective service lifecycle`.

### D2: define dependency-aware profile configuration

- Do: Add the ADR and strict `managedRuntime` schema, optional profile
  dimensions, canonical per-dimension unions, independent wildcards,
  default/full behavior, service-model validation, and legacy compatibility.
- Do: Extend resolved-profile types with desired app, service, and process sets
  without changing existing app/dependency/readiness meanings.
- Check: Run focused config tests for the complete profile matrix, schema
  diagnostics, unclassified native services, unknown registries, and
  absent-contract compatibility; run typecheck and relevant static checks.
- Reviews: Run `simplifier` and architecture/lifecycle `slice-reviewer` in
  parallel after the slice commit. Verify and disposition every finding.
- Commit: `feat(config): add dependency-aware profiles`.

### D3: reconcile exact services, processes, routes, and rollback

- Do: Generate the atomic same-directory effective config and pass it to DevPod
  before startup. Add exact workspace state, transition planning, warm service
  addition, process desired-set injection, helper `stop` and `status`, exact
  dropped-service stop, route commit ordering, prior-state restoration, and
  degraded drift reporting.
- Do: Keep `--recreate`, container removal, volume removal, broad Compose
  project commands, and foreign-process signaling outside every transition.
- Check: Run unit and integration cases for every transition phase and failure,
  two workspaces with similar names, stale/corrupt state, route rollback,
  unchanged idempotence, and source/effective config drift.
- Reviews: Run `simplifier` and architecture, lifecycle, rollback, and ownership
  `slice-reviewer` in parallel after the slice commit. Apply only verified
  findings and rerun affected cases.
- Commit: `feat(runtime): reconcile profile-owned runtime resources`.

### D4: expose desired, active, and drift state

- Do: Extend ensure JSON, status/list output, and doctor diagnostics with the
  canonical profile, desired/active apps, profile-owned services and processes,
  transition state, and values-free drift or rollback findings.
- Check: Preserve current fields; test healthy, starting, stopped, foreign,
  drifted, failed-transition, and legacy consumers; review output for values.
- Review: Run `simplifier` after the slice commit and verify its advice.
- Commit: `feat(status): report profile runtime drift`.

### D5: align architecture, consumer, and upgrade guidance

- Do: Update the ADR index, `docs/DEVCONTAINER.md`, lifecycle and consumer
  knowledge pages, examples, bundled devrouter skill, generated agent guidance,
  README references, changelog, upgrade prompt, and project Progress. Update
  AGENTS only where its high-level release checklist or contract changed.
- Do: Document native-full versus managed-selective behavior, ignored generated
  config ownership, exact stop, profile-only capability semantics, rollback,
  no-recreate, and migration from app-only profiles.
- Check: Run docs policy and knowledge validation, generated-guidance tests,
  link checks, formatting, and an exact diff-accounting pass.
- Commit: `docs(devcontainer): document selective profile lifecycle`.

### D6: prepare and prove the local release candidate

- Do: Prepare the next patch version after `0.0.38` using the repository's
  release process. Treat `0.0.39` as expected, not authoritative, until release
  metadata is updated on the fresh branch.
- Check: Run `check:docs-policy`, `check:knowledge`, formatter/lint checks,
  Knip, typecheck, full tests, build, package tests, routing smoke, Dev Container
  smoke, and the exact D1 lifecycle fixture. Run Opengrep when installed and
  separate new findings from pre-existing ones.
- Check: Pack the local artifact without installing it. Use that artifact for
  one provider-free Klicker consumer smoke covering native full, managed pure
  capability, managed app plus capability, warm replacement, invalid-selection
  preservation, and exact stop. No model request, secret, or real data is used.
- Finish: Inspect staged data and the complete diff; run one `final-reviewer` on
  the integrated committed package; resolve findings and rerun affected checks.
  Stop the exact test workspace and verify zero owned routes, managed processes,
  and running profile-owned services. Record `release_pending`.
- Commit: `chore(release): prepare dependency-aware profile release`.

## Release and downstream gate

- Local completion does not authorize or imply publication. The downstream
  Klicker package remains blocked at its immutable-version gate.
- Continuing requires explicit authority for the named push, pull request,
  merge, release publication, and any host package installation or update.
- After publication, verify the released package or tag, not only the local
  branch, then hand the exact version and release evidence to the Klicker plan.

## Expected final evidence

- DevPod `0.6.15` characterization result and selected warm-add seam.
- Focused schema, effective-config, transition, ownership, rollback, status, and
  compatibility test results.
- Full repository validation and package artifact result.
- Provider-free Klicker consumer smoke with no model call or secret access.
- Simplifier, slice-reviewer, and final-reviewer dispositions.
- Exact final runtime stop with zero owned routes, processes, and running
  profile-owned services; no volume, worktree, or branch deletion.

## Progress

- Status: Execution in progress; D0 and D1 are committed, and D2 is ready for
  its required post-commit reviews. The local
  release remains unpublished.
- Active slice: D2, after the DevPod lifecycle seam passed.
- Completed: Fresh worktree creation, first-party Dev Container and DevPod
  research, current devrouter contract inspection, Klicker dependency mapping,
  the required planning review, and the installed DevPod characterization.
- 2026-08-26 D1: `pnpm devpod:profile-smoke` passed with DevPod `v0.6.15`.
  Cold selective startup omitted the optional Compose service. A running
  workspace did not add it. Restarting the exact stopped workspace added it
  without recreating the primary app container, rerunning `postCreate`, or
  changing the owned volume set. A second exact workspace remained unchanged.
  Both workspaces were stopped and named volumes were retained.
- Remaining: D2-D6, then the separately authorized publication gate.
- Latest verified base: `origin/main` at `308854e`; task branch was 0 ahead and
  0 behind when created.
- Runtime: The D1 fixtures are stopped; their named volumes were not removed.
- Active children: none.
- D2 implementation: Added the strict `managedRuntime` registry, independent
  app/service/process profile dimensions, per-dimension wildcard merging,
  route-free capability profiles, legacy compatibility, focused tests, and ADR
  0005. The focused profile suite has 96 passing tests and TypeScript passes.
- Required delivery layer: locally committed, fully verified release candidate
  with exact test runtime stopped and status `release_pending`.
- Achieved delivery layer: reviewed plan, D0 plan commit, and D1
  characterization commit.
- Next action: Add and test the dependency-aware `managedRuntime` schema and
  ADR in D2.

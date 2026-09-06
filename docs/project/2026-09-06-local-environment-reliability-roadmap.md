# Cross-repository local environment reliability roadmap

## Proposed outcome and approval boundary

Make supported development environments reach a usable application through one
predictable command, recover from ordinary interruption without losing local data,
and explain failures without requiring repeated agent investigation.

The recommended sequence is to measure the actual developer journey, strengthen
readiness and recovery, isolate mutable build state, then qualify the installed
tool across representative repositories. Optimize measured bottlenecks after
correctness is observable. A successful process start is not the target outcome;
a developer must be able to complete the repository's declared smoke journey.

This is a proposed roadmap, not an implementation plan or a claim that every
reported incident remains broken. The user authorized this document, its local
commit, normal branch push, and a draft PR. Implementation, consumer-repository
changes, installed-app upgrades, machine configuration, destructive tests,
releases, and merges require their own scoped approval. No runtime is started or
modified by this documentation package. Independent planning review is pending;
the authoring side conversation prohibits subagents.

Important choices remain open: which platform combinations receive a support
commitment, which application probes may write synthetic data, and whether any
automatic cache repair or idle stopping should be enabled. The conservative
recommendation is read-only diagnostics and reversible, exact-workspace recovery,
with destructive operations remaining explicit.

The immediate implementation candidate is **W1 — actionable failure evidence**.
Agreement with this direction does not authorize the other work items. Each item
must become a separately scoped execution package with fresh source inspection.

## Context and evidence boundary

Date: 2026-09-06. Audience: a maintainer deciding direction, then a developer or
agent implementing an approved item without the originating conversation.

Repository: `rschlaefli/devrouter`. Roadmap branch:
`rs/local-environment-reliability-roadmap`. Target: `main`. Inspected base:
`e8f7549cbc2206604e997c0f07d836c390f302c2`, whose package version is `0.0.55`.
Source state is distinct from an installed binary or a successfully exercised
consumer environment. No fresh live reliability benchmark accompanies this PR.

### Existing work to preserve and reuse

| Capability or repair | Verified source or delivery record | Consequence for this roadmap |
| --- | --- | --- |
| Exact checkout ownership and generic process lifecycle | [Architecture and ownership](../knowledge/architecture-and-ownership.md), [managed lifecycle](../knowledge/managed-environment-lifecycle.md), `src/core/workspace-ensure.ts`, `bin/devrouter-process` | Extend existing ownership and reconciliation; do not add another supervisor. |
| Retained-runtime repair and ordered preparation | [PR #51](https://github.com/rschlaefli/devrouter/pull/51), commit `f4c9cdd`; [PR #52](https://github.com/rschlaefli/devrouter/pull/52), commit `0152c80` | These fixes are already on the inspected base. Remaining work concerns coverage and contracts, not recreating them. |
| Retained service shutdown, resolved Compose fingerprints, mount ordering | [PR #53](https://github.com/rschlaefli/devrouter/pull/53), commit `aba5287`; [PR #54](https://github.com/rschlaefli/devrouter/pull/54), commit `aad6111`; [PR #55](https://github.com/rschlaefli/devrouter/pull/55), commit `e8f7549` | Preserve strict identity proof and environment-sensitive invalidation. Do not weaken guards to make retries pass. |
| Profiles and CI bindings | [Dependency-aware profiles](./2026-08-26-devcontainer-dependency-profiles-plan.md), [CI profile contract](./2026-08-30-ci-profile-plan-contract-plan.md), [ADR 0007](../adr/0007-keep-ci-profile-planning-repository-owned.md) | Profiles already exist. Repositories own command semantics; Devrouter emits validated literal bindings rather than executing CI workflows. |
| Resource reporting and installed-package proof | [Resource roadmap](./2026-08-16-workspace-resource-accounting-roadmap.md), [delivery reconciliation PR #44](https://github.com/rschlaefli/devrouter/pull/44), [package-proof roadmap](./2026-08-15-packaged-cli-command-release-proof-roadmap.md), [profiles and leases plan](./2026-08-24-profiles-leases-resource-plan.md) | Reuse these seams. Some project-record status is historical; do not infer missing implementation from an old status heading. |

[PR #56 — reset-failure recovery](https://github.com/rschlaefli/devrouter/pull/56)
is an open draft at inspection, on `rs/reset-rollback-recovery`, head
`71aa5a8d33ea8966c76705e41273cb7d3d384b5e`. It owns retaining coherent recovery
state after reset failure. Coordinate with that branch before editing the same
reconciler. Its source and test evidence do not establish a completed live
reset-failure recovery journey. This roadmap neither supersedes that PR nor
duplicates its implementation. PR #44 owns historical resource-delivery record
reconciliation; leave that correction to its existing branch.

### Incident-derived hypotheses, not fresh reproductions

The motivating consumer investigation reported repeated startup attempts,
recycled provider state, root-page readiness despite broken authentication
subroutes, incompatible generated artifacts, and installed-tool ambiguity.
These observations identify qualification cases. They are not sufficient to
assign every failure to Devrouter, a provider, or application code.

| Observed failure class | What must be established before a fix | Intended prevention |
| --- | --- | --- |
| Root page answers but login or API route fails | Probe exact subroute, response shape, redirects, and application logs; an HTTP 404 alone does not establish stale cache | Repository-owned semantic smoke journey and separate readiness levels |
| Clearing generated state appears to help | Record writer, mode, toolchain, inputs, and failing artifact before invalidation | Artifact ownership and minimal invalidation, not routine cache deletion |
| Cache archive causes a second compilation failure | Determine whether the framework scans the archive location | Quarantine outside source and watcher discovery, with explicit retention |
| Different invocation paths select incompatible tools | Compare resolved executable and helper protocol, not just a version printed elsewhere | Deterministic resolution and compatibility preflight |
| Unrelated container churn or slow dependencies disrupt startup | Reproduce target discovery race or deadline failure in disposable fixtures | Target-scoped inspection and bounded, progress-aware waits |

Large concurrent stacks are a capacity concern, not proof that resource
exhaustion caused a particular incident. Collect memory, CPU, disk, and elapsed
phase evidence before prescribing more hardware or replacing the provider.

During this documentation package, the host shell resolved Node `26.8.1` despite
the repository's Volta pin of `24.16.0`. Frozen installation exited successfully
while the optional `cpu-features` native build failed. This is direct evidence
that a declared pin and a successful install exit do not establish the effective
toolchain or every dependency's availability. Scoped validation uses the already
installed pinned Node binary; no global tool configuration is changed.

## Product boundaries and non-goals

The existing [architecture](../knowledge/architecture-and-ownership.md) remains
the authority. Devrouter owns exact workspace reconciliation, routing, generic
process supervision, and truthful diagnostics. Providers own their runtime.
Repositories own dependency preparation, application commands, schema evolution,
fixtures, and the meaning of functional readiness.

| Primitive | Proposed change | Boundary retained |
| --- | --- | --- |
| Workspace | Expose a coherent generation and recovery phase to consumers | Git and existing durable owner records determine identity; no global repository registry |
| Profile | Make the smallest useful developer journey discoverable | Existing independent app, service, and process dimensions; no silent change to the full default |
| Managed process | Bind reuse evidence to preparation and artifact compatibility | One existing supervisor; application preparation remains repository-owned |
| Route and readiness | Distinguish route publication, transport reachability, and application usability | Application status cannot substitute for exact Traefik generation proof |
| Lifecycle evidence | Provide bounded, machine-readable failure and recovery information | Evidence conveys no authority to delete, stop another workspace, or expose secrets |

Keep `.devrouter.yml` as the configuration entry point and existing machine
artifact ownership under `~/.config/devrouter`. Preserve `.localhost`, shared
Traefik ports, TLS-required database routing, repository path confinement, and
runtime-only delivery of the matching helper. Keep provider mutation locks and
ownership checks until a testable alternative proves equivalent safety.

This roadmap does not propose Kubernetes, a replacement for OrbStack, a new
global daemon, blanket retries, blanket dependency upgrades, or full-stack
startup for documentation and pure source checks. It does not promise offline
operation for uncached dependencies or real external integrations. It does not
make Devrouter a package manager, migration engine, secret store, or CI scheduler.

## Work sequencing

Priority P0 protects correctness and diagnosis. Priority P1 improves repeatable
daily use. Priority P2 optimizes measured cost. Start with the smallest independent
package; do not open all branches at once.

### First: make failure and recovery trustworthy

| Work item | Priority | Dependency and terminal |
| --- | --- | --- |
| W1 — actionable failure evidence | P0 | No implementation dependency; reviewed PR ready for a separate merge decision |
| W2 — meaningful readiness and reuse | P0 | Uses W1 — actionable failure evidence; probe policy decision required before new probe execution |
| W3 — interruption-safe lifecycle recovery | P0 | Coordinate PR #56 — reset-failure recovery; use W1 — actionable failure evidence |
| W4 — artifact and toolchain isolation | P1 | Uses W1 — actionable failure evidence; cache policy decision before automatic invalidation |
| W5 — deterministic local application contracts | P1 | Uses W2 — meaningful readiness and reuse and W4 — artifact and toolchain isolation; consumer changes require separate scope |

### Then: qualify scale and delivery

| Work item | Priority | Dependency and terminal |
| --- | --- | --- |
| W6 — right-sized profiles and capacity visibility | P2 | Reuse existing profiles and resource accounting; establish baseline first |
| W7 — installed-tool compatibility and upgrades | P1 | Reuse existing packaged CLI proof; support matrix decision before support claims |
| W8 — cross-repository reliability qualification | P1 | Incremental harness may start after W1 — actionable failure evidence; release acceptance needs the relevant preceding contracts |

Work on diagnostics and a repository-specific contract prototype can proceed in
parallel only with separate approved scopes and no shared mutable runtime. Keep
one writer on `workspace-ensure.ts` and one writer on `bin/devrouter-process`.
Do not replace or duplicate an active recovery branch to accelerate this plan.

## Shared execution contract

Each approved item uses a dedicated `rs/<descriptive-name>` branch in
`trees/rs/<descriptive-name>`, based on freshly inspected `origin/main`, targeting
`main`. Reuse an existing matching worktree first. The item owner is the assigned
implementer; no person or agent is preassigned by this proposal. The maintainer
owns design rulings, merge, release, and machine-level activation decisions.

Every item ends at `pr_ready`: exact diff reviewed, applicable checks passing,
remaining live-proof gaps stated, and PR publication separately authorized.
Roadmap text alone grants none of those future mutations. Do not equate a source
merge with package publication, installed adoption, or consumer live proof.

Host Git and forge commands stay on the host. Devrouter's own pinned Node/pnpm
toolchain follows its repository setup; consumer toolchain commands follow each
consumer's execution-mode contract. Start no environment for documentation-only
verification. Choose focused tests from
[the change and verification map](../knowledge/change-and-verification-map.md),
then run the applicable repository gates:

```sh
pnpm check:docs-policy
pnpm check:knowledge
pnpm check
pnpm knip
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
```

The list is a menu of existing gates, not permission to run live smoke scripts.
Runtime tests require named disposable fixtures and approved mutation boundaries.
Each implementation plan must name the exact focused command and extend existing
behavioral tests before adding another overlapping suite. Test structured
contracts and outcomes, not documentation prose or incidental seed contents.

## W1 — actionable failure evidence

**Problem.** Agents repeatedly reconstruct the same environment state from
scattered commands. Generic readiness or provider errors obscure the failing
layer and encourage retries without a new hypothesis.

**Do.** Extend existing diagnostics in `src/core/doctor.ts`,
`src/core/tool-diagnostics.ts`, `src/core/status.ts`, `src/core/output.ts`, and
the existing managed-runtime status seam. Inventory existing JSON fields before
adding fields. Introduce a versioned failure contract only where necessary.
Report exact target identity, resolved executable provenance, phase, elapsed
time, failure classification, evidence freshness, and one scoped next action.
Separate application failure, provider failure, configuration conflict,
unavailable observation, and expected waiting. Unknown must remain unknown.

Capture bounded phase timings for discovery, queueing, preparation, provider
transition, process start, route publication, and application probe. Ordinary
status stays cheap; expensive storage walks or broad logs remain opt-in.
Offer a bounded local diagnostic bundle through the existing command surface,
not a second command family. Specify a size limit and retention policy before
implementation. Prefer structured allowlisted metadata to regex-redacted logs.
Exclude environment values, tokens, cookies, authorization headers, process
arguments that may carry secrets, request bodies, and raw provider inspect data.
Do not upload diagnostics automatically.

**Check.** Extend doctor/status/output tests with one failure per layer, missing
tools, permission denial, stale evidence, and a deliberately secret-bearing
fixture. JSON must remain parseable, bounded, and values-free. Distinguish
partial results from successful diagnosis. A repository without Docker must
still receive useful static diagnostics without installation or repair.

**Working context.** Devrouter diagnostics worktree, single writer on output
contracts. **Gate.** None for a read-only prototype; schema compatibility gets
maintainer review. **Release-note claim.** Failed startup identifies the failing
phase and a scoped next action, supported by installed-package failure tests.

## W2 — meaningful readiness and reuse

**Problem.** A running process or answering root page does not prove the user can
log in, query an API, or exercise the selected feature.

**Do.** Extend `src/core/workspace-ensure.ts`, managed runtime status, profile
resolution, and repository integration documentation. Preserve distinct proof
levels: provider/services healthy, processes present, exact routes applied,
transport reachable, and repository-declared application smoke passed. Report
the achieved level explicitly. Missing optional smoke definitions mean
unverified application usability, not failure and not proof of success.

Keep application semantics in a repository-owned smoke task. If Devrouter needs
a new adapter or result schema, review that public contract first; do not execute
the literal bindings emitted by `profile plan`. Basic probes can assert expected
status, content type, bounded response shape, and redirect destination. A login
journey must include the actual auth subroute and authenticated capability, not
only an HTML shell. CLI transport proof and browser cookie/TLS proof are separate.

Associate reusable evidence with the relevant process generation, profile,
preparation inputs, route generation, and probe contract. Define invalidation
and an age bound. Reused proof must be labelled and cheap liveness rechecked;
an old successful browser run must not mask a crashed service. Avoid rebuilding
or rerunning all application tests merely to resume an unchanged workspace.

**Check.** Use fixtures where root returns 200 but login returns HTML 404, the API
returns the wrong media type, redirects leave the workspace, and a process dies
after a previous pass. Add a warm unchanged case that performs no preparation.
Use existing ensure and route-health tests, plus one consumer-owned functional
smoke. Do not normalize every 401 or 404 to failure; the repository defines its
expected unauthenticated contract.

**Working context.** Devrouter readiness branch; separate consumer adoption PR.
**GATED on A1 — probe side effects** before executing new application probes.
**Release-note claim.** Readiness distinguishes infrastructure from declared
application usability; installed fixture and browser evidence are required.

## W3 — interruption-safe lifecycle recovery

**Problem.** Provider reset, cancellation, partial service startup, or failed
reconciliation can leave state that another ensure cannot interpret reliably.

**Do.** Inspect and reuse PR #56 — reset-failure recovery before changes to
`src/core/workspace-ensure.ts`, `src/core/managed-runtime-state.ts`,
`src/core/devpod-environment.ts`, and provider stop/mutation modules. Specify the
transition table for absent, starting, ready, degraded, stopping, and unavailable
evidence. Persist only identity and non-secret transition metadata needed to
recover. Positive absence permits absence handling; an observation error does not.

Audit global container discovery separately from the recently hardened retained
stop path. Bound exact-target queries and tolerate unrelated disappearance only
when it cannot conceal target ownership uncertainty. Retry only classified,
transient observations within a deadline; retain the original error otherwise.
Waiting for health needs progress and a deadline appropriate to the repository's
service contract, not unconditional recreation after one short timeout.

Cancellation must leave one coherent resumable state and terminate only owned
process groups. Preserve data volumes during ordinary repair. Publish routes
after candidate proof; remove stale owned routes on terminal failure according
to the existing lifecycle contract. Audit lock duration with phase timings, but
preserve fair provider queues and machine-global safety where providers require
serialization. A timeout must not trigger a second competing reconciler.

**Check.** Extend existing ensure, provider inspection, stop, and process tests.
Inject cancellation at transition boundaries, target disappearance, unrelated
container removal, mount enumeration reorder, delayed health, partial stop, and
failed reset followed by ensure. Assert exact surviving services, ownership,
routes, process groups, and retained data. Live VM recycling belongs only in an
approved disposable qualification environment, never the developer's active VM.

**Working context.** One reconciler writer; reuse existing recovery ownership.
**Gate.** Coordinate PR #56 — reset-failure recovery before overlapping edits.
**Release-note claim.** Named interruption scenarios recover without data loss;
each claimed scenario needs installed-package live proof, not unit tests alone.

## W4 — artifact and toolchain isolation

**Problem.** Correct source can fail when a different OS, architecture, package
manager, build mode, or concurrent writer produced its mutable outputs.

**Do.** Extend onboarding diagnostics/templates and the preparation contract in
`src/core/managed-post-start.ts` and `bin/devrouter-process` only where generic
support is needed. Repositories declare artifact ownership and preparation;
Devrouter does not infer every framework's output directories or run arbitrary
package-manager repairs. Detect incompatibility before app startup and identify
the narrow preparation step required.

Separate host and container mutable installs, generated clients, and framework
outputs. Separate development outputs from production-build/test outputs whenever
the framework supports concurrent modes. Otherwise enforce exclusive writers or
use a separate checkout. Share immutable download caches only with appropriate
platform and toolchain keys. For Node include workspace links and native modules;
for Python include interpreter/ABI and virtual environments; for compiled
languages include target architecture and compiler configuration. These are
consumer responsibilities exposed through one generic lifecycle contract.

Preparation fingerprints must cover relevant lockfiles, package definitions,
toolchain, platform, install configuration, generator inputs, and build mode.
Environment-sensitive fingerprints must follow existing values-free handling;
do not persist raw resolved environment data. A branch name alone is not a cache
key. A successful stamp is written only after preparation succeeds, under the
same ownership/locking discipline as its outputs.

Automatic repair, if approved, may quarantine only declared generated artifacts.
Place archives outside source discovery and watcher paths, avoid symlink escape,
account for size, and provide explicit recovery/retention. Never include database
volumes, untracked user files, secret files, or broad workspace roots. Do not
prescribe a framework output location that the framework does not support.

**Check.** Qualify host/container alternation, lockfile change, interrupted
installation, stale generated client, concurrent dev/build, and archive scanning.
The unchanged warm case must skip preparation. A failed preparation must not
publish a success stamp. Confirm consumer tracked files remain unchanged.

**Working context.** Generic adapter PR and separately approved consumer PRs.
**GATED on A2 — generated-state repair policy** for automatic quarantine.
**Release-note claim.** Incompatible generated state is detected and repaired
through the declared preparation path; proof must name language and mode pairs.

## W5 — deterministic local application contracts

**Problem.** External identity, flags, storage, queues, or paid AI can block
ordinary UI verification even when infrastructure is healthy.

**Do.** Improve `examples/devcontainer/`, onboarding templates, and
`docs/REPO_ONBOARDING.md` around a single repository-owned services, environment,
bootstrap, and verification contract. Native, container, routed, and CI modes
consume that contract rather than maintain parallel startup logic. Support only
the modes the consumer declares; do not force every repository to support all.

Define explicit local and external-integration modes. Local fixtures should
exercise real authorization using synthetic identities and capabilities, not
bypass access control. Cover ordinary, entitled/beta-enabled, restricted, and
delegated accounts where relevant. Local flags should deterministically express
enabled, disabled, and unavailable states without depending on a remote flag
service. Keep mock namespaces separate from real credentials and reject mock
configuration in production. Opting into external services must expose its data
and cost boundary; stale environment files must not silently choose it.

Make schema readiness, migration status, and fixture capabilities observable.
Routine start and smoke must not reset or reseed valuable local data. Fresh
disposable test databases and destructive reset remain separate named actions.
Repositories own idempotent synthetic seed behavior and migration ordering.
Use a URL-parameterized smoke command that CI also consumes, including auth
callbacks, cookie domain, and host-to-container access where relevant.

**Check.** Adopt the contract in a minimal non-Node fixture and one separately
approved application repository. Prove login and one meaningful action without
external credentials; reject mock-in-production and wrong-workspace callbacks.
Verify a warm smoke leaves pre-existing synthetic data intact. Test external
failure as unavailable, not as a silently successful mock fallback.

**Working context.** Devrouter examples owner; consumer maintainers own application
changes. **Gate.** Explicit consumer scope and approval of external calls.
**Release-note claim.** Named examples reach a functional local journey without
external credentials; no claim about unadopted repositories.

## W6 — right-sized profiles and capacity visibility

**Problem.** Starting every service for a small edit wastes resources and makes
unrelated optional dependencies part of the critical path.

**Do.** Reuse `src/core/profile-resolution.ts`, `src/core/profile-plan.ts`,
`src/core/workspace-consumption.ts`, and existing lease/resource planning. Verify
which lease behavior actually exists before extending it. Show resolved apps,
services, and processes before startup. Let repositories recommend task profiles
such as UI, API, or integration without silently changing existing full defaults.

Use measured phase and resource data to identify expensive builds, bind-mount
I/O, watcher load, duplicated workers, or oversized service sets. Distinguish
shared image size from reclaimable storage and unavailable readings from zero.
Keep capacity advice report-only initially. Any admission limit, idle suspension,
or automatic stopping needs explicit policy, active-work vetoes, and exact
ownership. A lease timestamp alone is not proof that human work is idle.

Only after measurement, evaluate prebuilt stable toolchain/dependency layers,
content-addressed download caches, and reduced watcher scope. Keep source live
and avoid sharing mutable build outputs. Compare cold, cached-cold, and warm
journeys separately so cache speed does not hide correctness defects.

**Check.** Use two repositories with multiple worktrees. A narrow profile must
exclude unrelated optional services, preserve required base dependencies, and
transition without losing data. Resource reporting must stay bounded and must
not stop another workspace. Benchmark a documented workload before and after
each optimization; do not infer pressure from container count alone.

**Working context.** Profile/resource branch, coordinated with existing plans.
**GATED on A3 — capacity intervention policy** for any automatic action.
**Release-note claim.** Named task profiles reduce measured startup or resource
cost; publish the workload and measurement conditions, not an unqualified speedup.

## W7 — installed-tool compatibility and upgrades

**Problem.** A repository pin, shell-resolved binary, provider agent, and delivered
helper can disagree even though each appears individually installed.

**Do.** Extend `src/core/tool-diagnostics.ts`, `src/core/upgrade.ts`,
`src/core/managed-post-start.ts`, and existing package smoke coverage. Report
resolved executable location and version, package provenance when available,
provider version, helper compatibility, and relevant Docker context. A mismatched
or shadowed executable must produce an actionable preflight failure before
mutation. Do not install a second CLI inside managed consumer images.

Define a tested compatibility matrix for Devrouter, provider, Docker/Compose,
host OS/architecture, and runtime toolchain. Scope guarantees to tested cells.
Pin provider agents and distribution artifacts with integrity checks; distinguish
verified cached availability from first acquisition requiring network. Handle
unsupported or newer versions explicitly rather than assuming compatibility.

Use explicit upgrades, a canary consumer, and known-good package provenance.
Keep an active operation on one coherent helper/protocol version. Document
whether state remains readable by the previous release before claiming rollback.
Host PATH and shell wrapper repairs should be suggested, not performed silently.
No global auto-update or machine-wide reinstall belongs in ordinary ensure.

**Check.** Extend `scripts/package-smoke.sh` and tool diagnostics tests with
shadowed executables, incompatible helpers, missing verified agent cache,
unsupported versions, offline cached use, and tampered artifacts. Verify the
packed CLI rather than only `tsx` source execution. Test supported provider
combinations in disposable fixtures before publishing compatibility claims.

**Working context.** Package/diagnostics branch; follow existing package-proof
roadmap rather than creating a parallel distribution harness.
**GATED on A4 — supported platform matrix** for support commitments.
**Release-note claim.** Compatibility problems are diagnosed before mutation;
each advertised combination has installed-package evidence.

## W8 — cross-repository reliability qualification

**Problem.** Unit tests can pass while packaging, browser behavior, concurrency,
or recycled runtime state still prevents a developer from working.

**Do.** Extend existing package, routing, devcontainer, profile, and workspace
smoke scripts. Keep a small layered portfolio: fast deterministic contract tests,
installed CLI tests, and a bounded live qualification matrix. Use a minimal
Node application, a minimal non-Node application, and a separately approved
multi-app consumer. Repositories own semantic smoke tasks; Devrouter owns generic
lifecycle assertions. Do not copy full consumer test suites into Devrouter.

Run ordinary disposable fixture tests per relevant change and broader provider
qualification on scheduled or release-candidate runs. Fault injection must target
an isolated VM or runner, not a shared developer runtime. Each run records exact
package digest/version, source revision, provider/toolchain matrix, profile,
cache state, phase timings, result, and sanitized failure classification.

| Journey | Required assertion |
| --- | --- |
| Fresh checkout and cached-cold start | Documented prerequisites reach the declared functional smoke; no hidden manual setup |
| Warm ensure and stopped resume | No unnecessary install/rebuild; fresh liveness and correct proof reuse |
| Input change and dev/build alternation | Required outputs regenerate; incompatible writers cannot corrupt each other |
| Cancellation, reset failure, provider recycling | Recovery remains exact-workspace scoped and preserves declared persistent data |
| Parallel repositories, unrelated churn, DNS/TLS and browser auth | One lifecycle operation leaves the other workspace usable; browser and CLI address the intended routes |

Add focused negative cases for delayed health, dependency outage, disk-full or
permission failure, stale ownership, and unavailable observation. Avoid the
Cartesian product: choose pairwise coverage plus explicit high-risk combinations
and document untested cells. A failed attempt remains a failure in the report
even if a retry succeeds; classify flaky recovery rather than laundering it.

**Check.** The approved matrix passes against the installed release candidate.
Revert one representative guard and show its regression test fails. Preserve
bounded failure artifacts, report skipped cases, and prove fixture-only cleanup.
An advertised release gate requires CI wiring and a successful gate run, not
merely scripts in the repository.

**Working context.** Qualification branch; coordinate scripts with existing
package-proof work. **Gates.** A4 — supported platform matrix and
A5 — qualification infrastructure before live destructive fault tests.
**Release-note claim.** The named release candidate passes a published, bounded
qualification matrix. Never describe all environments as universally bulletproof.

## Success measures and release acceptance

Measure time to usable application, not time until the provider command exits.
Separate active agent effort, unattended waiting, first-attempt success, repeated
recovery attempts, and manual interventions. Report cold, cached-cold, warm, and
stopped-resume cohorts separately, with profile and machine class.

Provisional targets for a cached minimal fixture are warm ensure below 10 seconds,
stopped resume through functional smoke below 60 seconds, and cached-cold startup
below 3 minutes. These are hypotheses for baseline comparison, not commitments
for an arbitrary monorepo or uncached network install. Establish sample counts,
variance, and a percentile target before using them as release gates.

The correctness gate is stricter: qualification must observe no cross-workspace
mutation, unauthorized data deletion, secret disclosure, false application-ready
claim, or orphaned owned process after completed stop. A single violation blocks
the affected release claim. Passing a finite suite is bounded evidence, not proof
that these events are impossible.

A release candidate should carry five evidence groups: supported matrix and
package provenance; fresh and warm functional journeys; recovery and isolation;
measured latency/resource change; and open gaps with rollback constraints. Source
review, CI success, package publication, installed adoption, and consumer live
proof remain separately recorded stages.

## Decisions required before affected implementation

| Decision | Options and recommendation | Hard stop |
| --- | --- | --- |
| A1 — probe side effects | Default to read-only transport/shape probes. Permit login or synthetic writes only through an explicitly selected repository smoke task with isolated fixtures and cleanup rules. | New automatic application probe execution in W2 — meaningful readiness and reuse |
| A2 — generated-state repair policy | Recommend diagnose and offer exact repair first. Opt-in automatic quarantine may follow proven ownership; never automatic database reset or broad deletion. | Automatic invalidation in W4 — artifact and toolchain isolation |
| A3 — capacity intervention policy | Recommend advisory budgets first. Automatic queueing or idle suspension changes user control and needs separate policy and active-work protection. | Automatic resource actions in W6 — right-sized profiles and capacity visibility |
| A4 — supported platform matrix | Recommend a small explicit matrix based on actual adoption, then add cells only with evidence. Do not imply Windows, every provider, or every Docker version is qualified. | Support promises in W7 — installed-tool compatibility and upgrades and W8 — cross-repository reliability qualification |
| A5 — qualification infrastructure | Recommend isolated disposable runners or VMs with bounded cost and synthetic data. Choose ownership, budget, retention, and provider licensing before provisioning. | Infrastructure creation and reset/failure injection in W8 — cross-repository reliability qualification |

## Adoption and simplification

Start with generic evidence and one representative consumer, then prove the same
contract in a different language/runtime before distributing templates broadly.
Consumer PRs should remove the superseded local workaround when the canonical
path demonstrably covers its behavior. Preserve documented escape hatches;
do not remove a supported mode merely to simplify testing.

Prefer deleting a redundant step over adding a service to manage it. Examples
include replacing repeated manual dependency builds with the existing preparation
hook, replacing parallel bootstrap scripts with a repository-owned task, and
replacing repeated chat log reconstruction with one bounded diagnostic result.
Do not solve package-manager, provider, and application defects with a growing
set of repository-name conditionals in Devrouter.

External dependencies are explicit: provider fixes may require upstream reports;
application maintainers must own synthetic auth/flag fixtures; package managers
and frameworks determine valid artifact locations; qualification runners need
separate operational ownership. Investigate upstream behavior with current
primary documentation before designing version-specific implementation.

## Review and progress

For each future item, retain the base/head, complete diff, affected contracts,
focused checks, installed/live proof where applicable, unresolved decisions, and
next authority boundary. Review lifecycle and artifact changes for ownership,
data integrity, failure behavior, and unnecessary complexity. A reviewer must
check that the implementation composes with existing PRs and does not weaken
guardrails to meet timing targets.

2026-09-06: Proposed roadmap drafted from current Devrouter source, existing
project records, open PR state, and incident-derived consumer hypotheses.
Independent review is pending. No implementation or live qualification is
claimed. The documentation package is intended for a draft PR; roadmap agreement
and subsequent execution approval remain distinct.

# eLearning readiness and retained preparation

## Outcome and authority

Continue the reliability roadmap with eLearning as the real consumer. Ordinary
startup must distinguish a responding route from the declared application health
contract. A failed application check must leave the development tools and routes
available so an agent can fix application code. Warm startup must preserve cache
and synthetic data.

The user authorized continuing the roadmap, isolated eLearning work, local source
changes, checks, reviews, commits and routine draft delivery. This package changes
Devrouter and the isolated eLearning task branch. It may initialize the pinned
submodule and start, inspect, execute inside and non-destructively stop that exact
consumer runtime after the checks below. Existing environments remain protected.

This package does not install a controller, enroll a coding harness, induce OOM,
fill disks, restart the shared VM, reset databases, delete volumes or caches,
merge, release or deploy. Capacity admission and continuous recovery remain later
roadmap stages. Resource caps here bound one canary; they are not global admission.

Success means passing source and installed-package checks, a real health and
synthetic learner journey, preserved state across warm ensure and stop/resume,
and final exact-provider stopped plus zero-route proof. A staged tooling startup
used to inspect limits is recorded as staged qualification, not a one-call cold
startup pass. That remaining milestone needs pre-launch limit verification.

## Baselines and ownership

Devrouter uses the existing `rs/reliability-contract-foundation` worktree. Its
reviewed lifecycle source is f49ef002fb04bc89e93f3d1514401ad7027d710b; documentation
and draft-delivery head is db893a304e42d971eeea0ff6dbdb3048c1e02fff. Draft PR #58
targets main and passes CI. Do not rebase or integrate target changes implicitly.

eLearning uses `trees/rs/reliability-canary`, branch `rs/reliability-canary`, from
fc0e48825cfc81591e725d2927f5293dbdc3d44b. The primary checkout remains untouched.
The design-system submodule is pinned to cb2cb920b24a7dd8e7c3cac7017822d1eb954136.
Devsy 1.16.2 and its verified ARM64 agent are ready. Docker is 29.4.0 and Compose
is 5.1.2. The shared Docker VM reports 34.26 GiB; the host reports 64 GiB.

Main owns public-contract decisions, lifecycle integration, data and resource
boundaries, final proof and delivery. A trusted executor owns isolated consumer
changes; another may own HTTP schema/probe implementation after the contract is
settled. Their write sets must be disjoint. Main retains lifecycle integration
because the existing rollback and completion semantics are tightly coupled.

## Primitive impact

| Product primitive | Change | Contract |
| --- | --- | --- |
| Application capability | Extend | Repository declares expected HTTP evidence independently of route liveness. |
| Lifecycle operation | Compose | An observed application failure is a known outcome; it does not imply unknown execution or authorize speculative recreation. |
| Managed environment | Reuse | Exact ownership, retained configuration, stop fences and non-destructive stop remain authoritative. |

## HTTP readiness contract

Add optional `readiness` to HTTP proxy apps in `.devrouter.yml`. It contains a
required absolute same-origin `path`, optional `statuses` defaulting to `[200]`,
and optional `contentType`. A status list is unique, nonempty, bounded to 32,
and contains only integers in 200–299 or 400–499. Redirects are never followed.
An explicit 401 can prove an authentication boundary; it does not prove an entire
application journey. eLearning declares `/api/health`, `[200]`, `application/json`.

Paths are bounded to 512 ASCII characters, start with one slash, and exclude
percent escapes, query, fragment, backslash and dot segments. No credentials,
custom headers, shell evaluation or arbitrary probe command is introduced.
Compare valid MIME base types case-insensitively after removing parameters;
missing or malformed content type fails when required. No `+json` equivalence.

Use the existing configured virtual host and TLS certificate pin. Disable curl
user configuration and proxy inheritance for the declared local probe, retain
the five-second total limit, and bound the parent process and remaining overall
deadline. Record only bounded status/classification metadata, not response bodies,
headers or raw server diagnostics. No-contract apps retain route-only behavior.

Apply the same parser and probe in ensure and live devcontainer verification.
Update canonical integration documentation, bundled skill and AI prompt together.

## Application failures and lifecycle completion

Add `applicationReadiness` to the ensure result with `ready` or `application-error` and bounded per-app checks; omit the field
for legacy route-only apps. After exact infrastructure and
route proof, a declared endpoint mismatch is collected as application failure.
After ownership and infrastructure, process and route proof, an unavailable
endpoint or transport failure is also an application-error: infrastructure has
no evidence authorizing recreation. Failures before those proofs remain
infrastructure failures. Application-error does not trigger the legacy recreate
path or speculative managed rollback.
Persist the reconciled infrastructure state and keep tools and routes available.

The CLI emits the structured result and exits nonzero for application-error.
Human output identifies available infrastructure and the failed application
contract without saying the application is ready. The worker records definite
completion with the same nonzero outcome, rather than unknown execution. A later
exec remains possible after worker drainage; explicit stop still wins races.
This package does not claim to activate the foundation's APP_ERROR projection or
its future continuous capability observations.

## Consumer preparation and resources

Remove unconditional `.next` deletion from container development startup. Add an explicit workspace-keyed
named volume mounted at /workspaces/elearning/apps/elearning/.next; preserve host output and unrelated
files. Preparation uses an owned lock and identity derived from toolchain/platform,
lockfile and adapter. Do not delete outputs on mismatch or introduce quarantine.
Concurrent development/build qualification remains a later artifact-isolation case.

Post-create always performs dependency installation, storage initialization and
database migration. Synthetic preparation runs only with the explicit local
canary flag. Unknown nonempty application data fails only synthetic preparation;
the app and tooling remain usable.

Use canonical `devrouter exec` for explicit `dev:seed`. Automatic canary setup must
not call the existing content seeder, which updates courses and deletes progress.
The canary's explicit synthetic preparation proves the local database hostname,
database name and workspace identity before mutation. It accepts an empty migrated
application database or its own previously recorded fixture. Nonempty unrelated
data prevents fixture creation; it is never reset. Stable synthetic course/module/
unit identifiers make reuse verifiable. Create a minimal learner fixture and
sentinel, then check they survive warm ensure and stop/resume unchanged. Keep
synthetic signing values inside the runtime; do not emit tokens in logs or receipts.

Register base services `postgres` and `azurite`, and managed process `app`. The
tooling profile starts base services without the app process. A full profile adds
the app and routes. Before activation, render and inspect only allowlisted resource
fields. Set application memory to 6 GiB, PostgreSQL to 512 MiB and Azurite to
256 MiB, with equal memory-plus-swap limits. Start one environment at a time.
Before starting the app process, prove actual limits on the exact owned containers;
the app adapter also checks its own cgroup limit. Do not infer available capacity
from declarations or increase limits automatically. Image-build resources are a
separate risk: serialize preparation and use the existing pinned base image.

## Verification and delivery

Test schema boundaries, wrong status/media, redirects, TLS/transport failure,
deadline bounds, legacy route-only behavior, and actual curl behavior with a local
synthetic server. Test application failure retains tooling/routes, produces known
completion, permits the next exec, and cannot bypass stop intent. Wire relevant
cases into packed installed CLI qualification.

Run consumer shell/JSON checks and focused runtime tests inside its container.
Use the synthetic launch/session path and course navigation for functional proof;
health alone is not the learner journey. Run Linux process-helper checks in the
owned Linux environment. Reuse passing evidence for unchanged source. Run affected
repository-native checks, inspect diffs and secrets, commit coherent changes, obtain
the configured simplifier/risk review and integrated final review, then update the
existing draft package or coherent consumer draft as appropriate.

After the final runtime-dependent check, use exact-path `devrouter stop` and verify
provider stopped plus zero exact routes. Retain checkout, volumes and synthetic
records. Record source/package/provider versions, durations, checks and gaps without
credential values. Continue the active goal into controller observation, admission,
bounded recovery and harness qualification only through their reviewed scopes.

## Progress

The trusted planner approved the frozen execution draft in round 3 with no
remaining findings. Review provenance is in the local reviews directory. The
existing lifecycle package remains draft PR #58. No eLearning runtime has started.

The current readiness source passes typecheck, formatting, docs checks, build,
package smoke and focused tests. All 25 installed synthetic lifecycle scenarios
pass on Node 24.16.0 and pnpm 11.6.0. The new scenario proves that a failed declared
health contract retains managed infrastructure, records a definite nonzero
completion and permits the next exec without stopping. It found and drove a fix
for a deadline iteration erasing the last observed HTTP status. Real curl tests
also pass for media types, redirects, literal paths and stalled responses.
Receipt source is a dirty task tree based on db893a3, not a clean release.
Artifacts: /private/tmp/devrouter-readiness-installed-lifecycle-final.log and
qualify-lifecycle-u1bzuf. Tarball SHA-256:
7e31c51b715cf1c6bf1dabec223a94c411efe3f47eeccdfde053ab2de4b3dc53.
Live-provider and OOM qualification remain false.

Consumer commit e47a0fed preserves the warm dev cache and uses canonical exec for
explicit content seeding. Main has removed automatic content seeding from
post-create, added a preparation lock/stamp, and guarded app startup with actual
6 GiB cgroup proof and profile selection. These consumer edits have shell syntax
and diff checks only; runtime qualification and complete warm preparation remain
pending. Executor Kant owns .devrouter.yml and docker-compose.yml for the bounded
readiness/profile/resource/volume subset (agent 01a07ba3-f023-7520-9730-e0859f2c7885).

Next finish consumer preparation identity/invocation and synthetic fixture guards,
verify the executor result, and qualify the exact tooling runtime before starting
the app. Required committed-slice and final reviews, consumer tests, Linux helper
proof, real learner journey, warm preservation and final stopped-state proof remain
outstanding. No consumer branch publication, merge or release has occurred.

## Additional consumer regressions to qualify

A coordinating CI task reported the following on installed 0.0.55, Klicker
worktree trees/rs/playwright-activity-retry-safety at 29965a153f. These are supplied
observations, not independently reproduced here. The runtime was stopped and must
not be started or mutated by this qualification task. eLearning remains the canary.

- Root readiness passed but two synthetic dynamic quiz cockpit navigations failed
  with PageNotFoundError/ENOENT despite the source page existing. Require dynamic
  route navigation in the real learner journey, beyond the health endpoint.
- Warm stop/resume preparation completed a cached build but the process helper
  rejected surviving children. Existing Linux helper tests cover deliberate
  surviving-child rejection and cleanup (test-devrouter-process.sh), not whether
  legitimate build-tool descendants cause false rejection. Establish exact child
  ownership and termination behavior before changing this guard.
- Exact stop reported stopped and zero routes, but status retained a degraded
  failed-transition marker. Source confirms managed-runtime-status.ts currently
  prioritizes a degraded historical transition over stopped status. Qualify both
  present workload state and retained incident history without conflating them.
- The reported Playwright wrapper calls ensure without a profile and expands a
  narrower selection to full. The wrapper remains owned by the coordinating task;
  qualify explicit profile preservation and generic implicit-profile semantics
  separately. Do not patch or start that consumer from this task.

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

### Current checkpoint, 2026-09-07

The retained Devsy stop correction removes the live-versus-current Compose service
hash comparison from shutdown. Exact ownership, profile, source/generated Dev
Container identity, service population, source mount and repeated container
identity checks remain. This specifically permits unapplied Compose service edits;
it does not yet make stop independent of removed profiles or edited Dev Container
JSON. Main owns this narrow correction because the shutdown proof is tightly
coupled. The focused retained-stop suite passes all 43 tests, including the changed
hash case and existing foreign/replaced-container and mount-change cases.

Review-correction dogfood found that installed canonical stop rejects an
unactivated Compose volume declaration with `Managed Compose configuration
changed for service 'app'`. Main temporarily removed only its own three-line
preparation-volume declaration, stopped the original runtime canonically, and
restored the source declaration. Exact source-path registration, provider Stopped
and zero routes were then verified. No raw provider mutation or data deletion
occurred. Configuration-independent retained stop is an additional prerequisite
for safe generated Compose changes. Receipts:
/private/tmp/elearning-review-correction-final-stop.log and
/private/tmp/elearning-review-correction-stop-restored-config.log.

The new fixture verifier successfully waited for a test-owned preparation lock
and then verified the original records. Its PostgreSQL transaction capability is
runtime checked and current typecheck passes. Crash recovery and pending-state
qualification remain outstanding; consumer corrections remain uncommitted.

Consumer risk review returned four accepted findings: malformed nonempty public
hashes, container-local fixture ownership, concurrent/uncertain fixture
publication, and preparation reuse without backing-database readiness. Source
corrections are active in the existing eLearning worktree. Shared browser-safe
hash validation passes 60 focused tests. Fixture locking verifies the existing
owned records and current typecheck passes; transaction locking, durable pending
publication and persistent state still require failure-case qualification.
Do not activate the new preparation volume over the existing manifest before
explicitly preserving and verifying that state. No database reset or fixture
replay is authorized. The database-state helper remains owned by Hume,
01a07c10-1f81-70e1-b0fe-1a3e166208e6.

The user-approved Klicker dependency handoff adds a Devrouter source prerequisite:
an explicit repository generator before authoritative Compose inspection on
fresh/warm ensure. Klicker generator and runtime remain owned by the source task.
Newton reviewed proposed managedRuntime.devcontainer.prepareCommand literal argv,
checkout-root cwd, fixed 60-second bound, lifecycle serialization and immutable
.devrouter.yml authority. Diagnostics remain read-only. Current code confirms
Compose inspection precedes provider initializeCommand. Hook execution and safe
warm resource reconciliation are not implemented or released. The broader
runtime/volume activation authority is unchanged by this source handoff.

Follow-up browser qualification uses the already cached agent-browser 0.36.0 and
an isolated Chrome session. The browser received the real student-session cookie
from a short-lived synthetic launch token, with values kept out of transcripts
and files. The session endpoint subsequently displayed Unauthorized; cookie
metadata proved issuance, and direct authenticated navigation succeeded. The
initial redirect journey therefore remains a failed/ambiguous first attempt.
Do not claim a clean first-attempt browser launch flow.

The browser completed the synthetic block through its normal completion control.
The scoped learner progress query then proved one completed record. After exact
non-destructive stop/full resume, the record identity, creation time, modification
time and completion state were unchanged. Reloading the authenticated overview
still displayed completion. Receipts: /private/tmp/elearning-browser-progress-
{before,after,stop,resume}.log. The isolated browser was closed; final canonical
stop is recorded in /private/tmp/elearning-auth-browser-final-stop.log.
Final source-path registry resolution matched one provider ID. Devsy reports
Stopped and the final route readback contains zero exact canary routes.

The stopped-state correction is committed at 40104c5, followed by the reviewed
two-line simplification bcf9516. Its 25 installed synthetic lifecycle cases pass
on clean source 40104c5, Node 24.16.0 and pnpm 11.6.0; the tarball digest is
1e033187b3f6e0041c0da99dd32aba2bdffc96c160e1e87525109d39f8849463.
All 15 focused status tests pass after simplification. The full suite and package
evidence remain applicable to the behavior-preserving deletion. Risk review is
still active; no integrated-final review or publication is claimed.

The consumer source is committed at d3ebf87797bbf021c95008db8c302e6f819a33c4.
Full typecheck and 627 tests pass (one test skips). Godel's independent
simplifier completed with no justified changes; the trusted native consumer
risk reviewer remains active. Earlier paragraphs below are chronological
evidence, including failures subsequently corrected.

A fresh installed-tool cycle resumed the exact canary in tooling mode without
recreation. Changed migration inputs invalidated the preparation stamp;
preparation completed and retained the synthetic fixture. The next unchanged
preparation reused its stamp. Full ensure then returned HTTP 200 application
readiness, reused the same container, and started the managed app successfully.
The surviving-child incident reported from another consumer did not reproduce;
the existing ownership guard remains unchanged.

The first session-check invocation referenced a nonexistent container script.
The corrected invocation passed the verified host script through canonical exec;
launch/session exchange, session identity and the authenticated dynamic unit all
passed. Both outcomes remain recorded. No browser authentication or progress
persistence proof is implied by this HTTP journey.

Canonical stop freed both canary routes. Exact-path provider registration matched
only rs-reliability-canary; Devsy workspace status reports Stopped and the exact
route count is zero. Source, volumes, preparation cache and synthetic records are
retained. Receipts: /private/tmp/elearning-readiness-followup-{ensure,preparation,
warm,full,session,session-rerun,stop}.log and the corresponding routes.json.

The stopped-state reporting correction gives positively stopped resources
precedence over an old degraded transition while retaining incident metadata.
Active resources, unavailable inspection and ownership conflicts remain
non-stopped. All 1,097 unit tests, typecheck, formatting, docs policy, knowledge
and Knip pass. Linux process tests skip on macOS; earlier exact-container checks
remain the relevant helper evidence. This correction still requires its committed
review and package qualification. Controller, admission, OOM and harness work
remain incomplete under the active roadmap goal.

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

## First live canary evidence

Devrouter readiness slice committed at ce3b002aaf5ec31433d8d535568d54d708b611ed.
All 1,090 unit tests pass; 210 Opengrep rules on six changed implementation files
found zero issues. Simplifier Descartes found no justified net reduction. Slice
reviewer Tesla (01a07bac-3f40-7a70-8f13-db4b1e1053b7) remains active.

The installed package started Devsy workspace rs-reliability-canary, Compose project
default-rs-101ce. Exact app container 00cdd3063ce928675d8cad9613a779676f8f67c26a7d7fda4bafe34a141b3972
is bind-mounted to the canary source. Actual limits: app 6442450944 bytes, PostgreSQL
536870912, Azurite 268435456, each with equal memory-plus-swap; all OOM flags false.

Cold post-create failed on content migration 20260826_090000, which assumes an
existing technical-information page. Canonical exec initially blocked on incomplete
lifecycle state. Ordinary tooling ensure recovered the exact runtime without
recreation and made exec available, but did not complete post-create. Explicit
canonical preparation revealed the deterministic migration error. The isolated
consumer fix preserves schema preparation and skips content repair only when both
courses and course-pages are empty. Existing-content checks are unchanged. No
database reset, content seed, new migration, or volume deletion occurred. Migrations
then completed, the preparation stamp was written, and unchanged warm preparation
reused it. Removed automatic migration retries and added values-free phase errors.

The full profile then passed application readiness with the app running and base
services healthy. Linux process-helper reconciliation tests passed in this exact
container, including preparation ordering, cancellation and surviving-child cleanup.
Real learner fixtures and dynamic-route browser validation remain outstanding.
Provider startup could report success after failed post-create without rerunning
that preparation: the canary adapter now makes app preparation explicit and keyed.
Evidence logs are /private/tmp/elearning-canary-*.log and
/private/tmp/elearning-linux-helper.log. A bounded warm ensure plus two stop/resume
cycles is running (session 69926), ending with exact non-destructive stop. Verify
its result and final provider/route state before claiming lifecycle completion.

### Warm-cycle and source hygiene checkpoint

Session 69926 proved warm full ensure (85.8 seconds), first non-destructive stop
(23.6 seconds), full resume (18.5 seconds), and second stop (26.0 seconds). Warm and
resume results report application HTTP 200 and recreated=false. The final resume
and stop remain running; the intermediate Stopped/zero-route observation is not
final lifecycle proof. Source typecheck/format and selected consumer tests remain
pending before consumer commit.

The runtime generated an unrelated payload-types.ts rewrite. It remains uncommitted
and must be excluded from this package. Automatic approval review rejected git
restore for that exact file because it lacked trusted evidence of ownership; do
not bypass the rejection. Preserve the file until ownership is established or the
user explicitly authorizes restoring it. No consumer source was reset.

### Completed bounded warm run

Session 69926 completed successfully. Second full resume took 22.0 seconds and
final stop 24.5 seconds. All three ensure results retained full, reported HTTP 200
application readiness and recreated=false. The receipt is
/private/tmp/elearning-canary-warm-receipt.json. Final provider and route verification
is session 70964. Preserve this evidence; do not rerun unchanged cycles merely for
a commit wrapper. Dynamic learner route, synthetic state preservation, preparation
transient-child diagnosis, stopped-vs-history reporting and capacity behavior remain
separate unqualified boundaries.

### Synthetic learner and verification correction

The explicit canary fixture was created transactionally after accepting the
single migration-owned technical-information bootstrap page. A values-free
verification confirmed original record identities and creation times before and
after an additional non-destructive stop/full-resume cycle. The full resume
reported HTTP 200 and recreated=false. Receipts are
/private/tmp/elearning-canary-fixture-created.log,
/private/tmp/elearning-canary-fixture-after-resume.log and
/private/tmp/elearning-canary-post-fixture-resume.log.

The synthetic launch/session exchange, signed session identity and authenticated
dynamic unit request passed inside the exact container; no signing values or
tokens were emitted. Receipt: /private/tmp/elearning-canary-session.log. The
in-app browser navigated from the unit overview to its synthetic learning block
and reloaded that block successfully after resume. agent-browser was unavailable
on PATH, so browser proof used the native browser fallback. This does not claim
an authenticated browser cookie flow or learner progress persistence.

Tesla completed the readiness slice review with two concerns. The application
readiness failure in legacy live verification incorrectly removed published
routes. The scoped correction retains routes on declared readiness failures,
including transport failure, and preserves cleanup for legacy probe failures
and thrown infrastructure errors. Nine focused tests, 1,093 unit tests, static
checks, build and package smoke pass. The first full suite ran inside a sandbox
that blocked process identity inspection; the host-visible rerun passed. Linux
process tests skipped on macOS; the earlier exact-container Linux pass remains
the relevant helper evidence. Installed lifecycle evidence still belongs to the
previous packed source; package smoke does not replace its 25-scenario proof.

Final exact-path Devsy registration resolves uniquely to rs-reliability-canary.
Devsy reports Stopped and route output contains no exact source-path entries
after the final canonical stop. Checkout, volumes, cache and synthetic records
remain retained. Evidence: /private/tmp/elearning-canary-final-stop.log and
/private/tmp/elearning-canary-final-routes.json.

Remaining work includes consumer formatting/typecheck and review, the unrelated
generated payload-types ownership decision, authenticated browser/progress proof,
preparation transient-child diagnosis, stopped-vs-history reporting, and the
later controller/admission/recovery/harness stages. No OOM was induced, and no
capacity qualification, merge, release or deployment is claimed.

### Consumer hardening and generated-type diagnosis

The consumer canary verifier now checks the four owned record identities,
publication state, course/module/unit relationships, learner identity and route
consistency. It passed against the existing synthetic records. Focused formatting,
ESLint and preparation shell syntax checks pass. The owning devcontainer manual
now describes explicit content seeding, retained preparation/cache, bounded
profiles and memory, and the unreleased readiness dependency.

Executor Aquinas added four migration behavior tests. Main removed the obsolete
technical-info branch from the older schema-deferral test; its replacement proves
schema preparation before Local API access, empty-database early return, content
repair for either nonempty collection and propagated count failure. The first
test fixture lacked Payload collections configuration; the same-child correction
supplied it. All nine coupled tests pass in the exact tooling container.
Receipts: /private/tmp/elearning-consumer-final-regressions.log and
/private/tmp/elearning-consumer-final-focused-lint.log.

Full consumer typecheck fails with seven errors after startup regenerates
payload-types.ts. Installed Payload 3.74.0 starts generation asynchronously when
NODE_ENV is not production and typescript.autoGenerate is not false. Its
configToJSONSchema fieldIsRequired explicitly treats admin.condition fields as
optional; both affected source fields have admin conditions. This explains the
generated optional Course.urlHash and CoursePage.content declarations and the
downstream type errors. The generated file remains preserved and excluded from
task staging. Do not hide the failure by suppressing checks or restoring generated
types without resolving the source/type contract. Evidence:
/private/tmp/elearning-consumer-typecheck-format.log,
/private/tmp/elearning-type-generation-detail.log and
/private/tmp/elearning-consumer-focused-lint.log.

Fresh consumer fetch finds five commits on origin/main beyond the canary baseline,
including a technical-info utility/help migration fix. The task has one local
commit and no upstream; no integration was performed. Review the overlapping
utility change before an explicitly authorized integration. Consumer changes are
still uncommitted pending the type-contract resolution and package review.
Canonical tooling stop completed. Exact Devsy status reports Stopped and the
final route query reports zero entries with the canary's exact path prefix.
All runtime data and source changes remain retained.

### Consumer type contract resolved and committed

Consumer commit d3ebf87797bbf021c95008db8c302e6f819a33c4 includes retained
preparation, profiles, fixture qualification and the type-contract correction.
The generated declarations are intentionally included now: they match installed
Payload generation. Absent rich text is handled without dereference, and missing
public course hashes are rejected before export queue or import data operations.
No declarations were forced back to required fields and no type checks were
suppressed. The earlier restore rejection was respected; this is a source fix
with the existing generated artifact, not a destructive restore.

Full container typecheck passes. Full consumer tests report 627 passed, zero
failed and one skipped. Changed-file ESLint, formatting, shell syntax, staged
diff check and Gitleaks pass. The converter executor could not access the exact
worktree and made no changes; main implemented and tested that bounded fix.
Evidence: /private/tmp/elearning-type-contract-checks-final.log,
/private/tmp/elearning-type-contract-format-tests.log,
/private/tmp/elearning-full-consumer-tests.log and
/private/tmp/elearning-consumer-lint-final.log.

Consumer worktree is clean. Exact canary status is Stopped and route count is
zero after the final tooling stop. Independent simplifier and trusted native
slice-risk review are active on e47a0fed..d3ebf877. The generic risk-review route
preserves the internal-source boundary instead of sending it to an external
hosted provider. Publication and integrated final review remain outstanding,
alongside the broader recovery/capacity/harness qualification stages.

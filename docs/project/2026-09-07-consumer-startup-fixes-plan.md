# Consumer startup reliability fixes

Status: user-authorized implementation; integrated review and delivery pending.

Current verification: source commit 434e148 passes all 1123 tests and 25 installed
synthetic lifecycle scenarios. The latter used Node 26.8.1 and pnpm 11.6.0 and
explicitly does not qualify live providers or OOM behavior. Slice risk review
passes the entire committed range. Simplifier's optional result-type reduction
is deferred; the explicit outcome tags preserve already verified behavior.
Integrated final source review is active with Volta.

Release metadata prepares 0.0.58. Docs policy, knowledge, Biome, Knip, TypeScript,
AI prompt tests, build and isolated package smoke pass. Setup and doctor report
25 checks passing with no warnings/errors; repository inspection and routing
smoke pass. Routing example services are stopped; ls retains exited-container
metadata, which is not a running route. The legacy devcontainer smoke requires
the absent devpod executable; this machine uses Devsy. Live Devsy qualification
and release publication remain pending. No dependency graph changed.

## Outcome and authority

Unblock consumers that need a host generator before Compose inspection or need
to leave a degraded full profile for a smaller requested profile. The user
explicitly prioritized these fixes over the unfinished controller package.
Keep that package in its existing worktree. This package contains no controller,
capacity admission, paid infrastructure, shared VM restart, data deletion or
changes to consumer-owned runtimes.

Implement, test, review, commit and deliver a coherent source PR under existing
roadmap authority. Release readiness requires the repository release checklist;
source checks alone do not establish published availability or warm mount reuse.

Branch: rs/consumer-startup-fixes. Target: origin/main at
8406dd1e1e4a643431a7f389857d921441d737f4. Worktree:
trees/rs/consumer-startup-fixes. Existing source prerequisite contract is recorded
in the [eLearning canary plan](./2026-09-07-elearning-readiness-canary-plan.md).

## Changes and verification

The optional managedRuntime.devcontainer.prepareCommand is literal argv executed
on the host in the checkout root, once under lifecycle serialization before any
authoritative Compose inspection. Bound it to sixty seconds, cancel only its
owned process group, suppress raw output, and reject changes to .devrouter.yml.
Diagnostics remain read-only. The repository owns generated Compose inputs.
Generator invocation is distinct from applying changed mounts to a retained
container; prove that separately before advertising warm mount support.

For a degraded retained runtime and a different requested profile, validate the
existing exact owner, retained profile/configuration, container membership and
process ownership through the existing repair baseline. Then use the normal
profile transition for only requested resources. Do not start dropped processes
to prove ownership. Same-profile repair remains unchanged. A failed transition
restores generated configuration and cleans candidate resources without replaying
a known degraded baseline's adapter; retain degraded state and data. Preserve
manual stop fencing before provider or route mutation.

Main owns workspace-ensure integration, lifecycle regressions, documentation and
final proof because startup ordering and rollback share one boundary. Sagan owns
only the hook module, schema/types and their focused tests. No overlapping writer.

Acceptance: literal argv/cwd, bounded failure and configuration-authority tests;
hook before Compose and before provider actions on cold/warm ensure; a failing
retained-only process cannot block requested-profile startup; failed transition
does not replay it; stop fence and foreign ownership remain effective. Run affected
checks, full repository validation, package qualification and independent reviews.
Reuse unchanged evidence. Consumer runtime dogfood stays with its existing owner.

## Progress

Remote refreshed; isolated branch starts at current target. Main implemented direct
requested-profile recovery after retained ownership proof and conservative failure
cleanup. All 87 workspace lifecycle tests pass, including the dropped-process
regression. Hook implementation remains with the existing bounded executor.
Source review, complete qualification, PR and release remain pending.

Focused contract review requested three corrections, all accepted. Requested-profile
recovery now checks retained process status without starting it: running and stopped
are accepted, foreign/unknown ownership is rejected before mutation. Three regression
cases now fail service start, adapter execution or route publication and then retry
the requested profile successfully without replaying dropped processes. Candidate
cleanup failure remains degraded and must preserve exact evidence; no force cleanup,
data deletion or invented healthy baseline is allowed. Existing exact stop remains
the non-destructive fallback when the retained baseline cannot be proven.

Hook integration is once per top-level ensure under lifecycle serialization and a
stop-effect claim, before the outer retained-baseline inspection and ordinary
inspection. Failure or .devrouter.yml mutation ends the call before either inspection.
Current lifecycle suite passes 91 cases; docs policy and knowledge checks pass.

The same planner approved the corrected contract on its second pass. Hook ordering
integration tests are added for ordinary and degraded transitions and early failure;
their execution awaits the delegated module. This approval is not final source review.

Implementation is complete for host preparation and direct requested-profile
recovery. Main completed the hook cancellation correction and tests after the
executor handback. The hook signals its owned group only while the direct child
is live, with no delayed signal after reaping. Real-process fixture proves literal
argv/cwd, rejection and config preservation, and timeout cancellation of an
inherited child. Integration proves one invocation before ordinary/degraded
Compose inspection and rejection before provider actions.

Validation: all 1112 pre-correction suite tests pass on the host; sandbox failures
were process-birth permission errors. Final affected set passes 237 tests including
11 added hook/schema cases. TypeScript, Biome, Knip, docs policy, knowledge, build
and packed installation smoke pass. Linux process-helper tests skipped on macOS;
helper source is unchanged from the previously qualified 0.0.57 release. No live
consumer runtime or data changed. Independent source reviews and delivery remain.

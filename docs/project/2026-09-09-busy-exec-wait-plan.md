# Wait for healthy lifecycle work before tooling execution

Status: approved user scope; planner-approved implementation contract.
Target: main at 4012dc9. Branch: rs/busy-exec-wait.

## Outcome and authority

Canonical exec waits for an existing healthy command instead of instructing agents
to stop it. Preserve the running command, exact identity, data and uncertain results.
The user approved this source package, isolated tests, reviews and draft delivery.
No consumer runtime mutation, restart, data deletion or new machine policy is included.
Thirty minutes is the bounded default, matching existing provider contention waits.
There is no persistent queue, parallel execution, FIFO guarantee or automatic replay.

## Implementation

Generate invocation IDs and copy arguments once. Wait asynchronously outside all
journal, provider and workspace locks. Keep the original intent fence throughout
waiting; any later change vetoes dispatch, including stop followed by ensure.
Report throttled stderr progress with operation identity, never command arguments.
Timeout and cancellation before dispatch launch no command and leave prior work alone.

Close the existing admission/registration gap: admit a non-stop operation together
with proven ready-worker registration and dispatch in one journal transaction.
Keep durable dispatch-persisted acknowledgement before IPC launch. Stop persists
intent immediately. Fresh runtime and retained-exec proof precede final admission;
recheck fence, cancellation and snapshot in the transaction. A competing winner
causes bounded re-admission with the same IDs, never command replay. Dispose of
undispatched helpers before retry; bound readiness and cleanup. Preserve legacy
uncertainty handling and reject unavailable process identity or surviving orphans.

## Ownership and acceptance

Main owns lifecycle decisions, integration, review and delivery. The existing explore
worker maps regression seams. Bounded implementation may be delegated after these
seams settle; helpers/tests have disjoint ownership from main's docs and qualification.
Critical-path coupling retains admission decisions in main.

Protect overlapping commands, pre-registration races, once-only argv delivery,
unknown outcomes, PID reuse, stop/resume fencing, SIGINT/SIGTERM, timeout, proof drift
and listener/helper cleanup. Reuse existing model/store regressions. Verify focused
Vitest suites, repository checks, full tests, build/package smoke and a packed CLI
synthetic overlap fixture. No live provider or OOM acceptance is claimed.

## Review and progress

Planner Harvey approves the above contract. Main accepts its registration-race and
fixed-fence requirements. Scoped simplification, lifecycle risk review and integrated
final review follow committed implementation. Complete one reviewed CI-green draft
PR; required review or unresolved dispatch ambiguity is a capability boundary.

The optional AGY opposing-provider challenge could not read files in headless mode
and returned no review. No permission/configuration workaround was attempted.
Native planner approval remains the required planning evidence. Executor Locke returned a blocked partial implementation and transferred ownership
to main. Main owns the remaining implementation, focused tests, packed fixture
and affected manual. Explorer Ohm maps remaining regression seams.

## Progress

The baseline packed regression reproduced the active-worker rejection. Main completed
atomic admission and asynchronous waiting after the executor returned a partial patch.
The advisor initially hit a session limit and was retried after its stated reset time;
that same consultation is still running. No reset credit or configuration change occurred.

Focused verification passes 35 tests covering waiting without journal mutation, copied
argv, fresh proof, timeout, signals, stop fencing, admission contention, uncertain birth,
history rollover, dispatch durability and undispatched-helper cleanup. The full suite
passed 1308 tests before the last five focused regressions and helper-close guard.
Linux-only process-helper tests are skipped on macOS and remain a CI requirement.
Formatting, typechecking, unused-code, documentation policy and knowledge checks pass.

The packed synthetic qualification passes overlapping exec, both exit codes, one launch
per command, waiter cancellation, stop fencing and existing lifecycle failure cases.
The package-install smoke passes. This evidence used the development tree before the
final helper-close guard; a committed qualification will verify the review range.
No live consumer runtime was touched. Required slice and final reviews, CI and draft
PR delivery remain open. The roadmap goal stays active beyond this source package.

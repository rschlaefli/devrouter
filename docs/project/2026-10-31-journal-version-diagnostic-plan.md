# Actionable newer-writer journal refusals

## Approval summary

A valid lifecycle record written by a newer CLI is currently reported as an
invalid journal during global enumeration. Capacity diagnostics then recommend
restoring history. The actual prerequisite is a compatible CLI. Preserve the
existing refusal and every journal byte while carrying that specific cause
through direct reads, enumeration and capacity diagnostics.

This is a bounded diagnostic correction under the user's 2026-10-31 instruction
to proceed with the reliability roadmap. It does not select a mixed-version
rollout policy or implement retained maintenance. All clients still refuse
records written by a newer version; no partial enumeration or admission bypass
is introduced. Unknown/corrupt history retains its existing classification.

Main owns the source, native checks, review and ordinary draft delivery on
`rs/journal-version-diagnostic`, targeting `main` at `d2fba69e`. Terminal: a reviewed
correction with passing exact-head CI in a draft PR. Ready, merge, publishing,
installation, runtime and consumer data effects are outside this batch.

## Execution details

### Evidence and scope

`reliability-operation-store.ts` already rejects newer `writtenByVersion` values.
Its enumeration catch discards that message and emits `journal-invalid`.
`createLifecycleCapacityStore` transports the cause and bounded entry location;
`doctor.ts` maps the generic invalid-history cause to restore-history advice.
The current knowledge contract already promises an upgrade instruction.

Use the existing `ReliabilityJournalError` for the known newer-writer refusal,
with a distinct `journal-writer-newer` cause and the sanitized entry basename.
Extend the existing capacity cause type and doctor suggestion map. Use fixed
values-free diagnostic text; arbitrary record values must not enter output.
The current writer comparison, validation order, identity checks and fail-closed
capacity behavior remain intact.

Affected implementation files are `src/core/reliability-operation-store.ts`,
`src/core/capacity-store.ts` and `src/core/doctor.ts`. Extend existing store and
doctor tests. The knowledge concept already describes the intended behavior;
no new manual, ADR, module, dependency, public command or persistent schema is
needed. ADR review would rearm for any admission or version-policy change.

### Verification and sequence

| Risk | Existing protection | Obligation and seam |
| --- | --- | --- |
| Newer journals become absent/partial history or are rewritten | Store version and capacity refusal tests | Extend store coverage: newer record plus valid neighbour, direct read/update/list/capacity refusal, exact cause/location and unchanged bytes; denied update callback. |
| Corrupt records get misleading version advice or leak contents | Bounded/private reader and corrupt-history tests | Reuse corruption/privacy coverage; include malformed writer metadata in focused checks. |
| Capacity diagnostics still suggest repairing valid history | Doctor cause mapping tests | Extend structured details coverage for the new cause. Review the mapped action without pinning prose. |

First reproduce the missing cause with the new regression. Apply the smallest
correction, run focused suites plus native formatting, types, unused-code,
documentation, build/package checks, and inspect all hunks. Use a bounded
independent final review of the exact committed change because classification
feeds capacity safety guidance. There is no runtime-dependent acceptance here.
A native test failure is corrected locally; a material admission/ownership
change returns the decision rather than expanding scope.

The package is floor-exempt because it fixes an actionable agent-blocking
misdiagnosis. One implementation commit includes its plan. One draft PR owns
exact-head CI; the existing roadmap PR records this independent delivery.

### Authority and unresolved work

Human authority is the current direct continuation instruction after the
roadmap closeout; its exact locator was independently recovered in the private
task evidence.
Ordinary implementation branch commits, non-force pushes and draft delivery
follow repository standing authority. Maintenance compatibility/adoption policy
and the consumer-owned readiness probe remain separately unresolved.

## Progress

Root outcome: ordinary agents receive a bounded, correct next action instead of
misdiagnosis. Current batch terminal is reviewed diagnostic source and passing
CI in a draft PR; it does not close consumer recovery. The first useful result
was the reproduced newer-writer enumeration/capacity regression.
The independent Gemini 3.8 Flash high plan critique approved the bounded
contract from the supplied complete source packet. Claude returned a terminal
process failure without a review; the native planner launch encountered the
recorded configured-model mismatch. AGY catalog refresh succeeded and its
completed opinion is the applicable critique. Requested selector is known;
backend provider identity is not independently exposed.

Main accepted the privacy, classification and immutability constraints.
Keep the existing version comparison and validation order: the advisory request
for stricter version formatting would change admission beyond this correction.
Malformed non-string writer metadata remains invalid and has native coverage.
No product primitive, persistent schema or compatibility policy changes.

Baseline native store/doctor suites pass 138 tests. The new classification
regression failed before correction, then the corrected suites pass 142 tests.
Types, docs policy and knowledge checks pass on Node 24.16.0/pnpm 11.6.0.
The sandbox denied process inspection; the permitted host context passes without
weakening file-lock checks. Full native tests pass 3,520 tests with 13 platform
skips; the process helper
suite skips Linux-only /proc checks on this host. Formatting/lint and Knip pass.
The focused Opengrep scan reports zero findings across the three changed source
files. Build and isolated package smoke pass; independent final review remains.
No runtime or provider command is required.

Native task binding still rejects the contained worktree plan. Actual user
turn/message authority was read from the current task; no hook/client
configuration was changed. Native goal inspection returns none; host requires
explicit goal creation authority, so no replacement goal was created.

Remote refs were refreshed and main is the resolved target. This branch begins
at d2fba69e and changes 69 added/7 removed substantive lines before final review,
excluding this plan. Main owns every changed path. Remaining maintenance
compatibility and consumer-probe decisions are pending separately; this fix
cannot close those consumer blockers.

# Partial container replacement recovery

Status: source complete; independent review, live qualification and hosted checks pending.

## Goal and authority

Repair explicit managed stop recovery when a provider replaces the primary container and retains unchanged dependencies. The user approved this targeted repair after the existing all-containers-absent guard blocked local application validation. Preserve ordinary stop behavior, ownership and configuration proof, volumes and data. No container deletion, reset, global tool installation, merge or package release.

Main owns source and integration. The exact base is origin/main at 386937c19eb776bfbd1fa9317061aec7cba61ebf. Use the isolated fix/control-partial-recovery branch. The dependent application stack remains under its separate existing plan; this repair does not authorize its merge or deployment.

## Implementation and acceptance

Extend src/core/managed-stop-recovery.ts only at its replacement observation: compare any retained original ID with its complete recorded immutable identity, then prove absent only the missing original IDs. Keep complete service population, source/configuration, daemon, provider registration, runner, checkout mount and repeated observation checks. An unchanged population needs no absence call. Recovery remains explicit and publishes a degraded baseline before normal pinned stop.

Extend the existing managed-stop-recovery suite for partial replacement success, changed retained service/config files/mounts, retained identity drift between observations and the fully retained population. Existing full replacement, foreign membership, incomplete evidence and authority failure cases remain mandatory. No new runtime test fixture or production module.

The independent planner approved this design. Run focused recovery/lifecycle/baseline tests, formatter, typecheck, unused-code and documentation checks, then build. An independent implementation review covers correctness, ownership/security, maintainability and plan compliance. Use the isolated built CLI for the already-approved exact application-runtime recovery; do not globally replace the user's tools. Retain local and hosted checks as distinct evidence.

## Progress

Reproduced two failures against the original implementation. Partial replacement wrongly requires absence of a dependency that is still present; a fully retained population unnecessarily invokes absence proof. The focused suites pass 214 tests. The full suite passes 3,363 tests with 13 explicit skips; Linux process tests are unavailable on macOS. Documentation policy, knowledge links, formatter, unused-code, types and build pass on Node 24. Runtime qualification, independent implementation review and normal source delivery remain pending. The existing tool primary checkout and other worktrees remain untouched.

## Startup persistence correction

Live recovery accepted the exact partial population, then the dependent startup exposed an existing persistence mismatch after all applications and workers reached readiness. A capture without host port declarations stored an explicit undefined optional key in memory. JSON persistence omitted that key, so the strict generation comparison rejected its own saved state. The existing workspace-ensure test now models JSON round-trip before the generation check and reproduced the failure. Omit that absent optional field at capture; preserve strict comparison and all generation fencing. This adds only src/core/workspace-ensure.ts and its existing test to the repair scope. Use the same independent reviewer for one focused verification of the correction before the next live attempt.

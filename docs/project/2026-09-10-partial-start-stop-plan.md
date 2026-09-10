# Recover a managed workspace after failed initial startup

User-authorized repair of devrouter and the affected Klicker task runtime.
Branch: rs/partial-start-stop. Base: b5fdb036bfb0d3235076718e9ff649a01064623b.

## Outcome

Canonical stop must stop only a fully ownership-proven partial startup population,
retain containers and volumes, and complete its normal journal/route proof.
The journal settle CLI must route its nested command and exact checkout correctly.
No manual lifecycle state edits, registration deletion or raw operator cleanup.

## Execution

1. Correct journal subcommand registration and exercise the actual CLI parser.
2. Review the no-retained-state stop path before implementation. Reuse exact
   provider identity, complete Compose population, source mount, configuration,
   stable container identities and existing effect/locking primitives. Refuse
   unknown, mixed or changing evidence. Never repurpose a capacity witness as
   permission to stop containers.
3. Add focused synthetic regressions and run typecheck/build. Review the complete
   correction before live use. Prove canonical stop on the affected checkout,
   then startup with a supported collision-free Blob port and final stop.
4. Publish the reviewed task branch as a draft PR; no release or target merge.

## Progress

Published 0.0.67 installed through Volta. CLI nested registration fixed locally;
64 existing/new focused journal and retained-stop tests pass. Typecheck and build
pass. Live corrected settle reaches its handler and returns already-settled;
this is not workload-stop proof. Planner reviewing the partial-start ownership
boundary. No partial-start cleanup code implemented yet.

Planner GLM 5.3 Flash approved the correction. Main strengthened the proposed
label-only fallback with existing complete Compose membership, source mount and
provider feature-file proof. No state is fabricated or persisted for the initial
population. Scope remains two executable files plus focused tests. Main retained
implementation because ownership decisions and live recovery were tightly coupled.

67 focused tests, typecheck and build pass. Patched canonical stop completed;
Docker reports zero running task containers and routes remain absent. Devsy still
reports Busy for the never-started primary. Ensure passed lifecycle admission
and is testing startup on a free task-specific Blob port. This is not yet full
provider recovery proof.

# Recover initial managed stop after completed commands

## Approval summary

The user requested a non-destructive repair of the course-image runtime blocker, followed by source delivery and E2E testing, stopping before merges. Initial startup failed before managed runtime state was published. Later successful exec commands replaced the current operation, preventing stop from recovering the original ensure profile. Recover that profile from existing history without rewriting history, loosening resource ownership proof, deleting data, or installing a global CLI replacement.

Use the latest ensure only when it is drained and terminal. Require unique history IDs, exact current-operation agreement, and only completed drained same-profile exec entries after that ensure. Preserve all existing container/configuration/daemon/registration checks around every stop. Reject missing, conflicting, running or ambiguous evidence. No schema, journal-format, model/provider, route-exposure or product-primitive change.

## Execution and acceptance

Main session owns two source/test paths and the existing lifecycle knowledge page. Reproduce failed stop after exec, retain negative cases for ambiguous or incomplete history, run focused lifecycle tests/types/build, then independent source review before live effects. Use the exact built task-local CLI to stop the identified runtime and verify unchanged container mounts plus stopped state. Keep the global installation unchanged. Preserve all databases/volumes; no raw Docker lifecycle or manual journal rewrite.

Source delivery is an ordinary task branch and draft PR in the existing Devrouter remote; no merge or release. The repair unblocks the separate Klicker candidate. If exact runtime/configuration evidence is inadequate, record the failed guard and perform no destructive fallback. This package does not authorize fresh initialization of retained data.

## Progress

Based on origin/main 03ca8db (0.6.9), isolated worktree trees/rs/course-image-stop-recovery. Three focused Node24 suites pass 217 tests; types, build, formatting, Knip and knowledge checks pass. Independent review accepted production logic and requested model-derived test histories; those are corrected and the focused review is pending. The source-only patch changes no persistent data format. Live candidate recovery remains pending.

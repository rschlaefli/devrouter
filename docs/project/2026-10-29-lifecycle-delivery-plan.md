# Deliver retained lifecycle recovery

## Approval summary

Agents need to start an exact environment, perform work, recover safely, and
stop or resume without losing data or disrupting a neighbour. This package
combines the existing persistence fix in [PR #163](https://github.com/rschlaefli/devrouter/pull/163)
and partial-population recovery fix in [PR #166](https://github.com/rschlaefli/devrouter/pull/166).
It then verifies a packed candidate through an ordinary two-environment journey.

Approval mode: **executable batch**. The user's “approved, go” accepts the
preceding big-picture proposal: reconcile those fixes while preserving owners,
close the installed CLI gap, and prove the complete workflow. Ordinary source
commits, task-branch publication and draft delivery follow repository policy.
Merge, marking ready, publishing a new release and deleting retained data need
their named delivery authority. The installed published release and unreleased
candidate are separate artifacts.

Recovery must preserve positive ownership, immutable identity, repeated
observations and absence proofs. An uncertain resource or live worker continues
to refuse effects. The package changes no schema, command or dependency.
Preview, storage cleanup, existing consumer environments and their owners remain
outside this package. Sleep continuity stays open and off this execution path.

Done means a reviewed draft candidate, passing required source checks and CI,
exact package provenance, and observed cold start, warm reuse, actual work,
failure recovery, stop/resume, retained data and neighbour isolation. Failed or
missing evidence remains open. Both synthetic environments finish stopped with
provider proof and zero exact routes; their checkouts and data remain retained.

## Execution details

### Source and ownership

- Main session is the sole integration writer in `trees/rs/lifecycle-delivery`,
  branch `rs/lifecycle-delivery`, target `main` at
  `de4ba1e41439c813d600d3640f8f22ed3e5f9de8`.
- Reuse PR #163 at `222d6acaf825bc6b23bf25bf472313078d0e47e8` and PR #166 at
  `c4ebd2a48efd6776c6ab7f909e5d0d3e161609d8`. Preserve original branches and
  consumer work. Integration is a union of their settled fixes.
- Both managed state builders omit an absent host-port digest. Recovery checks
  retained originals against their immutable identity, and requires positive
  absence only for missing originals. Existing complete population, config,
  provider, endpoint, daemon, runner, mount and repeated-observation checks stay
  binding. Ordinary stop retains its stricter contract.
- Extend only the existing `workspace-ensure` and `managed-stop-recovery` tests.
  Update the affected manual, knowledge concept and existing solution record
  from PR #166. This plan and an update to the existing reliability roadmap are
  the package's new execution record; no new production module or tracked
  qualification harness is required.

| Existing primitive | Integration effect | Preserved contract |
| --- | --- | --- |
| Managed runtime ownership and stop baseline | Correct persistence and explicit recovery of retained resources | Same owner, immutable evidence and fail-closed effects; no new primitive |

### Sequence and verification

1. Run the focused baseline, add the existing regression cases and observe them
   fail before applying source changes. Apply the two source fixes and reconcile
   their overlapping capture-state correction.
2. Run docs policy, knowledge, Biome, Knip, typecheck, full tests, build and packed
   distribution checks. Reuse unchanged component reviews; obtain an independent
   integrated review covering correctness, plan compliance, maintainability and
   focused ownership/security risks. No broader security assessment is implied.
3. Pack and install the candidate into a task-owned temporary prefix. Use its
   absolute CLI path and verify its digest around every invocation. Run two
   fresh example-based synthetic checkouts with unique `delivery-*` tokens,
   refusing existing matching routes or registrations before startup. Limit each
   app to 512 MiB and database to 256 MiB, with sequential startup. Verify actual
   TLS application responses and container work, warm identity retention,
   failure recovery, stop/resume data retention, and continued neighbour work.
   Canonical `ensure`, `exec` and `stop` own lifecycle mutations. Do not inject
   destructive Docker/provider faults. Stop each attempted fixture on failure
   and at completion; verify exact provider state and route removal.
4. Verify the published 0.6.0 registry integrity against the Volta installation,
   including CLI, worker and process helper. A version string alone cannot prove
   which candidate performed the qualification. Installation changes neither
   consumer pins nor controller configuration.
5. Publish one coherent draft integration PR with exact source, regression,
   package, review and live evidence. Reconcile the existing roadmap against
   those boundaries. Preserve unresolved sleep and broad acceptance gaps.

The test portfolio protects real persistence across ordinary ensure and repair,
partial replacement with unchanged dependencies, retained identity drift and
all existing refusal paths. Live proof uses only synthetic markers and fresh
local development fixtures. It does not establish recovery of an existing
consumer, full capacity/parking acceptance or universal agent reliability.
Raw observations and logs remain outside shared source. Temporary scripts and
fixtures live under `/private/tmp/dr-lifecycle-delivery-20261029/`.

## Progress

- Root outcome: dependable everyday agent lifecycle with safe recovery.
- Authorized terminal: verified draft candidate, current published CLI installed,
  isolated ordinary-workflow evidence, and reconciled roadmap status.
- First useful acceptance: regression failures on main, then passing same tests
  on the integrated source.
- Baseline: 245 tests passed. Existing regression cases reproduce three failures
  against main: persisted state mismatch, partial replacement refusal and an
  unnecessary absence check for a fully retained population.
- Independent plan critique: Gemini 3.8 Flash high, same-conversation completion
  after an initial incomplete CLI timeout. Review is packet-only. Absolute
  candidate paths plus digest guards address binary ambiguity; token preflight
  and temporary artifact isolation address operational findings. The no-port
  persistence regression and partial-recovery fixtures cover absent digests.
  Claude and native routes failed before useful review; no gate pass is inferred
  from their process state. Full report remains in ignored local reviews.
- Published 0.6.0 is installed through Volta; registry integrity and all three
  runtime artifact bytes match. Candidate source integration is complete; live
  proof, independent integrated review and hosted CI remain pending.
- Verification: all 252 focused tests pass after the reproduced failures. Docs
  policy, knowledge, Biome, Knip, typecheck, full suite (3,380 passing, 13 Linux
  skips), build and isolated packed-install smoke pass on pinned Node 24.
  Linux process-helper shell checks require hosted Linux CI. Substantive source
  and test delta: 161 lines; production change: 30 lines. Main-session inspection
  found no worthwhile additional abstraction or simplification.
- First full checks used host context after the sandbox blocked the package
  manager's lockfile location. No failed sandbox check is counted as a pass.
  The earlier native roadmap goal remains blocked; this conversational batch
  does not relabel that goal or grant a new release authority.

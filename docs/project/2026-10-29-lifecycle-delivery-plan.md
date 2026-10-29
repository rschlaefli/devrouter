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
  runtime artifact bytes match. It does not contain this unreleased candidate.
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
- [PR #167](https://github.com/rschlaefli/devrouter/pull/167) owns the combined
  candidate. Independent final review covers all nine paths at `04f5c62e` and
  passes with no findings. Scoped Opengrep reports no findings or errors. Hosted
  [CI run 40884580277](https://github.com/rschlaefli/devrouter/actions/runs/40884580277)
  passes on that head, including Linux process and installed synthetic checks.
- The packed candidate's live two-environment journey passes at `04f5c62e`:
  cold start, actual container work over real TLS routes, warm identity reuse,
  propagated one-time adapter failure, explicit repair, stop/resume, retained
  data and an unaffected neighbour. Final canonical stops and fresh source-path
  provider/route reads prove both fixtures stopped with zero exact routes.
  Retained data and checkouts were not deleted. Existing-consumer recovery,
  capacity/parking acceptance and short-suspend continuity remain open.
- The final roadmap reconciliation changes documentation only; unchanged source
  and package verification remain reusable. Terminal head and CI for that
  reconciliation are recorded in the draft and ignored evidence, without
  relabelling the live producer. This package remains draft and unreleased.

## Approved interrupted-provisioning extension

The pilot owner supplied a human-approved source package and explicit
coordination authority on 2026-10-29. Main retains this branch and the existing
stop-repair owners. The pilot owner verifies the returned candidate. This
extension authorizes implementation, regression tests, reviews, ordinary
task-branch publication and qualified draft delivery. It authorizes no
installation, merge, release, cleanup, database reset or pilot runtime attempt.

The outcome is an inspectable build that can be interrupted and subsequently
stopped through canonical ownership-proven recovery. An immutable generation
replacement is a reason for ordinary stop to refuse. Reuse explicit
`devrouter stop <checkout> --repair` and the existing positive absence,
retained-identity, complete-population and repeated-observation protection.
Diagnose which dimension differs before considering a rule change. Component
tests and synthetic provider proof never establish recovery of a real consumer.

### Primitive impact

| Product primitive | Disposition | Contract delta | Consumers and evidence |
| --- | --- | --- | --- |
| Managed ownership and explicit stop recovery | Reuse | No relaxation of ordinary stop or immutable authority | Existing replacement/refusal tests plus interrupted synthetic provisioning |
| Lifecycle operation and stage evidence | Extend | Read-only structured progress remains available during provisioning; unknown liveness and explicit deadline semantics | Managed status and existing operation projection |
| Bounded command output | Compose | Same output buffer supplies the original stream and an explicit private diagnostic tail | Worker supervision and `logs --repo`; raw output is absent from status and journals |

### Source sequence and acceptance

1. Compare the retained and observed generation with scoped read-only evidence.
   Preserve the pilot and its existing edits. Reproduce create/replacement,
   stalled build, cancellation and canonical stop/recovery with closed synthetic
   providers. Preserve the fixture's volume marker and exercise ambiguous,
   unrelated and swapped populations through the existing stop seams. Record
   real Docker/pilot acceptance as unqualified until its exact runtime/data
   authority exists.
2. Add `src/core/lifecycle-diagnostics.ts` and its focused
   `src/core/__tests__/lifecycle-diagnostics.test.ts`. Three concrete callers
   justify the module: lifecycle supervision, managed status and the existing
   logs handler. Store one bounded private artifact per exact environment under
   `~/.config/devrouter/lifecycle-diagnostics/`, separate from journal discovery.
   Bind it to operation ID, worker and intent/runtime/controller fence. Reads
   use journal/receipt/journal validation without acquiring mutation locks.
   Unsafe, unavailable or raced evidence yields unknown rather than effects.
3. Extend `reliability-worker.ts` and existing progress evidence to observe manual
   ensure output while preserving streaming. Reuse `LifecycleOutput`; retain at
   most 32 KiB of raw output in a same-user 0600 bounded artifact beneath a
   private directory. Coalesce writes behind one unreferenced throttle timer,
   flush stage/cancellation/terminal observations, and isolate all diagnostic
   failures from lifecycle results. Never persist arguments or environment.
   Parse bounded, ANSI-normalized actual package output conservatively; duplicate
   lines and phase heartbeats do not advance meaningful output progress.
4. Compose `projectLifecycleOperation` into managed status with structured
   elapsed/stage/output/progress evidence. Liveness stays unknown. The execution
   deadline is explicitly absent; report the existing worker-handshake and
   cancellation-grace limits separately. Cancellation and drainage come from
   the journal and existing process-group proof, never diagnostic timestamps.
   Extend `logs --repo <checkout>` to read the matching bounded latest ensure
   tail explicitly; default Traefik logs retain their current behavior. Snapshot
   mode rejects follow rather than introducing another watcher/controller.
5. Extend existing worker, progress, managed-status, logs and synthetic lifecycle
   qualification tests at these seams. Cover held-lock read access, split and
   oversized output, privacy, stale fences, failed diagnostic sinks and child
   drainage. Update `types.ts`, `cli.ts`, `output.ts`, the existing logs handler,
   bundled skill, AI prompt and owning lifecycle manual/knowledge as required
   by the added diagnostic surface. No new dependency, controller or registry.
   Run focused checks, required repository checks and independent integrated
   review. Publish the held candidate through the existing draft.

### Extension progress

- Baseline: held source `bc79ba59`, target `de4ba1e4`; remote default has no new
  changes. Prior component reviews and live ordinary-journey proof remain valid
  for their unchanged scope, not for this new interrupted-provisioning contract.
- Plan critique: Gemini 3.8 Flash high returned findings on race validation,
  filesystem bounds, timer cleanup, package parsing and drainage authority.
  Those protections are included above. The full schema-validated review and
  private pilot comparison remain in ignored local evidence. Public records
  contain only generic and synthetic facts.
- First useful acceptance: a stalled synthetic hook exposes meaningful progress
  and a bounded log tail while holding the lifecycle lock, then cancellation
  leaves an interrupted, drained operation that can reach canonical stop.
- Terminal: reviewed and checked draft candidate with exact source identity,
  producing regression evidence and explicit real-provider/pilot gaps. No
  cross-chat messaging is authorized by this delegated extension.
- The installed closed-provider qualifier passes the stalled-build journey with
  separate status/log readers while the lifecycle lock remains held. It verifies
  cancellation, child-tree drainage, interrupted operation retention and canonical
  stop with a retained synthetic backing marker. This is not a Docker named
  volume test or pilot recovery. A harness watcher initially watched the wrong
  directory; correcting its receipt path made that producing run pass.
- Focused diagnostics, worker, managed status, operation/repair and prompt tests:
  192 pass. The initial unconstrained full suite encountered two existing timing
  limits; `vitest run --maxWorkers=4` passes all 3,397 tests with 13 Linux skips.
  No timeout assertion or unrelated source is changed to hide that failure.
  Docs policy, knowledge, Biome, Knip, typecheck, build, packed distribution,
  scoped Opengrep and the installed synthetic lifecycle qualifier pass.
  Independent integrated review and correction verification passed. The exact
  delivered head `7ed4ac10` passed [CI](https://github.com/rschlaefli/devrouter/actions/runs/40903742837)
  with 3,412 tests. Its merge-ref tree matched that head; real-provider
  and consumer acceptance remain unqualified.
- Consumer impact was checked privately; its observations remain outside shared
  artifacts. An owner must prove current configuration provenance and ownership
  before a separately authorized recovery attempt. Component or synthetic checks
  cannot grant that authority or establish consumer recovery.

## Approved namespace-equivalence correction

The existing consumer owner requested one focused source correction after
read-only verification. The same draft and worktree retain ownership. This
executable batch covers source, synthetic regression tests, scoped independent
review, ordinary publication and exact-head CI. It excludes installation,
release, merge, consumer runtime attempts, reset, stop and cleanup. Return the
qualified candidate through the normal task result.

The configuration guard first preserves an already matching rendered service
hash. On a well-formed mismatch for `network_mode: service:<name>`, it can retry
only with the equivalent exact owned container namespace. Both services must
come from the caller-proven population with unique full immutable IDs, validated
project/source/config-file identity and the exact primary checkout mount. It
inspects only those IDs on the pinned endpoint, requires the sharing namespace
to name that exact target, changes only the service's namespace in memory, hashes
the complete service again, and revalidates the IDs and namespace afterward.
Existing provider, daemon, runner, complete-population, mount and lifecycle
proofs remain authoritative. Ordinary stop and explicit replacement repair
retain separate contracts. No product primitive or public command is added.

Implementation extends the existing guard and regression file, propagates the
known endpoint from the two stop callers, and updates the owning lifecycle
knowledge paragraph. No new module or dependency is needed. The first useful
acceptance is the reproduced false refusal becoming a pass while foreign,
missing, ambiguous or raced targets and genuine configuration drift still
refuse. Source bytes and non-namespace model fields remain unchanged. Real
Docker volume and consumer recovery acceptance remain with their runtime owner.

Correction progress:

- Baseline and upstream: `7ed4ac10`, clean and synchronized; main remains
  `de4ba1e4`, with zero target drift. The old positive namespace regression fails
  with the expected service configuration-change refusal.
- Independent plan critique passed against a generic source-only packet.
  Already matching hashes keep their original path for version compatibility.
- The guard has 36 passing tests; all 518 affected tests and typecheck pass.
  The full suite passes 3,418 tests with 13 Linux skips. Docs, knowledge, Biome,
  Knip, build, packed distribution and scoped Opengrep pass. The process-helper
  check skips locally because Linux `/proc` is unavailable; hosted CI covers it.
- The offline qualifier uses Docker Compose 5.5.0's actual render/hash commands
  and synthetic exact-ID inspection. It accepts the equivalent namespace,
  preserves source bytes, and refuses a changed image. It accesses no daemon
  and provides no live-provider proof. An initial fixture lacked a Git ignore
  check; initializing its synthetic repository corrected the fixture.
- The correction adds approximately 350 substantive lines across the existing
  guard, its two pinned-endpoint callers and their regression files. It remains
  in the already-approved draft. Scoped implementation review and final CI are
  pending on the complete candidate; earlier review covers unchanged paths.
- Terminal: the same qualified draft with held SHA and producing evidence.
  A matching hash is configuration evidence, never permission for a runtime
  effect or proof of consumer recovery.


## Approved live acceptance and patch delivery

The user approved the recommended conditional sequence on 2026-10-29: run a
real-Docker acceptance on disposable environments; if it passes, mark
[PR #167](https://github.com/rschlaefli/devrouter/pull/167) ready, merge to main,
publish the next patch and install it globally with artifact verification.
Consumer recovery stays with its existing owner. This batch supersedes the
source-only restriction for these named delivery effects only; consumer data,
other workspaces, tooling configuration and destructive cleanup remain excluded.

Prepare 0.6.1 release metadata before qualification so the producing package is
the intended release candidate. Reuse the reviewed executable source at
`1327256a`; release metadata has no new product contract. Create fresh synthetic
fixtures in a new task-owned temporary directory with unique route/provider
identities and bounded memory. Retain a named-volume marker and a functioning
neighbour. Exercise a canonical ensure held in an adapter build, read diagnostics
while its lock is held, cancel and prove drainage. Exercise an ownership-locked
provider recreation interrupted during post-create, without volume deletion;
ordinary stop must refuse replacement while explicit stop repair proves the
exact namespace and complete population. Resume, verify actual work and retained
data, then canonically stop both fixtures and prove provider stopped plus zero
exact routes. All test source, markers and receipts are synthetic and private.

A failed acceptance blocks merge/publication/installation while in-scope diagnosis
and source correction continue. Never bypass an ownership refusal. Passing source
checks, exact-head CI and reusable independent reviews remain required. Preserve
fixture data and source checkouts; deletion is outside this batch. Release through
the repository's release-triggered workflow, verify its exact merged tree and npm
integrity, then install through the existing global manager and compare CLI,
worker and helper bytes. Terminal evidence belongs in the draft and ignored
records, with no receipt-only tracked commit after checks finish.

# Reliability contract foundation and continuous qualification

## Approval summary
Status: approved source-only execution package; implementation in progress.

Deliver one shared deterministic reliability contract before changing live lifecycle behavior. It will represent consumer intent, readiness freshness, incident budgets, and uncertain command completion. The immediate benefit is executable acceptance criteria that later lifecycle, admission, and harness changes must satisfy.

The first package is source-only. Existing ensure, stop, exec, JSON outputs, ownership records, router recovery, and provider behavior remain unchanged. No controller is installed and no consumer repository is edited. Persistent journaling and admission enforcement follow in later packages. The main risks are a model that diverges from actual lifecycle operations and a misleading implication that passing model tests proves live reliability. Later adapters must consume the model; all receipts label their test layer.

Approval permits a dedicated local branch/worktree from the verified main baseline, the scoped implementation and documentation, repository-native checks, required independent reviews, and local commits. It does not permit upstream integration, push, merge, release, machine enrollment, runtime fault injection, or consumer activation. Terminal: reviewed local contract foundation with passing applicable checks and explicit live-proof gaps. This is not completion of the overall reliability goal.

## Execution details

### Baseline and ownership
Repository: /Users/rschlae/Git/personal/devrouter.
Current source baseline: e8f7549cbc2206604e997c0f07d836c390f302c2, confirmed by gh API on 2026-09-06.
Existing planning worktree: trees/rs/local-environment-reliability-roadmap at 8fedc5caaf28c815f8e78e17e687f0c6bb5d24d7, clean before preparation.
The expanded user draft is untracked in the primary checkout; preserve it. Frozen input: docs/project/_local/reviews/2026-09-06-reliability-roadmap-input.md.
Git fetch initially failed because Git metadata was read-only in the sandbox. Escalated fetch succeeded after the permission configuration changed.
Implementation worktree: trees/rs/reliability-contract-foundation, branch rs/reliability-contract-foundation, created from the verified baseline after approval.
PR #56 owns reset-failure recovery and remains open at 71aa5a8d33ea8966c76705e41273cb7d3d384b5e. This package does not edit its lifecycle files or require its merge.
Authority: review, preparation, local implementation, repository-native checks, required reviews, and local commits are approved. External and runtime effects remain outside this package.
Boundary owner: self. Pause at unavailable required tooling, changed public/lifecycle behavior, or named external effects.

### Binding design choices
Use orthogonal intent, phase, observations, admission, consumers, and execution-result dimensions. Consumer summary is derived, never an independent state authority.
Use pure deterministic transitions with supplied clock, epoch, identities, and observations; return effect requests but never execute them.
Duplicate request keys join the same operation. Conflicting reuse fails. Old intent/runtime/controller generations cannot publish readiness.
Explicit stop advances intent before teardown. Reattachment cannot override it; an explicit new start must carry a new authorized intent.
Compatible consumers share a profile; conflicting profiles fail without contraction. Releasing a consumer differs from cancellation, command interruption, and environment stop. Human pins veto automatic parking.
Parking completes only after positive owned-resource and route-stop proof. Unknown or partial stop retains charges and unavailable state.
Later adapters persist a dispatch-attempt record and confirm persistence before launch. A persisted attempt without authoritative completion is possibly dispatched, even without launch acknowledgement; report COMPLETION_UNKNOWN, retain charge, and forbid replay. Model three crash boundaries: before persistence (proven not dispatched), after persistence before launch (possibly dispatched), and after launch before acknowledgement (possibly dispatched). S1 models these inputs; it does not persist or launch.
Readiness requires current required capabilities and fresh observations; optional failures remain visible without blocking unrelated consumers.
Incident counters survive duplicate ensure, PID changes, reattachment, and epoch changes. Only explicit allowed rearm or observed sustained health resets them.
Managed recovery defaults to no shared-router restart. Preserve legacy restart-once behavior. Any later shared-router recovery requires separate policy and protected-neighbour proof.
Output uses versioned allowlisted fixed fields and opaque bounded identifiers. Reject invalid versions, revisions, unsupported fields where structural validation requires it, and oversized UTF-8 output without partial JSON or silent truncation. Never forward raw provider errors, commands, paths, or arbitrary diagnostic payloads.
Operational thresholds, real support cell, service enrollment, and automatic action policy remain unresolved until measured canary adoption.

### Delegation Map
| Item | Owner and paths | Acceptance |
| --- | --- | --- |
| Contract and decision | Main; src/core/reliability-contract.ts, src/core/__tests__/reliability-contract.test.ts and next available docs/adr record | Types/validation, identity/revision semantics and compatibility documented; main retains architecture decisions |
| Pure state model | Native executor after contract freeze; src/core/reliability-model.ts and its focused test | Duplicate requests, stop races, consumers, pins, partial stop and possible dispatch produce correct effects; no I/O |
| Output projection | Main; src/core/reliability-output.ts and focused test | Freshness, required/optional capability summaries and bounded allowlisted serialization; critical-path contract coupling |
| Integration proof | Main | Existing CLI outputs unchanged; no provider/controller activation; exact diff and all relevant checks |

Keep modules to this small set, combining contract/projection if it reduces complexity. No dependency, schema migration, CLI flag, persistence store, hidden runtime state writer, or suppression of unused-code checks. Production modules exercised by tests are the intended deliverable. If repository checks reject that arrangement, pause and revise the package boundary; do not silently substitute a test-only model or add artificial production wiring. The architecture decision remains proposed for machine activation.

### Verification
First run focused model/encoding suites with synthetic fixtures and injected clocks. Include duplicate ensure, conflicting keys, late ready after stop, multiple consumers, human pin, repeated parked attach, stale epoch, unavailable observations, partial stop, uncertain dispatch, persistent incident budgets, and oversized/secret-bearing output.
Run existing ensure, stop and route-health regressions. Then docs policy, knowledge, Biome, Knip, typecheck, unit/process tests, build and inspected isolated package smoke. Run Linux-only process checks in an approved Linux runner or explicitly record skipped, never passing.
For each substantive local commit, inspect staged data hygiene and scope, run simplifier plus risk-selected slice reviewer, disposition verified findings. Run final reviewer on integrated committed scope after checks. Do not repeat unchanged checks merely because commit wrappers moved.
Baseline already observed in planning worktree: docs policy and knowledge pass; 110 tests across workspace-ensure, environment-stop and traefik-route-health pass. No runtime or OOM proof.

### Continuous dogfood execution contract
Continuous means change-triggered verification during implementation, not an unattended scheduler.
Every changed state/lock rule runs its deterministic regression before and after the change. Regression tests must demonstrate the invariant at risk; new features do not require artificial failing runs.
Every lifecycle adapter change adds installed CLI proof plus the smallest isolated live case before its package can claim runtime qualification.
Every admission/recovery change runs two isolated environments: inject only fixture-local bounded faults, verify the protected neighbour functionally, and verify retained synthetic records plus dirty/untracked files.
For the installed canary, record all first attempts, failures, corrections, source/package/provider versions, resource limits, sample counts and timings separately for cold, cached-cold, warm, stopped-resume and recovery.
Target twenty routine journeys and ten selected live-fault repetitions per advertised cell, subject to explicitly reviewed resource caps. Do not induce host OOM, restart the shared VM, or silently start a paid runner.
The actual harness journey must prove zero agent infrastructure-repair calls and no model polling while parked. A stock desktop integration is unqualified until actual tool coverage and continuation are demonstrated.
Skipped prerequisites, absent Docker/provider, unavailable runner or failed teardown are non-passing outcomes. Existing smoke-workspace-lifecycle.sh exits zero on missing prerequisites; its future qualification wrapper must distinguish skip before claiming success.
Save bounded synthetic receipts under docs/project/_local; store no raw logs, secrets, transcripts or real user records. No automatic upload. Retain only evidence necessary for current package and canary; agree retention/caps before enabling continuous live collection.
Stop and verify exact fixture runtimes after each live session; destructive fixture teardown is separately enumerated in that package.

### Acceptance ownership and evidence progression
| Package | Acceptance cases and layer | Gate |
| --- | --- | --- |
| Contract foundation S1 | Q14 parked attach; Q17 stale intent; Q18 consumer/pin decisions; Q19-Q20 epoch invalidation only; Q22 possible dispatch; Q23 partial stop; Q27 encoding; Q34 budget retention, all model-only | Source foundation only; later live proof still required |
| Safe lifecycle S2 | Q04, Q06-Q08, Q17, Q19, Q21-Q23; installed CLI + isolated provider faults | No stale starts, uncertain replay or false stopped state |
| Readiness/preparation S3 | Q01-Q06, Q24-Q26; fixture and consumer functional/browser checks | Honest required readiness, retained data and output isolation |
| Observer S4 | Q18-Q21 leases/sleep/wake/journal recovery, Q27-Q28, Q31-Q32 event loss/compaction and corrupt/disk-full state; controller restart/IPC fixture | Observation-only enrollment; no autonomous recovery |
| Admission S5 and recovery S6 | Q07-Q16, Q23, Q33-Q35; deterministic pool model then bounded two-environment faults | Atomic charging, pressure-safe recovery, no protected preemption |
| Harness/package S7 | Q22, Q28-Q31; actual installed harness/tool coverage | Enforced waiting, uncertainty preserved, authorized continuation |
| Qualification S8 | Q01-Q36 on the named supported cell, with applicable earlier receipts | M1 real consumer/harness journey, protected neighbour and zero agent repair |

Q identifiers refer to the expanded roadmap's acceptance matrix. Every listed model case remains pending live qualification where applicable. No package claims universal provider or harness support.

## Progress
The parent integrated the pure model after the executor failed to converge on tests. Native activity showed repeated analysis after a narrowing checkpoint; the parent closed that child, retained its model draft, and completed the corrections and tests. No substitute executor was launched. Integration fixes preserve charges after admission loss, require fresh admission and operation identity on resume, invalidate stop proof across generations, and keep readiness consumer-specific.

The integrated suite passed 1,000 tests. A subsequent consumer-isolation regression and affected tests pass 48 tests across the three reliability suites. Required independent reviews are pending; no runtime or OOM qualification is claimed.

Git capability restored on retry: escalated fetch and creation of the planned worktree succeeded. The implementation branch starts at the verified main baseline above, with no upstream. Protected Git metadata requires escalation; ordinary source writes work within the task worktree. Earlier failures below are historical evidence.

The contract validator and allowlisted consumer projection pass 28 focused tests with Node 24.16.0. The delegated pure lifecycle model is in progress. ADR 0008 records the source-only architecture boundary. No live runtime has been started.

The output-size regression brings focused coverage to 29 tests. Typecheck, Biome, Knip, docs policy, knowledge validation, CLI build, and isolated package smoke pass. A scoped Opengrep scan of the contract and output modules reports zero findings. The full Vitest suite passes 982 tests after escalation: the default sandbox denies `ps`, which prevented the existing macOS lock fixtures from identifying process births. Linux process tests explicitly skip because `/proc` is absent; they are not recorded as passing. These receipts precede model integration.

The user approved the execution package after the initial blocked checkpoint. Approval is settled and must not be requested again for this scope. Live dogfood has not started.
Expanded roadmap review identified dispatch ambiguity, shared-router policy conflict, operational-policy sequencing, unconditional rebase wording, and missing concrete continuous-test ownership. All accepted for this plan.
Planner round 1 requested four corrections: precise dispatch crash boundaries, production-module deliverable, sole integration owner, and narrower model evidence claims. All accepted. Round 2: VERDICT APPROVED. All four findings resolved. This is independent plan readiness, not user approval or live qualification.

Required architecture-advisor consultation is complete after approval. AGY's exact catalog selection `gemini-3.8-flash-high` returned SUCCESS and DONE_WITH_CONCERNS when supplied the complete bounded question directly. No permission bypass or model substitution was used. Its epoch-fencing, uncertain-stop and unused-code concerns are covered by this plan. Do not adopt its suggested incident-budget penalty for unknown observations: retain resource charges, but charge corrective-action budgets only for actual corrective actions. See the local advisor disposition for evidence and the other rejected recommendations.

Historical permission failure: exact authorized worktree creation initially returned `cannot lock ref 'refs/heads/rs/reliability-contract-foundation': Unable to create .../reliability-contract-foundation.lock: Operation not permitted`. The successful escalated retry resolved this blocker without an alternate checkout or sandbox bypass.

# Recover selected profiles after interrupted initial startup

## Approval summary

An initial managed Devsy ensure can be cancelled before managed runtime state
exists. Stop then loads the default profile and refuses a complete population
started for another profile. The approved fix uses the exact interrupted ensure
entry in the existing lifecycle journal, which already preserves the selected
profile before provider dispatch and through cancellation. It combines that
historical intent with live provider identity, generated configuration and the
containers' recorded Compose configuration hashes.

No new journal schema or startup receipt is needed. This does not reconstruct
all historical dispatch bytes: it proves historical profile intent and a
currently owned, configuration-matching population, as permitted by the approved
alternative. Missing or conflicting evidence remains a refusal. Positive
pre-registration absence and retained-baseline recovery retain their contracts.

Authority is an executable batch: source implementation, regression tests,
configured reviews, ordinary task-branch commits/push and draft PR. Merge,
release, installation and consumer mutations are withheld. The original task
remains the sole runtime owner. Terminal delivery includes an exact tested
revision and a conditional supported recovery command; live recovery is a
separate producing-run proof. A legacy workspace is recoverable only if its
complete proof passes, even when its history still contains the profile.

## Execution details

Base: `6784bfcdff8d429a4a68608441a0fb40eb4f74c9` (`origin/main`, version 0.0.74).
Worktree: `trees/rs/partial-start-profile`, branch `rs/partial-start-profile`.
Artifacts root: `docs/project/`. Ceremony: full path, lifecycle ownership risk.
The source-only sidecar found no historical profile in generated configuration;
main subsequently found the surviving profile in operation history. The planner
accepted the journal-based alternative after this correction.

### Binding contracts

- Require current drained ensure, matching history, no worker and stopping intent.
- Revalidate a stable journal identity/fence/operation/history projection; own
  stop revision and effect counters do not invalidate it.
- Re-derive the selected plan, validate generated config and every recorded
  Compose hash; require exactly the selected service set.
- Pin local endpoint/daemon, provider identity, UID/runner binding, all full
  container IDs, mounts and provenance. Recheck before and after every fenced
  pinned stop. A stopped ID restarting is a refusal.
- No fallback to a default profile or broad provider stop on missing evidence.
- No consumer source/index/runtime writes during implementation or verification.

### Delegation map and sequence

S1 (main): initial-stop proof and regression tests. Route: main. Execution-tier
skip reason: critical-path coupling of evidence selection and mutation authority.
Owned source: `src/core/managed-devsy-stop.ts`. Extend existing managed-stop and
reliability-model tests only as needed. Acceptance: complete selected population
stops; each invalid evidence case prevents subsequent mutation.

S2 (main): integration, documentation and delivery. Route: main; external effects
and final proof belong to main. Update the existing pre-registration incident
solution and the affected lifecycle knowledge authority. Acceptance: repository
checks, simplifier/slice review and integrated final review, draft PR with exact
revision and evidence limits.

### Test portfolio

- Extend existing model/managed-stop tests: profile survives cancellation;
  missing, wrong, undrained, unreadable or changed journal refuses.
- Extend managed-stop tests: seven selected services; missing/extra services,
  generated config drift and recorded Compose hash failures refuse.
- Extend managed-stop tests: provider/daemon drift, UID/runner mismatch,
  mid-stop restart and own effect-counter changes.
- No new tests for unchanged dispatch/storage/baseline implementations.

### Verification and review

Baseline: 110 managed-stop/provider-adapter tests passed. Establish a red
seven-service regression first, then implement and run focused tests, docs policy,
knowledge, Biome, Knip, typecheck, full tests, build and package smoke. Preserve
passing evidence for unchanged inputs. Use synthetic fixtures, no runtime startup.
Run dedicated simplifier and risk review on the committed slice, then integrated
final review. Existing consumer evidence may be inspected read-only; report any
failed proof rather than weakening it.

## Progress

S1 committed as `5df8bf99e635a50a2812302f7e2f0b8282029a87`; S2 active.
Planner Dalton APPROVED frozen draft. Executor Maxwell delivered disjoint tests;
main corrected unmanaged compatibility and verified the full diff. Dedicated
simplifier and slice reviewer are active; integrated final review pending.
Optional AGY planning challenge failed before source access (read_file denied).

Baseline0.0.74 fails the new seven-service regression with the reported complete
population refusal. Fixed source passes173 focused tests. Full2241 tests passed
with four workers before the last unmanaged classification preservation; final
exact-revision CI/full checks are pending. An unrestricted parallel run timed out
in an unrelated controller test. Node24.16.0 is the acceptance toolchain. Linux
process tests are unavailable locally; CI supplies that environment. Docs policy,
knowledge, Biome, Knip and typecheck pass; build/package smoke will be refreshed.

Substantive slice size:607 additions/46 deletions across one source and two test
files. One bounded lifecycle fix, no stack or additional package. The adjacent
failure was found after PR93 live dogfooding; the historical profile evidence was
missed by the prior initial-stop path, not introduced by PR93's absence exception.
No PR exists yet. No consumer mutation, merge, release or installation performed.
Read-only evidence supports conditional existing recovery, but canonical stop and
fresh provider/routes proof remain the original runtime owner's responsibility.

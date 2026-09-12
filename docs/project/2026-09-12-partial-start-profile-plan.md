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

Planning complete; implementation pending. Planner Dalton approved the minimal
journal evidence direction; frozen-draft challenge APPROVED. No PR exists yet.
Substantive size: 0 lines. No consumer mutations or runtime watchers.

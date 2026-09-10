# Host-port claims: admission-time detection of consumer-declared fixed host-port conflicts

- Branch: `rs/host-port-claims` (worktree `trees/rs/host-port-claims`), based on `f167c91`
  (stacked on local `rs/journal-deadlock-recovery`, 0.0.67; rebase onto `main` after the parent merges).
- Target: `main`. Delivery: release `0.0.68` per the release checklist; push/PR remains an owner
  decision because the branch stacks on the unmerged parent.
- Handoffs: `~/.handoffs/devrouter/2026-09-10-host-port-claims-product-gap-handoff.md` (work item),
  `~/.handoffs/devrouter/2026-09-10-journal-liveness-0.0.67-and-port-blocker-handoff.md` (context).

## Approval summary

Managed `ensure` starts consumer compose verbatim, so a consumer-declared FIXED host binding
(e.g. klicker azurite `127.0.0.1:10003`) is machine-global state devrouter never checked: two
workspaces collided and the second burned a minutes-long provider bootstrap before failing with
Docker's raw `port is already allocated` and no holder attribution. This package adds
**host-port claims**: before dispatching a managed start, render the effective compose model with
the exact interpolation env the start will use, extract fixed published host bindings (ephemeral
bindings are exempt), check live Docker for holders of the same host IP+port, and refuse within
seconds with a structured result naming the port, holding container, compose project, owning
workspace (when attributable), and canonical remediation. A read-only `devrouter doctor` check
surfaces configured-vs-live drift before any start. Detection only: devrouter never rewrites,
offsets, or regenerates consumer configuration — the refusal is always the product.

What stays unchanged: committed configs are never mutated; `ensure` behavior when no conflict
exists is byte-identical apart from the detection cost (one compose render + one `docker ps` +
one batched `docker inspect` of running containers); status/doctor stay read-only; no persistent
claim ledger — live Docker state is the truth source for kernel facts.

Decision-changing risks: none remain open. The refused ensure is returned as a structured result
field (not a thrown error) because the lifecycle worker crosses a process boundary that keeps
only the error message; this follows the existing `applicationReadiness` failure precedent. The
check→start TOCTOU is narrowed but not closed (extra compose services start outside the provider
mutation lock); the kernel remains the backstop for the narrow concurrent-start window, and the
refusal already names the holder.

Done means: ensure refuses a live port conflict with attribution in seconds (unit-proven, no live
Docker needed for CI), doctor reports configured-vs-live holders, the full validation checklist
passes, and release artifacts for `0.0.68` exist on the branch.

Approval mode: executable batch delegated by the ready-to-claim handoff (origin session
`sess_a4d91191-ed05-4227-9f7a-fa7d517fd3c1`). Granted: local commits on the task branch, release
`0.0.68` artifacts, running the repo validation checklist. Withheld: push, PR creation, touching
the `rs/journal-deadlock-recovery` worktree, mutating klicker workspaces, live smoking against
owner runtimes. Terminal condition: validation checklist green at the release commit, plan
`Progress` final, handoff checkpoint written. Pause only if a checklist item fails for reasons
outside this package or a material contract conflict with the parent branch appears.

## Execution details

### Design decisions (settled)

- **Refusal as result, not throw.** `WorkspaceEnsureResult` gains optional
  `hostPortConflicts: HostPortClaimConflict[]`. `ensureNetworkLocked` detects the conflict after
  plan/env resolution and before `createManagedNetworkSession`/`writeManagedDevcontainerConfig`,
  returns the refusal result, and the worker records completion exit 1. The refusal path itself
  performs no detection-caused mutation: it returns before the network session, the generated
  config write, the provider start, and extra-service start. (Earlier admission steps that may
  have run before detection — first-use owner records, user `prepareCommand`, unattached-network
  recovery — are pre-existing admission behavior, unchanged.) `runEnsureCommand` (both `ensure`
  and the `workspace ensure` alias route through it) prints conflicts in human output and exits
  1; `--json` already prints the result, so the refusal is machine-readable.
- **Ensure evidence unavailability is fail-closed.** If the compose render fails (the same
  resolution `compose up` performs, so start would fail anyway) or the live holder inspection
  fails (daemon unreachable — start would fail too), admission refuses with a precise message
  naming the unavailable evidence. Fast, loud, and honest; only the doctor check is tolerant
  (warn) about unavailable evidence.
- **New module `src/core/host-port-claims.ts`** with: a pure fixed-port resolver over the
  rendered `docker compose --profile '*' config --format json` model (per-service `ports`:
  `published` literal or bounded range; `published` empty/`0`/absent = ephemeral, exempt;
  `host_ip` absent = wildcard; `protocol` defaults `tcp`; range expansion capped, overflow fails
  closed); a holder inspector following the repo's proven inspect pattern — one
  `docker ps --filter status=running --format {{.ID}}`, then one batched
  `docker inspect --format <template>` over those IDs extracting compose labels and
  `.NetworkSettings.Ports` (structured `[{HostIp, HostPort}]`; empty `HostIp` = wildcard) —
  never `docker ps --format json`, whose Labels/Ports are pre-formatted strings on real daemons;
  the conflict engine (render with `--profile '*'` and the same env as
  `managedComposeEnvironment(workspace)`, intersect, exclude the target's own containers by
  `com.docker.compose.project.working_dir == <repoPath>/.devcontainer` like
  `reliability-lifecycle` stop population logic, attribute remaining holders via compose labels +
  `listWorkspaceOwnership` worktree match); and conflict fields
  `{hostIp, hostPort, protocol, service, holderContainer, holderComposeProject?, holderWorktreePath?,
  holderWorkspace?, holderBranch?, remediation}`.
- **Conflict rule (conservative):** same port + same protocol AND (either side wildcard or equal
  IPs). IPv6 nuances over-approximate conflicts deliberately: loud refusal over missed collision.
- **Enrichment:** only when conflict candidates exist, one batched
  `inspectWorkspaceContainers({ids})` adds labels for exclusion/attribution. Inspect failure for a
  candidate is fail-closed (conflict stands). No holders attributable to a workspace name report
  container + project + working_dir with workspace unknown.
- **No ledger, no race fixture.** Verified: provider starts are serialized machine-globally
  (`withMutationLock` in `devpod-mutation.ts`/`devsy-mutation.ts`), which prevents same-repo
  races; cross-repo overlap on extra services (started by `startExactManagedServices` outside the
  provider lock) retains a raw Docker error as backstop — same as today, no worse. A persistent
  ledger adds state without changing the truth source; label + ownership attribution names the
  owner in the incident class.
- **Doctor check `repo.host-port-claims`** in `buildDevcontainerChecks`: no-op when the repo has
  no `managedRuntime`; otherwise renders desired fixed bindings for the repo's managed model
  (tolerant env, no network guard needed — `networkDockerEnvironment()` is passthrough outside a
  scope) vs live holders. Error on conflict, ok when none or no fixed bindings, warn when
  rendering or Docker evidence is unavailable (reason in details). Never throws out of the check.
- **Values:** host ports, container names, and workspace names are not secrets; the rendered
  model itself is never persisted or logged (may contain env-file secrets) — only extracted port
  bindings are kept.

### Non-negotiables (from repo contracts)

1. Never mutate/rewrite consumer compose or `.devrouter.yml`; refusal is the product.
2. Read-only against Docker; happy path = one compose render + one `docker ps` + one batched
   `docker inspect` of running containers; no per-container sizing or extra inspection.
3. The render uses devrouter's own preparation inputs (`managedComposeEnvironment`), never ad-hoc
   env, so the check sees exactly what start would bind.
4. `status`/`doctor` stay read-only; the new doctor check never blocks on missing evidence.

### Test portfolio

| Risk | Obligation | Seam | Slice |
| --- | --- | --- | --- |
| Fixed/ephemeral/range/protocol/wildcard misclassification | add new | `resolveFixedPublishedHostPorts` (pure unit) | 1 |
| Wrong conflict match (wildcard, IP equality, protocol) | add new | pure matcher unit | 1 |
| Attribution/exclusion wrong (own containers flagged, foreign unnamed) | add new | `detectHostPortClaimConflicts` with mocked `child_process` + tmp ownership files | 1 |
| Ensure mutates state on refusal or blocks happy path | add new | `workspace-ensure.test.ts`: refusal returns result, no provider/network dispatch; existing suite green with engine mocked no-conflict | 2 |
| Refusal not machine-readable / wrong exit code | add new | command-layer test of JSON shape + exit 1 | 2 |
| Render or holder evidence unavailable: admission must refuse loudly, doctor must warn | add new | engine unit for failure mapping + doctor check unit | 1, 3 |
| Doctor crashes or misreports on unavailable evidence | add new | doctor check unit with mocked engine | 3 |

### Slices

1. **Conflict engine** — `src/core/host-port-claims.ts` + `src/core/__tests__/host-port-claims.test.ts`
   (resolver, matcher, engine, attribution, remediation strings). Route: main (coupled lifecycle
   seam; mock surface shared with the ensure suite; delegation overhead exceeds benefit).
   Acceptance: new unit suite green; `pnpm typecheck` green. Commit: `feat(network): host-port claim conflict engine`.
2. **Ensure admission wiring** — refusal result field, detection call in `ensureNetworkLocked`,
   worker completion exit, command human/JSON output. Tests per portfolio rows 4–5.
   Acceptance: `workspace-ensure` suite green including new refusal cases. Commit:
   `feat(lifecycle): refuse managed ensure on fixed host-port conflicts`.
3. **Doctor diagnostic** — check in `buildDevcontainerChecks` + tests. Acceptance: doctor suite
   green. Commit: `feat(doctor): report configured vs live fixed host-port holders`.
4. **Release `0.0.68`** — version bumps, CHANGELOG + `upgrade-prompts/0.0.68.md`, SKILL.md +
   `ai-prompt.ts` intents, AGENTS.md map entry, `docs/knowledge/managed-environment-lifecycle.md`
   concept, examples pins. Full validation checklist. Commit: `chore(release): prepare host-port claims patch 0.0.68`.

Post-slice gates: simplifier + slice-reviewer after slice 2 (substantive, risk-armed: admission
path); integrated final review over the full branch before completion claims. Reviews are
read-only child dispatches; reports persist under `docs/project/_local/reviews/` (gitignored).

### Progress

- 2026-09-10: takeover complete; handoffs read; worktree created at `f167c91`; code seams mapped;
  design settled (result-refusal, no ledger, admission-only check); plan written.
- 2026-09-10: plan hardening round 1 → REVISE; all six findings accepted and folded in: holder
  inventory switched to ps-IDs + batched `docker inspect` with `.NetworkSettings.Ports`
  (empirical: `docker ps --format json` Labels/Ports are strings), `--profile '*'` added to
  renders, refusal no-mutation claim scoped precisely, ensure evidence-unavailability pinned
  fail-closed (+ portfolio row), plan moved into the worktree + index registration pending in the
  plan commit, doctor no-op without `managedRuntime`. Next: round 2 on the revised draft.

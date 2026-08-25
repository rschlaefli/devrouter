# Profiles, leases, and resource lifecycle plan

## Goal

- Make devrouter profile-aware so agents start only the apps and dependencies a task needs (`devrouter ensure <path> --profile <name>`).
- Add lease-based idle lifecycle so stopped-when-unused runtimes are the default, without guessing from CPU or killing worktrees.
- Clarify the three supported runtime modes (host, native DevContainer with `forwardPorts`, managed devrouter) in product docs, the bundled skill, and diagnostics.
- Release the above as `0.0.36` with the full release checklist.

## Non-goals

- No per-app containers: the single devcontainer model stays; profiles filter processes, routes, and readiness, not container topology.
- No CPU/memory-sampling-based idle detection: idle evidence comes from leases and devrouter command interactions only.
- No breaking `.devrouter.yml` schema changes: `profiles` is additive; a config without `profiles` behaves exactly as today (implicit full profile).
- No automatic deletion of worktrees, volumes, or data: idle lifecycle only stops runtimes; destructive cleanup remains ledger-scoped (`workspace gc`, `workspace down`).
- No Traefik access-log parsing as a lifecycle input in v1 (kept as a human hint via `devrouter logs`).

## Identity

- Plan: `docs/project/2026-08-24-profiles-leases-resource-plan.md`
- Branch: `rs/profiles-leases-idle`
- Worktree: `trees/profiles-leases-idle`
- Base: `main` at `57e9749`
- Release target: `0.0.36`
- Downstream: KlickerUZH adoption plan `project/2026-08-24-devrouter-profiles-three-mode-plan.md` on branch `rs/devrouter-profiles` (worktree `trees/devrouter-profiles` in `/Volumes/HOME/Git/klicker/klicker-uzh`).

## Verified starting state

- `0.0.35` is released; `.devrouter.yml` strict schema validation lives in `src/core/repo-config.ts` (`loadRuntimeConfig`, `applyWorkspace`, `${WORKSPACE}` substitution).
- Durable per-workspace owner records live in the repository Git common directory (`src/core/workspace-ownership.ts`) and already survive linked-worktree removal — the natural home for lease/idle fields.
- `workspace gc` is dry-run-first and never touches Git worktrees, branches, or prune state (`src/core/workspace-gc.ts`).
- `devrouter exec` runs one-shot commands through the exact running DevPod without relying on DevPod's host SSH port forwarding (`src/core/devpod-exec.ts`) — this must be documented as the reason agents never need `forwardPorts` in managed mode.
- `devrouter doctor` already aggregates static devcontainer checks (`src/core/devcontainer-diagnostics.ts`); `forwardPorts` is currently invisible to it.
- KlickerUZH currently runs every routed app plus two Hatchet workers in one `turbo dev` process group per workspace; profile savings there are dev-server processes, not container count.

## Decisions

- **Profiles are a config-level filter, not a new runtime kind.** `profiles.<name>.apps` selects routed apps; `dependencies` selects `kind=dependency` services to start; `readiness` selects the subset of apps `ensure` HTTP-probes before declaring success. `apps: '*'` means all routed apps. Exactly one profile may set `default: true`; when the `profiles` key is absent, devrouter synthesizes an implicit full profile so existing configs need no migration.
- **Profile selection is part of runtime identity.** The profile name joins the managed-process fingerprint inputs (via the adapter's declared fingerprint env, e.g. `DEVROUTER_PROFILE`) and the route metadata tag. Switching `--profile` therefore replaces the owned process group and reconciles routes atomically instead of leaving a mix of two profiles' routes.
- **Routes are scoped to the selected profile.** `ensure --profile ui` creates routes only for that profile's apps; previously created routes for other profiles of the same workspace are removed by the same atomic reconciliation that already replaces exact route sets. `exec` is profile-independent (it addresses the DevPod, not routes).
- **Leases extend owner records, not a second ledger.** `lastActivityAt`, `lease: { holder, expiresAt } | null`, and `pinned` are added to the existing durable owner record schema (backward-compatible: absent fields default to unpinned, no lease, activity = record creation time).
- **Every devrouter interaction is a touch.** `ensure`, `exec`, `open`, `app run`, `app exec`, `workspace up`, `workspace ensure` bump `lastActivityAt`. Agents that hold a workspace across a long task use `workspace claim` (lease with TTL) and `workspace heartbeat`; `workspace release` and `workspace pin`/`workspace unpin` complete the surface. Lease expiry is passive: an expired lease simply stops excluding a workspace from idle reporting.
- **Idle lifecycle is dry-run-first and stop-only.** `devrouter workspace idle [--ttl <duration>]` reports workspaces whose runtime is up, unpinned, unleased (or lease-expired), and untouched past the TTL, with an estimated container count. `--stop` stops exactly those runtimes through the existing machine-global mutation lock with exact-owner revalidation — the same fail-closed path as `workspace stop`. Worktrees, branches, volumes, and owner records are never touched. Dirty or locked workspaces are excluded.
- **`forwardPorts` becomes a documented, diagnosed mode signal — not an error.** Native DevContainer mode needs it; managed mode ignores it (no host SSH tunnels are established by `ensure`/`exec`). Doctor reports `repo.devcontainer-forwardports` as informational with the mode explanation, so agents stop treating it as either a bug or a dependency.
- **Diagnosis is classification, not log dumping.** The new live diagnosis surface maps observed symptoms to one of: missing container, stale route, crashed managed process, broken DevPod runtime, wrong alias namespace — each with its matching remediation command (`ensure`, `stop`+`ensure`, `workspace gc`, etc.).

## Slices

### Slice 1: profile schema and validation

- Do: add `profiles` to the strict schema in `src/core/repo-config.ts`; validate referenced apps/dependencies exist, `readiness ⊆ apps`, exactly one default, cycle-free dependency resolution via the existing `resolveAppDependencies`; implicit full profile when `profiles` is absent.
- Test: schema validation cases in `src/core/__tests__/repo-config.test.ts` (valid profiles, unknown app, unknown dep, readiness-not-in-apps, two defaults, absent-profiles backward compat).
- Check: `pnpm typecheck && pnpm test -- repo-config`.

### Slice 2: profile-aware ensure/exec/status

- Do: thread `--profile` through `workspace-ensure.ts` (process start filter, readiness subset, route set replacement, fingerprint input) and `app-run.ts` (dependency start filter); expose `profile` in `status --json` and `workspace ls --json`.
- Test: `workspace-ensure.test.ts` cases — profile filters routes and readiness, profile switch replaces process group and route set, exec ignores profile, fingerprint changes with profile.
- Check: `pnpm typecheck && pnpm test -- workspace-ensure`.

### Slice 3: leases and idle lifecycle

- Do: extend owner-record schema and touch points; add `workspace claim|heartbeat|release|pin|unpin`; add `workspace idle [--ttl] [--stop]` in `src/core/workspace-idle.ts` reusing `workspace-lifecycle.ts` stop path and the machine-global mutation lock.
- Test: owner-record migration defaults, touch-point updates, TTL boundary math, exclusion of pinned/leased/dirty/locked, `--stop` stops only reported runtimes, lock contention fails closed.
- Check: `pnpm typecheck && pnpm test -- workspace`.

### Slice 4: doctor and live diagnosis

- Do: add `repo.devcontainer-forwardports` (informational) and `repo.profile-graph` checks to `doctor.ts`/`devcontainer-diagnostics.ts`; add the live diagnosis classifier (new `diagnose` command or `doctor --live`) with remediation mapping; extend `ensure --json` with the compact ready block (profile, URLs, exec/log commands, lease id).
- Test: doctor fixtures for forwardPorts present/absent × proxy runtime, broken profile refs; classifier unit tests per symptom class.
- Check: `pnpm typecheck && pnpm test -- doctor`.

### Slice 5: docs, skill, and release

- Do: update bundled `.agents/skills/devrouter/SKILL.md` and `src/core/ai-prompt.ts` (profiles, lease commands, three-mode table, `devrouter exec` over `devpod ssh`, `npx agent-browser` rule for consumers), `docs/DEVCONTAINER.md`, `docs/REPO_ONBOARDING.md`, `examples/*`; run the full `0.0.36` release checklist (version bumps, `CHANGELOG.md` section, `upgrade-prompts/0.0.36.md`, example config version pins).
- Test: `ai-prompt.test.ts` consistency; docs-policy and knowledge checks.
- Check: full validation checklist from AGENTS.md (`check:docs-policy`, `check:knowledge`, `check`, `knip`, `typecheck`, `test`, `build`, `routing:smoke`, `devcontainer:smoke` with `--profile`).

## Sequencing

Slices 1–2 are the prerequisite for the KlickerUZH adoption Slices 1–2; Slices 3–5 can proceed in parallel with downstream docs work. The downstream repo pins `devrouter.version: 0.0.36` only once this release exists.

## Progress

- Current: Slices 1–2 implemented on `rs/profiles-leases-idle`; CLI built and installed locally as `0.0.36` (`~/.local/bin/devrouter` via `scripts/install-local.sh`).
  - `profiles` schema (strict keys, `*` wildcard, dependency/readiness cross-validation, ≤1 default, implicit full when absent), `resolveProfile`/`applyProfile` in `repo-config.ts`.
  - `loadRuntimeConfig(repoPath, workspaceOverride, profileOverride)` threads the profile to every runtime consumer; `ensure --profile` (and `workspace ensure --profile`) filters routes/readiness and passes `DEVROUTER_PROFILE` into the managed adapter env (`managed-post-start.ts`); ensure result and human output carry the profile.
  - Validation: `pnpm typecheck`, `pnpm test` (539 passed incl. 12 new profile cases), `pnpm check`, `pnpm knip` clean.
  - Downstream proof: klicker-uzh worktree `rs-devrouter-profiles` ensured with `--profile ui` (3 profile routes, profile env in container, non-profile apps unrouted) and with the default `full` profile (10 routes) — see the downstream plan's Progress section.
- Next: Slice 3 (doctor forwardPorts/profile-graph checks), Slice 4 (live diagnosis), Slice 5 (docs/skill/release checklist for `0.0.36`: changelog, upgrade prompt, example version pins).
- Follow-up (implemented after Slice 2): comma-separated profile merging in `resolveProfile` — `--profile manage,pwa` unions and dedupes apps/dependencies/readiness across the selected profiles; a wildcard member collapses to everything; the merged name is canonicalized (sorted unique) so `pwa,manage` ≡ `manage,pwa` share one fingerprint and route-generation tag. 6 new tests (545 total pass); proven live downstream with `manage,pwa`, `pwa,manage` (no restart), and `manage,chat,pwa`.

# Collision-safe parallel workspace identities

## Goal

- Let many linked worktrees start in parallel across DevPod and Devsy without
  colliding when their readable branch prefixes share the first 32 characters.
- Preserve every existing persisted workspace, provider registration, route,
  and ownership record byte-for-byte.
- Make a new workspace claim deterministic, repository-local, serialized,
  residue-safe, and recoverable before any provider or route mutation.

## Scope and authority

- Repository: `rschlaefli/devrouter`.
- Branch: `rs/collision-safe-workspace-ids`.
- Worktree: `trees/collision-safe-workspace-ids`.
- Base and target: `origin/main` at `9a56b5517b53cc8ca43451844a2a2a891d757dc8`.
- Current authority covers this plan, bounded source/tests/docs, local commits,
  repository-native checks, required reviews, and a prepared `0.0.45` release
  candidate and pull request.
- Publication of npm/GitHub release `0.0.45`, installation, downstream repin,
  merge, provider configuration, force-push, worktree/runtime deletion, and
  broad Docker cleanup remain separate external or destructive actions.

## Root cause

- `wsFromBranch` intentionally sanitizes and truncates every token to one
  32-character DNS label. Distinct long branches can therefore derive the same
  workspace identity and default worktree path.
- `ensure` currently persists the candidate before the repository ownership
  transaction. It consults only the selected provider, then writes the durable
  ownership record later. A failed first claim can leave checkout metadata
  pinned to an identity already owned by another provider or path.
- A real Klicker DevPod/Devsy pair reproduced both seams. The first checkout
  safely retained the legacy identity; the second failed before provider
  startup but required a fresh checkout for continued validation.

## Settled contract

- Keep `wsFromBranch` unchanged. Existing short names and legacy truncation are
  a compatibility surface.
- Existing exact-path persisted metadata, ownership-ledger records, and
  provider registrations are authoritative. Agreements are reused; any
  disagreement fails closed and never renames an established workspace.
- A genuinely new first claim requires readable DevPod and Devsy registries.
  Resolve their exact-path and occupied-ID evidence before entering the short
  repository-local ownership transaction, then re-read persisted metadata and
  ledger records inside it.
- Prefer the legacy readable identity when it is free. On collision, use a
  sanitized readable prefix plus `-` and eight lowercase hexadecimal SHA-256
  characters. Hash the domain-separated untruncated branch-or-path source plus
  a bounded attempt number; try at most 16 candidates.
- Write the owner record and then atomically persist checkout metadata inside
  one transaction. If metadata persistence fails, remove only the newly
  written matching record. A crash after ledger creation recovers from the
  exact-path ledger record on the next run.
- `workspace up` also chooses a deterministic non-conflicting default path when
  the legacy path is occupied. `--no-devpod` remains provider-free and may
  retain a provisional branch/path identity until first `ensure`. Concurrent
  allocation waits up to 60 seconds for a repository peer completing `git
  worktree add`, while ordinary owner-record transactions keep their existing
  short timeout.
- Provider mutation, generated managed config, services, processes, and routes
  begin only after the claim is complete. Stop, cleanup, GC, route attribution,
  and the ownership schema remain unchanged.

## Design gates

- Product primitive: no application or user-facing product primitive changes.
- Security/data: no credentials, environment values, personal data, or global
  registry is introduced. Hash input is local branch/path identity only.
- ADR: not required while this remains a repository-local allocation refinement
  under the existing owner-record schema. A global allocator, automatic
  migration, or cross-repository claim mechanism re-arms the ADR gate.
- Planning review: the native planner route failed before launch because stale
  role metadata selected an unsupported model/effort pair. Trusted Sol/xhigh
  continuity returned `APPROVED_WITH_CORRECTIONS`; all corrections above are
  adopted.

## Slices

### S1: collision-safe candidates and first claim

- Add deterministic fallback candidate generation without changing
  `wsFromBranch` output.
- Reconcile persisted metadata, exact-path ledger records, and both provider
  registries. Claim a new identity within the ownership transaction and make
  persistence failure residue-safe.
- Wire `ensure` to the claim result before generated config or provider work.
- Acceptance: focused workspace, ownership, provider-runtime, and ensure tests
  prove compatibility, cross-provider occupancy, bounded exhaustion, recovery,
  and no mutation on unresolved evidence.
- Commit: `fix(workspace): claim collision-safe identities`.

### S2: collision-safe workspace creation

- Make the default `workspace up` path deterministic when the legacy path is
  already registered to another branch. Preserve explicit paths and exact
  existing branch worktrees.
- Add a real cross-process fixture over two linked worktrees sharing one Git
  common directory to prove serialization rather than only mocked locks.
- Acceptance: lifecycle and child-process tests pass for serial and concurrent
  colliding-prefix worktrees, including `--no-devpod`.
- Commit: `fix(workspace): avoid colliding worktree paths`.

### S3: knowledge, release candidate, and delivery

- Update architecture, managed lifecycle, bundled skill, generated AI guidance,
  and this record without reopening delivered `0.0.43` or `0.0.44` plans.
- Prepare `0.0.45` version, changelog, examples, and one upgrade prompt.
- Run docs policy, knowledge validation, Biome, Knip, typecheck, full tests,
  build, package smoke, Gitleaks, and diff checks.
- Run simplifier and ownership/lifecycle slice review after substantive commits,
  then one integrated final review. Inspect staged and packed content for
  secrets and personal data.
- Push and open a conventional PR only after local gates pass. Publication and
  merge remain withheld.

## Live acceptance after publication approval

- Use the packed candidate first, then the published artifact after release.
- Start two disposable same-commit worktrees whose branch names collide under
  legacy truncation, one on DevPod and one on Devsy, concurrently.
- Prove distinct persisted identities, ledger records, provider IDs, aliases,
  and routes; exact provider selection remains command-local.
- Stop both exactly and prove zero routes. Retain registrations, worktrees,
  containers, and volumes unless destructive cleanup is separately approved.
- Repin Klicker only after registry readback of the published exact version,
  then rerun its fresh provider proof and final delivery gates.

## Progress

- `2026-08-28`: Reproduced the 32-character collision with fresh Klicker
  DevPod and Devsy validation worktrees. Ownership failed closed before the
  second provider start, but checkout metadata had already persisted.
- `2026-08-28`: Sol/xhigh planning continuity approved the repository-local
  transaction design with corrections for both-provider reconciliation,
  residue-safe ordering, `workspace up`, cross-process proof, and no migration.
- `2026-08-28`: S1 and S2 landed together in `7d60f03` because identity
  reservation and repository-level worktree-path allocation share one
  transaction boundary. The focused suite passed 119 tests, including a real
  two-process collision case over one Git common directory.
- `2026-08-28`: Repository verification passed Biome, docs policy, knowledge
  validation, Knip, typecheck, all 752 tests, build, package smoke, Gitleaks,
  and staged/diff checks. Linux-only process tests skipped on macOS because
  `/proc` is unavailable.
- `2026-08-28`: The simplification gate found no warranted reduction. The
  ownership/lifecycle review found two local `workspace up` issues: an
  unregistered legacy directory did not fall through to a candidate path, and
  create-only output reported the legacy token after fallback. Both are fixed
  with focused regressions. Its provider-snapshot race applies only across
  repository-local ledgers or unsupported raw-provider mutation; same-repository
  claims re-read the shared ledger under lock. A machine-global cross-repository
  allocator remains outside this plan and re-arms the ADR gate.
- `2026-08-29`: Integrated final review found that parallel allocation still
  used the ordinary five-second ownership wait and that checkout metadata used
  a direct final-file write. Allocation now uses a scoped 60-second wait with a
  real cross-process regression held beyond five seconds; metadata reuses the
  fsync-backed atomic-file primitive.
- `2026-08-29`: Corrected exact-head verification passed Biome, docs policy,
  knowledge validation, Knip, typecheck, all 754 tests, build, package smoke,
  and diff checks. Linux-only process tests remain skipped on macOS because
  `/proc` is unavailable.
- `2026-08-29`: Repeat integrated final review passed exact behavioral head
  `591ac77` with no actionable P0-P3 findings. It confirmed both prior blockers,
  provider-safe ordering, backward compatibility, and coherent `0.0.45`
  release metadata.
- Current state: complete through the prepared pull request boundary. Push and
  PR creation are next under the approved plan. Merge, publication,
  installation, downstream repin, and live mixed-provider acceptance remain
  withheld.

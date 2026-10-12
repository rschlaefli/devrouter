# Worktree cleanup reliability and team documentation

## Approval summary

**Why and what changes.** devrouter 0.2.0 cleaned a real fleet of about 130
Klicker worktrees, but the run exposed two gaps that keep the tool from being
handed to the engineering team. First, `workspace gc` cannot remove a Devsy
workspace whose checkout folder is already gone: the ordinary provider delete
fails, and the existing forced-delete fallback is reached only when the ordinary
delete succeeds. Second, the Docker containers, volumes and networks of a
vanished checkout are invisible to every cleanup command, and a forced provider
delete removes only the registration, so they stay behind. This package fixes
the `gc` fallback under strict guards, reports Docker leftovers that provably
belong to a vanished worktree of this repository, lets a hash-bound leftover
manifest remove exactly those, and adds one team-facing cleanup guide linked
from the README. Release 0.3.0 and the Klicker minimum-version bump follow.

**What stays unchanged.** Trim eligibility is untouched: a tree with uncommitted
changes, untracked files, a detached HEAD or undeclared ignored state is never
trimmed (user ruling, 2026-10-12). Reclaim, trim and gc keep their dry-run
defaults and manifests. Anything not provably a leftover is reported, never
removed. The Compose project label collision found in PR #130 stays there.

**What could change the decision.** Raising Klicker's minimum to 0.3.0 makes
every team member upgrade; the guide says so. No other open choices remain.

**How we will know it is done.** Regression tests for the guarded gc fallback,
leftover attribution and leftover apply pass in CI. On this machine the dry runs
show exactly the stuck gc record and the `playwright-flakiness` leftover
project; after applying gc and then the leftover manifest, no container, volume,
network or ownership record of that checkout remains. 0.3.0 is installed
globally, Klicker requires it, and the guide link is ready to send.

**What approval authorizes.** Already granted: commits, task-branch pushes, draft
PRs, the release, global install, Klicker's minimum bump and local dogfooding.
Requested now: merging the devrouter feature PR, its release PR and the Klicker
PR(s) once required CI and the final review pass; and, during dogfooding,
applying `gc` only if its dry run lists exactly the record
`test-playwright-flakiness`, then applying a leftover manifest only if it lists
exactly the Compose project `default-te-e1ec3` (otherwise stop and report).
Withheld: any other deletion on this machine, trim changes, team announcements.

## Execution details

### Evidence

- `src/core/devsy-mutation.ts:219` throws on a nonzero ordinary delete before
  the forced branch at `:227-243`, which today also requires runtime
  `not-found` (`:228-233`). Observed 2026-10-08 on record
  `test-playwright-flakiness` (`ownerStatus: missing`, `devpodStatus: owned`).
- The preconditions survive a missing path: the mutation lock is one
  machine-wide file (`:31`, `:74-86`); `restoreRecordedManagedDevcontainerConfig`
  returns early and catches its own errors (`managed-devsy-stop.ts:430`, `:455`);
  runtime resolution reads registry snapshots (`workspace-runtime.ts:269-289`).
  A retained network claim is looked up by path hash
  (`network-claim-lookup.ts:11-14`) and its binding check fails before the
  provider call; gc surfaces that error. Releasing claims stays with
  `network-recovery.ts`.
- The existing manifest schema is Git-identity-bound and closed to
  `reclaim | trim` (`worktree-reclaim.ts:76-86`, `:201-218`, `:250`;
  skill `scripts/manifest.py:27,183`; ADR 0011:18-20). A leftover has no Git
  identity.
- `capacity-docker-probe.ts` is GET-only, has no container state and fails hard
  above 256 containers (`:9`, `:115`, `:142`), so it is not reused.
- Leftover stacks carry `com.docker.compose.project.working_dir` and the
  provider binding label `dev.containers.id` (`devpod-environment.ts:542,561`);
  plain devcontainer CLI stacks carry `devcontainer.local_folder` instead
  (`:613`). Volumes carry only the Compose project and volume labels.
- Docs: README has no cleanup section; `scripts/check-docs-policy.sh:7-17`
  lists the product docs the policy checks.

### Binding contracts

- **Guarded gc fallback.** Inside the existing lock, when the ordinary Devsy
  delete fails, retry once with `--force --ignore-not-found` only when all hold:
  `lstat` of the recorded path returns ENOENT; the Devsy runtime is `stopped`
  or `not-found` (refuse on running, busy or unknown); afterwards ownership is
  `absent`. Otherwise report the original failure. A present checkout whose
  ordinary delete fails is not retried. DevPod is unchanged (no field evidence).
- **Leftover attribution.** A Compose project is a leftover only when every
  condition holds:
  - at least one container has `dev.containers.id` and a `working_dir` whose
    checkout (the label path minus a trailing `/.devcontainer`) returns ENOENT
    while its parent exists with realpath equal to the realpath of
    `<repo>/trees`;
  - no registered Git worktree, ownership record, Devsy or DevPod registration
    matches that ID or path. The row names the next step: "run gc first" for
    an ownership record or provider registration, "run `git worktree prune`"
    for a prunable Git registration whose path returns ENOENT;
  - every container of the project is `exited`, `dead` or `created`;
  - the primary checkout is never a match; the sibling-prefix legacy scope is
    excluded.
- **Removable set of a leftover.** Its exact container IDs; named volumes whose
  name starts with `<project>_`, whose project label equals the project, and
  which no container of another project mounts; non-external networks named
  `<project>_*` with no attached container. Lone or foreign volumes are
  reported as unattributed with a suggested manual command and never enter a
  manifest.
- **Leftover manifest.** A separate kind `docker-leftover-manifest`, reusing
  `canonicalJson`, `sha256Hex`, `requireManifestHash` and the max-age
  preflight. Each candidate binds the Docker daemon ID, project, `working_dir`,
  full container IDs with states, volume names with `CreatedAt`, and network
  IDs. `reclaim`, `trim`, `workspace manifest select` and the skill's
  `manifest.py` reject this kind; `workspace manifest hash` accepts it.
- **Leftover apply.** `devrouter workspace leftover --manifest <f> --sha256 <h>
  [--yes]`, dry run without `--yes`. Per project, holding
  `devsy-mutation.lock` then `devpod-mutation.lock` in that fixed order so
  apply cannot deadlock with an `ensure`: re-derive attribution; skip a project whose evidence
  changed, with an outcome code; remove containers, then volumes, then
  networks; treat members already absent as done so a rerun after a partial
  apply completes; write a receipt under the Git common directory like reclaim.
- **Docker access.** A small module that lists containers (with state and
  labels, server-side label filter), volumes and networks and deletes exact IDs
  through the `docker` CLI argv pattern of `devpod-environment.ts:551-596`, with
  a named error when the listing exceeds its bound.
- **Reporting.** `workspace cleanup` gains leftover rows and unattributed-volume
  rows; `workspace cleanup --manifest --action leftover` writes the manifest.

### Test portfolio

| Row | Behavior | Obligation | Seam | Failure it catches |
| --- | --- | --- | --- | --- |
| T1 | gc forces only for ENOENT path plus stopped/not-found runtime; refuses running/unknown; path present with `ownerStatus: missing` is not forced; ordinary failure on a present checkout is not retried | add new | `devsy-mutation` tests with stubbed provider and fs | stuck records; forced delete of live work |
| T2 | attribution accepts the vanished in-scope stack; rejects missing `dev.containers.id`, sibling clone, symlinked or unmounted `trees`, live registration, running container, primary checkout | add new | pure attribution function over fixtures | deleting a live or foreign stack |
| T3 | removable set excludes explicitly named or foreign-mounted volumes and attached networks | add new | same | data loss in another stack |
| T4 | apply takes both provider locks in order, skips changed projects, honours daemon-ID mismatch, completes on rerun after partial apply, writes receipts | add new | apply with stubbed Docker module | partial or stale deletion |
| T5 | manifest kind isolation: hash binding works; reclaim, trim, select and `manifest.py` reject it; listing bound error | extend existing | manifest tests, skill `tests/worktree-reclaim/test-manifest.sh` | applying an unapproved or mis-typed set |

### Delegation map

Execution mode solo: the main session owns every slice.

| Workstream | Slices | Acceptance |
| --- | --- | --- |
| Reliability | S1, S2a, S2b | T1–T5, typecheck, Biome, Knip, build |
| Docs | S3 | docs policy check including the new guide |
| Delivery | S4, S5 | 0.3.0 installed; Klicker CI green; dogfood evidence |

### Slices

- **S1 — guarded gc fallback.** `src/core/devsy-mutation.ts` and tests. T1.
- **S2a — read-only leftover report.** New `src/core/docker-leftovers.ts`
  (Docker access and attribution); `src/core/workspace-cleanup.ts` rows. T2, T3.
- **S2b — leftover manifest and apply.** Manifest kind in
  `src/core/worktree-reclaim.ts` (or a sibling module if it keeps the file
  coherent), apply in `docker-leftovers.ts`, `src/cli.ts:720-735`,
  `src/commands/workspace.ts:83-104`, `src/core/agents-md.ts:334`,
  `src/core/ai-prompt.ts:154` and its test, AGENTS.md command surface,
  `.agents/skills/devrouter/SKILL.md`, `.agents/skills/worktree-reclaim/`
  (skill text and `manifest.py` rejection), CHANGELOG `[Unreleased]`, and a
  short addendum to ADR 0011 recording why leftovers use a separate manifest
  kind. T4, T5.
- **S3 — team cleanup guide.** New `docs/WORKTREE_CLEANUP.md`, added to
  `PRODUCT_DOCS`, the AGENTS.md authority list, `docs/README.md` and a README
  "Cleaning up worktrees" section. Contents: prerequisites (devrouter minimum,
  Docker, `gh`/`glab` auth for `--check-merged`, Python 3 for the skill) with a
  link to `docs/GETTING_STARTED.md` for install; run from each repository's
  primary checkout; the audit → dry run → hash approval → apply flow for
  `cleanup`, `trim`, `reclaim`, `gc` and `leftover`; reason and skip codes and
  how to unblock a kept tree (including `git worktree prune` for a
  vanished registration); the `worktrees` declarations; installing the
  `worktree-reclaim` skill and `fleet-audit.sh` for many repositories; where
  receipts live; what is permanent (volume data such as Postgres is lost;
  branches survive only on the forge); what is never deleted (primary checkout,
  registered worktrees, dirty or unmerged trees, unattributed, foreign and lone
  volumes, external volumes and networks); rollback by reinstalling the previous
  CLI; the forced upgrade when a repository raises its minimum.
- **S4 — release 0.3.0.** Release PR per AGENTS.md:270-279 and #129:
  `upgrade-prompts/0.3.0.md`, `devrouter.version` in the examples, skill and
  `ai-prompt` updates, changelog. Merge after CI, publish to npm, install
  globally, verify `devrouter -V`.
- **S5 — Klicker adoption and dogfood.** After the npm publish: raise the
  installer pin (`.github/scripts/install-devrouter.sh:9`) first in its own PR,
  because #6411's CI failed until #6416 had reached `v3`; then the minimum
  (`.devrouter.yml:24`), `.devcontainer/README.md:46,96`, the devrouter line in
  `CLAUDE.md`/`AGENTS.md`, and the environment-doctor skill mention. Dogfood:
  dry-run `gc`; apply only if it lists exactly `test-playwright-flakiness`;
  then generate the leftover manifest; apply only if it lists exactly
  `default-te-e1ec3`; confirm nothing of that checkout remains.

### Verification

Per slice: typecheck, Biome, focused vitest files and the skill shell tests
where touched. Before the PR: full unit suite, Knip, docs policy, build and
package smoke. PR text carries sanitized counts only, no local paths or branch
names.

### Delivery

devrouter: one feature PR (S1–S3, `enhance(workspace): …`) with one final
review over the integrated branch, then the release PR (S4). Klicker: the pin
PR, then the minimum PR (S5).

### Working context

Worktree `trees/cleanup-reliability-docs` on `rs/cleanup-reliability-docs` from
`origin/main` `00e4ada`.

## Progress

- [x] Rulings 2026-10-12: trim gate unchanged; leftover removal in scope; label
  collision stays on #130; audience is the engineering team via a docs link;
  release, Klicker bump and local dogfooding approved.
- [x] Planner pass (Fable, REVISE): separate manifest kind, guarded force,
  provenance-based attribution, new Docker access module, per-project skip and
  resumable apply, coupled CLI surfaces, 0.3.0, docs scope, exact dogfood
  selectors. All ten findings folded in.
- [x] Planner re-check (Fable, APPROVE); two minors folded in: separate
  next-step reasons for gc versus `git worktree prune`, and a fixed lock order.
  The dogfood checkout is already unregistered in Git (checked 2026-10-12).
- [ ] Plan approval.
- Next action: S1 after approval.

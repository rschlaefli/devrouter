# W2 — Workspace resource accounting (execution plan)

## Identity

- Roadmap: `docs/project/2026-08-16-workspace-resource-accounting-roadmap.md`.
- Repository: `/Users/rschlae/Git/personal/devrouter`.
- Branch: `rs/workspace-resource-accounting`, worktree
  `trees/rs-workspace-resource-accounting` (both created;
  `pnpm install --frozen-lockfile` exit 0).
- Base: `main` at `d86277e`, contains W1 merge `f6718c6`.
- PR target: `main`.
- Ceremony tier: **full path** — public `--json` contract change, a
  `schemaVersion` bump, executable code, a CLI flag, and tests.

## Goal

Extend the report-only `devrouter workspace cleanup` output with per-workspace
storage consumption, separating reclaimable from shared figures, behind an
opt-in flag.

## Non-goals

The roadmap's "Out of scope": no mutation entrypoint, no `--yes`, no deletion,
no CPU/memory/network metrics, no historical trends, and neither of the two
open cleanup-v1 concerns.

## Research

- `Evidence:` **This repository has zero managed workspace owner records.**
  `.git/devrouter/` does not exist, and `buildWorkspaceCleanupReport`
  (`src/core/workspace-cleanup.ts:986`) builds rows exclusively from
  `records = listWorkspaceOwnership(repoPath)` (`:996`, loop at `:1009`). So
  `workspace cleanup --repo .` reports `workspaces: []` here. The 14
  directories under `trees/` are plain Git worktrees, not managed workspaces.
- `Risk:` Two roadmap Check criteria are therefore vacuous against this
  repository as written — the `du`-agreement line (roadmap 167-169) and the
  Docker-absent line (roadmap 170-172). With zero rows, no collector ever
  executes, so a `PATH`-stripped run proves nothing.
- `Decision:` Both move into the existing fixture harness,
  `scripts/smoke-workspace-cleanup-report.sh`, which already builds a temp repo
  with a real linked worktree, a real owner record, and an isolated `$HOME`
  (`:26-66`). Same measurement strength, reproducible in CI, and it mutates
  nothing outside `mktemp -d`. See gate B1 for the alternative the user may
  prefer.
- `Evidence:` **A `blocks * 512` walk matches `du -sk` exactly; an
  apparent-size walk does not.** Measured on `trees/rs-workspace-cleanup-v1`
  (6519 files, 1351 dirs): `blocks*512` = 163780 KB against `du -sk` = 163780 KB
  (exact); `stat.size` sum = 147405 KB, **10.0% low** — it alone would fail the
  5% criterion. The matching walk uses `lstatSync`, accumulates `blocks * 512`,
  counts directory inodes' own blocks, dedups hardlinks on `${dev}:${ino}`, and
  does not descend symlinked directories.
- `Decision:` Node-API walk, not a `du` subprocess. It matches `du` exactly, and
  it keeps the default path structurally free of new subprocesses rather than
  relying on flag discipline.
- `Evidence:` **`docker inspect --size` works and yields both halves.** Docker
  Server 29.4.0; a real container reports
  `{"sizeRw":233472,"sizeRootFs":336293888}`. `SizeRw` is the writable layer
  (reclaimable); `SizeRootFs` includes shared image layers (not reclaimable).
  This positively resolves the roadmap's open Do-step-3 caveat — container
  consumption need not stay `unknown`.
- `Risk:` **Adding size keys to `SAFE_INSPECT_TEMPLATE` unconditionally breaks
  three hot paths.** Without `--size`, referencing `.SizeRw` is a hard failure,
  not a null: `template parsing error: ... map has no entry for key "SizeRw"`,
  non-zero exit. `inspectWorkspaceContainers()` throws on non-zero
  (`src/core/devpod-environment.ts:37-41`), and the callers are
  `devpod-exec.ts:55` (via `resolveRunningWorkspaceContainer`),
  `workspace-ensure.ts:109`, and `workspace-ensure.ts:175`.
- `Risk:` **Batch failure granularity.** `inspectWorkspaceContainers` runs one
  `docker inspect` over every container ID on the machine
  (`devpod-environment.ts:34`) and throws on any non-zero exit. One bad
  container would make consumption `unknown` for every row, violating "unknown
  at the smallest possible granularity". The file already solves this for the
  optional `Health` key with `{{with (index .State "Health")}}...{{else}}null{{end}}`
  (`:17`); the size keys get the same guard, so an absent key yields `null` and
  a per-row `unknown`.
- `Evidence:` **The cleanup smoke asserts an exact sorted allowlist of every
  subprocess call** for both the default and `--check-merged` runs
  (`:174-183`, `:197-215`), asserts `--yes` is absent from cleanup's help
  (`:217-220`), and its `git` stub allowlists only
  `DEVROUTER_SMOKE_FEATURE_PATH` with `*) exit 97` (`:102-123`). There is no
  `docker` stub — `$bin` holds `devpod`, `gh`, `glab`, `git` only (`:125`), so
  a flag-on scenario would otherwise reach the live daemon. The roadmap records
  none of this.
- `Evidence:` `schemaVersion` has exactly four touch points, all in
  `src/core/workspace-cleanup.ts` — literal types at `:70` and `:93`,
  constructions at `:963` and `:1045`. No other source, script, or test reads
  it; `workspace-gc` does not consume cleanup rows.
- `Evidence:` The command's flags are enumerated in three places that must stay
  current: `src/core/ai-prompt.ts:141`, `.agents/skills/devrouter/SKILL.md`, and
  `docs/knowledge/managed-environment-lifecycle.md:47`, plus `CLAUDE.md`'s
  supported command surface. `ai-prompt.test.ts:107` asserts a substring that
  survives appending a flag after `[--json]`.
- `Evidence:` The repository `dist/` is stale — it predates cleanup v1 and has
  no `workspace cleanup` command. Rebuild before any real-state verification.

## Decision gates

A1 (package selection), A2 (two separate figures), A3 (opt-in flag), and A4
(`schemaVersion` 1 → 2) are ruled in the roadmap and binding.

New rulings, vetoable by the user:

| Gate | Decision | Ruling |
| --- | --- | --- |
| B1 — acceptance venue | Where the `du`-agreement and Docker-absent evidence run, given zero owner records here | Fixture harness only. Ruled by the user on 2026-08-16 after being offered a live `workspace up --no-devpod` run in this repository as the alternative. The roadmap's Check wording "in this repository" is amended to "over two real worktrees"; the measurement strength is unchanged and the evidence becomes reproducible in CI. |
| B2 — flag name | The opt-in flag's spelling | `--measure-size`. An explicit verb signals the flag does work, unlike `--sizes`. |
| B3 — field shape | How the "two numbers" are carried | Four labelled fields, below. `reclaimable` is derived and propagates `unknown`, moving the roadmap's named data-loss decision from every consumer into one tested site. |
| B4 — walk implementation | Node API versus `du` subprocess | Node API, per the measurement above. |
| B5 — flag-off representation | `consumption: null` versus an absent key | Absent. The roadmap's Check says "absent or unknown" (line 164-165); an optional field reads literally and keeps the flag-off payload byte-identical to today's. |
| B6 — size query scope | Whether `--size` runs over every container on the machine | Two-phase: attribute with the existing template first, then re-inspect only the attributed IDs with `--size`. One discovery mechanism, cost bounded to containers that matter. |

## Contract

```ts
export type WorkspaceCleanupSize =
  | { status: "measured"; bytes: number }
  | { status: "unknown"; reason: string };

export type WorkspaceCleanupConsumption = {
  /** Reclaimable: worktree-local files only; shared Git object storage excluded. */
  worktree: WorkspaceCleanupSize;
  /** Reclaimable: writable layer of the workspace's own app container — the one
   *  `workspaceAppContainers()` attributes. Container filesystems only: named
   *  volumes are not measured, and neither are sibling services of the same
   *  compose project, which carry the workspace label but mount no worktree. */
  containerWritable: WorkspaceCleanupSize;
  /** NOT reclaimable: image layers shared with other containers and workspaces.
   *  These sums overlap across rows; never add them up. */
  imageShared: WorkspaceCleanupSize;
  /** Sum of every field labelled reclaimable above; unknown if any of them is. */
  reclaimable: WorkspaceCleanupSize;
};
```

Row gains `consumption?: WorkspaceCleanupConsumption` — the key is absent when
the flag is off. Report gains `measureSize: boolean`. Both `schemaVersion`
literals and both construction sites move to `2`.

Two invariants, each asserted:

- Every failure — Docker absent, non-zero exit, missing or malformed size value,
  walk timeout, unreadable directory — yields `{status: "unknown", reason}`. A
  timed-out walk **discards** its partial sum; a partial reads as "less to
  reclaim", the same data-loss mode as a zero.
- Zero attributed containers is a **measured `0`**, not `unknown`. The roadmap's
  unknown rule covers unavailable, slow, or malformed sources only; a workspace
  with no running containers genuinely consumes no container storage.

## Test portfolio

| Risk | Obligation | Seam | Distinct failure caught |
| --- | --- | --- | --- |
| Unknown silently becomes zero | add new | `workspace-cleanup.test.ts` | Docker unavailable, non-zero `docker inspect`, malformed size value, walk timeout, unreadable directory — one case each, all asserting `unknown`; each fails if its fallback reverts to `0` |
| Total misreports when a part is unknown | add new | same | `reclaimable` is `unknown` when either component is |
| Opt-in violated by a Node-API collector | add new | same | `measureSize: false` → injected collectors are never invoked and `consumption` is absent. The smoke's subprocess allowlist cannot catch a directory walk, so this is the only guard on A3 |
| Cross-workspace misattribution | add new | same | Two containers, one matching the row's worktree path; the other's bytes are excluded |
| Default path grows a subprocess | extend existing | `smoke-workspace-cleanup-report.sh` | The unchanged exact allowlists are the assertion |
| Measurement disagrees with reality | add new | same smoke, flag-on scenario | Reported worktree bytes vs `du -sk` beyond 5%, over two real worktrees |
| Docker absent still reports | add new | same smoke, failing `docker` stub | Container fields `unknown` while worktree bytes stay measured, report still complete |
| Hot-path container inspect regresses | none | — | Structural: default template and argv stay byte-identical; `devpod-exec.test.ts` and `workspace-ensure.test.ts` already cover those paths |

Obligation `none` for type declarations, output formatting, and flag wiring.

## Delegation Map

| Workstream | Slices | Owner | Handoff | Acceptance boundary |
| --- | --- | --- | --- | --- |
| Contract and plumbing | S1 | main | — | Public contract and schema bump; decision-heavy |
| Disk measurement | S2 | executor | S1's `WorkspaceCleanupSize` type | Bounded unit with a measured, exact acceptance check |
| Container measurement | S3 | main | S1 | Seam with three hot-path callers |
| Evidence and guidance | S4 | main | S1-S3 | Cross-cutting evidence and docs |

## Slices

### S1 — Contract, flag, and plumbing, every field unknown

- `Do:` Add the consumption types, bump both `schemaVersion` literals and both
  construction sites to `2`, add `measureSize` to `WorkspaceCleanupOptions`,
  register `--measure-size` in `src/cli.ts`, pass it through
  `src/commands/workspace.ts`, and extend both `--json` and
  `printWorkspaceCleanupReport` (`src/core/output.ts:17`). No collector exists
  yet: with the flag on, every field is
  `{status: "unknown", reason: "not collected"}`; with it off, `consumption` is
  absent.
- `Check:` `pnpm typecheck`, `pnpm test`, `pnpm build`, then
  `pnpm workspace:cleanup-smoke` — the existing exact allowlists must pass
  unchanged, which is the default-path-speed criterion. The Docker-absent
  criterion is trivially satisfied here (no collector exists) and is re-proven
  end-to-end in S4.
- `Route:` main. `Acceptance:` the four commands above.
- `Commit:` `feat(cleanup): add opt-in consumption contract to workspace cleanup`

### S2 — Bounded worktree disk collector

- `Do:` Add `measureWorktreeConsumption(worktreePath, deadlineMs)` using
  `lstatSync`, `blocks * 512`, directory-inode blocks, `${dev}:${ino}` hardlink
  dedup, and no symlink descent. Default deadline **10 s per worktree**, checked
  every 512 entries; on timeout or any read failure return `unknown` and discard
  the partial sum. Register it in `WorkspaceCleanupDependencies` and call it per
  row against `record.worktreePath` only.
- `Check:` new unit tests for success, timeout, and unreadable directory, each
  asserting `unknown` and each failing when the fallback is reverted to `0`;
  `pnpm test`.
- `Route:` executor. `Acceptance:` `pnpm typecheck && pnpm test`, plus a one-off
  comparison of the collector against `du -sk` on a real worktree.
- `Commit:` `feat(cleanup): measure worktree-local disk consumption`

### S3 — Container and image consumption

- `Do:` Parameterize `inspectWorkspaceContainers(options?: {withSize?: boolean; ids?: string[]})`
  in `src/core/devpod-environment.ts`: the size variant appends the two size
  keys to the template, read through `{{json (index . "SizeRw")}}` rather than
  the `{{with}}...{{else}}null{{end}}` guard this plan first specified, and
  passes `--size`. Corrected against live Docker during S3: `index` already
  degrades to `null` for a container inspected without `--size`, and unlike
  `{{with}}` it preserves a genuine zero — real container `a08091b5920a`
  reports `SizeRw: 0` against a 453787648-byte root, which the guard would have
  misreported as an absent value. The default template and argv
  stay byte-identical, so the three hot-path callers are untouched. Add a
  cleanup collector that attributes containers once with
  `workspaceAppContainers()` against each row's `record.worktreePath`, then
  re-inspects only the attributed IDs with sizes, summing `SizeRw` into
  `containerWritable` and `SizeRootFs - SizeRw` into `imageShared`. Register it
  in `WorkspaceCleanupDependencies`. Compute `reclaimable` with unknown
  propagation; a `null` size key yields a per-row `unknown`.
- `Check:` new unit tests for success, Docker unavailable, non-zero exit,
  malformed size value, attribution exclusion, and unknown propagation;
  `pnpm test`, `pnpm typecheck`.
- `Route:` main. `Acceptance:` the commands above.
- `Commit:` `feat(cleanup): report container and shared image consumption`

### S4 — Real-worktree evidence and guidance

- `Do:` Extend `scripts/smoke-workspace-cleanup-report.sh`. Ordering is binding:
  create the second worktree and its owner record **after** the existing no-flag
  and `--check-merged` scenarios have run, so both exact allowlists stay
  unchanged; otherwise the report's three git calls per worktree and the stub's
  `*) exit 97` break them. Then add a `docker` stub to `$bin`, extend the `git`
  stub and `hash_state` (`:127-144`) to cover the second worktree, and add two
  scenarios: one flag-on run asserting reported worktree bytes agree with
  `du -sk` within 5% for both worktrees, and one with the `docker` stub failing,
  asserting container fields are `unknown` while worktree bytes stay measured
  and the report is still complete. Keep the `--yes`-absent assertion. Document
  `--measure-size` in the four owning surfaces: `CLAUDE.md`'s command surface,
  `.agents/skills/devrouter/SKILL.md`, `src/core/ai-prompt.ts:141`, and
  `docs/knowledge/managed-environment-lifecycle.md:47` (a new consumption
  evidence class is a material semantic change under the repo's knowledge rule).
- `Check:` the full verification sequence — `pnpm check:docs-policy`,
  `pnpm check:knowledge`, `pnpm check`, `pnpm knip`, `pnpm typecheck`,
  `pnpm test`, `pnpm build`, `pnpm test:package`, `pnpm workspace:cleanup-smoke`.
- `Route:` main. `Acceptance:` the full sequence above, all exit 0.
- `Commit:` `test(cleanup): prove measured consumption against du and document the flag`

## Post-slice gates

S1, S2, and S3 are substantive implementation slices → `simplifier` on each
committed range. S1 and S3 cross a public-contract / shared-seam risk boundary
→ `slice-reviewer` in parallel on those two. Finish gate: one `final-reviewer`
over the integrated branch after the full sequence passes.

## Progress

- `2026-08-16`: Plan written after research and one read-only `planner` pass.
  Branch and worktree created from `main` at `d86277e`; no implementation
  commit yet. B1 ruled by the user: the roadmap's real-worktree Check criterion
  moves to the fixture harness, because this repository has no managed
  workspace owner records and creating them would mutate real workspace state
  for test convenience. The roadmap's Progress section is updated in S4.
- `2026-08-16`: S1–S3 committed. Two Contract corrections landed with S3, both
  forced by a live Docker probe over 187 real containers: the size template
  reads its keys through `index` rather than a `{{with}}` guard, and
  `containerWritable` now states the attribution boundary explicitly.
  **Open, for the user — attribution scope.** `workspaceAppContainers()`
  attributes only the container that bind-mounts the worktree, so a compose
  sibling is excluded even though it belongs to the workspace. Measured on a
  real workspace: `default-fe-625ea-app-1` is attributed, while its Postgres
  sibling `default-fe-625ea-postgres-1` (same compose project, same
  `working_dir` label, 466 MiB image) is not, understating that row's
  `imageShared` by roughly half. Widening to a compose-project predicate would
  capture it and stays exact, but it would introduce a second attribution
  definition alongside the one `ensure` and `exec` share, so it is deliberately
  deferred rather than folded into W2.
- `2026-08-16`: S3 gates passed. `slice-reviewer` returned DONE with no blocking
  findings across all five lenses, noting only that an impossible negative
  `SizeRw` would slip the guard; left unguarded as unreachable. `simplifier`
  returned two findings and both were applied: the container map is now one
  `Map` shape whose failure path is a fully keyed map of unknowns, which removed
  the `Map | {unavailable}` union, the `instanceof` branch, the duplicated
  unknown-pair construction, and the `NOT_ATTRIBUTED` constant.
- `2026-08-16`: S4 committed. The smoke harness gained a `docker` stub and a
  second real worktree, and its two new scenarios were mutation-probed rather
  than trusted for passing: a wrong `sizeRw`, an unsized fixture reaching the
  sized pass, a worktree shrunk after measurement, and a reachable daemon in the
  Docker-absent scenario each fail the run. Full verification sequence green.

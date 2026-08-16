# W2 — Workspace resource accounting

## Identity

- Date: 2026-08-16.
- Parent roadmap: [Devrouter roadmap](./2026-02-07-devrouter-roadmap.md).
- Predecessor package: [W1 — Packaged CLI command and release proof](./2026-08-15-packaged-cli-command-release-proof-roadmap.md), merged as `f6718c6`.
- Owning primitive: the report-only `devrouter workspace cleanup` surface delivered by [Workspace cleanup v1](./2026-08-12-workspace-cleanup-v1-plan.md).
- Repository: `/Users/rschlae/Git/personal/devrouter`.
- Base: `main`, including W1 merge `f6718c6`.
- Branch and worktree to create: `rs/workspace-resource-accounting` at
  `trees/rs-workspace-resource-accounting`. Do not reuse an existing worktree;
  every listed worktree belongs to earlier packages.
- Pull request target: `main`. No PR exists yet.
- Audience: junior dev/agent picking this up without session context. Read
  `AGENTS.md`, the cleanup v1 plan's report contract, and
  `src/core/workspace-cleanup.ts` before writing the execution plan.

## How to work on this

1. Run Git and GitHub commands on the host, never inside a devcontainer. Run
   Node/pnpm checks with Node 24 and pnpm 11.6.0, as `package.json` declares.
2. Create the branch and worktree from `main` after confirming it contains
   `f6718c6`. Install with `pnpm install --frozen-lockfile`.
3. The verification loop is the repository's standard sequence:

   ```sh
   pnpm check:docs-policy
   pnpm check:knowledge
   pnpm check
   pnpm knip
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm test:package
   ```

4. Exercise the report against this repository's real worktrees, which is a
   read-only operation:
   `node dist/devrouter.js workspace cleanup --repo . --json`.

## Current state

| Item | State | Evidence |
| --- | --- | --- |
| Cleanup report core | delivered, report-only | `src/core/workspace-cleanup.ts`; `WorkspaceCleanupReport` at line 92 carries `schemaVersion: 1`. |
| Cleanup command surface | no mutation path | `src/cli.ts:532` registers only `--repo`, `--inactive-for`, `--check-merged`, and `--json`; `gc` and `down` remain the sole mutators. |
| Per-workspace evidence today | state and recency only | Report rows carry ownership, provider registration, runtime, checkout, activity, integration, and suggestions — no consumption field of any kind. |
| Resource measurement | absent | No disk, byte, size, image, volume, CPU, or memory query exists in `src/`; the only `docker volume ls` is fixture teardown at `scripts/smoke-workspace-lifecycle.sh:92`. |
| DevPod size data | unavailable from the provider | `DevpodWorkspace` (`src/core/devpod-workspaces.ts:4`) exposes `id`, `source.localFolder`, and optional `lastUsed` only. Sizes must come from Docker. |
| Container attribution seam | exists | `inspectWorkspaceContainers()` (`src/core/devpod-environment.ts:19`) already runs `docker ps -a` plus a safe-template `docker inspect`; `workspaceAppContainers()` attributes containers by the compose `working_dir` label and a bind mount matching the repo path. |
| Dependency-injection seam | exists | `WorkspaceCleanupDependencies` (`src/core/workspace-cleanup.ts:122`) injects every evidence reader, which is how the existing 705-line test suite avoids live Docker. |
| Measured baseline on this machine | 2026-08-16 | `trees/rs-packaged-cli-command-proof` 160M and `trees/workspace-route-recovery` 159M; combined `du -c` totals 319M, and a sampled `node_modules` file reports `links=1`. No cross-worktree hardlink sharing is present here. |

## Non-negotiables

These are rulings made while writing this roadmap. They are binding; raise new
evidence rather than re-litigating them.

- **Report-only.** W2 adds no mutation entrypoint, no `--yes`, and no deletion.
  It inherits cleanup v1's safety model, where `gc` and `down` are the only
  callers that destroy anything.
- **Two numbers, never one.** Report measured consumption and reclaimable
  consumption as separate fields. A single conflated "size" invites deleting a
  workspace to recover space that shared resources will not return.
- **Unknown beats zero.** When Docker, DevPod, or a directory walk is
  unavailable, slow, or malformed, the affected field is `unknown` at the
  smallest possible granularity — never `0`. A zero reads as "nothing to
  reclaim" and is the one wrong answer that causes data loss. This matches the
  v1 rule that missing sources remain unknown at the smallest affected field.
- **Diagnose, never require.** devrouter does not install or demand Docker,
  DevPod, Node, pnpm, or mkcert. A machine without Docker must still get a
  complete report with unknown consumption fields.
- **Size collection is opt-in.** Directory walks and container size queries are
  expensive; the default `workspace cleanup` invocation must stay as fast as it
  is today. Gate collection behind an explicit flag.
- No secret or private-URL output, consistent with v1.

The report's `schemaVersion` is a consumer-visible contract, so its bump is
recorded as gate A4 below rather than as a non-negotiable.

## Known traps

- **Assuming pnpm hardlinks make per-worktree `du` double-count.** Symptom: the
  implementation "corrects" for sharing that is not there and under-reports by
  a large factor. Cause: pnpm normally hardlinks from a shared store, so the
  assumption is reasonable and wrong here. Remedy: this was measured on
  2026-08-16 — sampled files report `links=1` and a combined `du -c` of two
  worktrees equals the sum of their individual sizes. Measure before modelling,
  and if `links > 1` appears on another machine, the used-versus-reclaimable
  split in the report contract already carries the distinction.
- **Docker image layers genuinely are shared.** Symptom: summing per-container
  image sizes across workspaces produces a reclaim figure several times larger
  than what deletion frees. Cause: layers are shared between images and
  containers. Remedy: attribute image size as a shared, separately-labelled
  figure; never fold it into the reclaimable total.
- **`docker inspect` returns no size fields by default.** Symptom: the size key
  is silently absent and the field lands as `0`. Cause: size reporting requires
  an explicit flag and costs a filesystem walk per container. Remedy: verify
  the exact flag against the installed Docker before relying on it, and treat
  an absent field as `unknown` rather than `0` — see the non-negotiable above.
- **A directory walk over many worktrees is slow.** Symptom: `workspace
  cleanup` appears to hang on a machine with a dozen-plus worktrees. Cause:
  each walk is a full recursive traversal, and node_modules dominates. Remedy:
  bound each walk with a timeout, report a timed-out walk as `unknown`, and
  keep collection behind the opt-in flag.
- **Linked worktrees share the Git common directory.** Symptom: reclaim
  estimates disagree with what deletion actually frees. Cause: object storage
  lives in the primary checkout, not the linked worktree. Remedy: a worktree
  directory walk measures worktree-local files, which is the correct reclaim
  figure; do not attempt to apportion shared object storage.

## Work items

### W2 — Workspace resource accounting

**Problem**

`devrouter workspace cleanup` reports which managed workspaces are stale but
never what they cost. With more than a dozen worktrees on a development
machine, the operator cannot answer "how much do I get back if I reclaim this"
without leaving the tool, which is the question the report exists to serve.

**Do**

1. Add consumption fields to the cleanup row and report types in
   `src/core/workspace-cleanup.ts`, following the existing orthogonal-field
   rule: separate measured consumption from reclaimable consumption, and keep
   each source's availability explicit. Move `schemaVersion` to `2`.
2. Collect worktree-local consumption with a bounded directory walk. Whether
   this shells out or uses Node APIs is your judgment; the binding parts are
   the timeout, the `unknown`-on-failure behavior, and that it measures the
   worktree path only.
3. Collect container consumption through the existing attribution seam rather
   than a new one — `inspectWorkspaceContainers()` and `workspaceAppContainers()`
   in `src/core/devpod-environment.ts` already map containers to a repo path.
   Extend that path; do not write a second container-discovery mechanism. That
   seam's `SAFE_INSPECT_TEMPLATE` has a fixed field list with no size keys, and
   Docker emits size fields only under an explicit flag: confirm the exact flag
   against the installed Docker before relying on it. If it does not
   materialize, container consumption stays `unknown` — do not add a second
   discovery mechanism to work around it.
4. Report image consumption as a separate shared figure, labelled so a reader
   cannot mistake it for reclaimable space.
5. Add every new collector to `WorkspaceCleanupDependencies`
   (`src/core/workspace-cleanup.ts:122`) as an injectable reader, matching how
   the existing suite tests without live Docker.
6. Extend `--json` and human output together. Human output labels the same
   concepts the JSON carries, per the v1 report contract.
7. Gate collection behind the opt-in flag in `src/cli.ts` and document it in
   the owning guidance surfaces only — do not duplicate the report contract
   into product manuals.

**Check**

The full verification sequence in "How to work on this" passes, and
additionally:

- new unit tests in `src/core/__tests__/workspace-cleanup.test.ts` cover a
  successful measurement, an unavailable Docker daemon, a timed-out walk, and a
  malformed size value — the last three asserting `unknown`, never `0`;
- each new test fails when its collector's fallback is reverted to a zero
  default;
- `node dist/devrouter.js workspace cleanup --repo . --json` without the opt-in
  flag produces output whose consumption fields are absent or unknown, and
  completes as fast as the current command;
- the same command with the flag reports non-zero worktree consumption for at
  least two real worktrees in this repository, and each figure agrees with
  `du -sk <worktree-path>` within 5%;
- `scripts/smoke-workspace-cleanup-report.sh` still proves no state change; and
- the command still produces a complete report with `docker` removed from
  `PATH`, with unknown rather than zero consumption.

**Depends on / GATED on**

Nothing. W1 is merged and this package touches no W1 surface. No Docker,
DevPod, TLS, publication, or release authority is required — Docker is read
from when present and reported unknown when absent.

**Priority**

P1, and the only approved package. Approved by the user on 2026-08-16 after
reviewing the cleanup v1 evidence; do not re-litigate the selection.

## Out of scope

- Any destructive action, reclaim execution, or new mutation entrypoint.
- CPU, memory, or network-throughput metrics. This package measures storage.
- Historical trends, time series, or stored snapshots. The report stays a
  point-in-time read.
- The two open concerns recorded against cleanup v1 — the live report-only
  `--check-merged` forge trial, whose evidence is synthetic-only, and the macOS
  `/proc` process-test skip. Both remain tracked on the parent roadmap and were
  explicitly excluded from this package on 2026-08-16.

## Decision gates

| Gate | Decision | Ruling |
| --- | --- | --- |
| A1 — next package | Whether to prioritize workspace resource accounting over finishing cleanup v1's open evidence, a combined milestone, or `devrouter app env` | Approved by the user on 2026-08-16 after reviewing the cleanup v1 finish state; do not re-litigate. |
| A2 — reported figures | Whether to report one consumption number or separate measured and reclaimable figures | Ruled while writing this roadmap: two separate fields, because shared Docker layers make a single number an invitation to delete for space that will not be returned. Vetoable by the user; binding on the junior otherwise. |
| A3 — collection default | Whether size collection runs by default or behind a flag | Ruled while writing this roadmap: opt-in flag, so the default report keeps its current speed. Vetoable by the user; binding on the junior otherwise. |
| A4 — report schema version | Whether adding consumption fields bumps `schemaVersion` from `1` to `2` | Ruled while writing this roadmap: bump to `2`, because agent consumers parse `--json` and additive fields still change the contract they read. Vetoable by the user; binding on the junior otherwise. |

## Review and evidence expectations

At the W2 boundary, provide: the branch and PR targeting `main`; the exact
changed-path list; complete output and exit status for the verification
sequence; the real-worktree report output with and without the opt-in flag;
evidence of the Docker-absent run; confirmation that no destructive action,
publication, or release occurred; and an appended dated Progress entry below.

## Progress

- `2026-08-16`: Package selected and specified. W1 reconciliation completed
  first; no implementation branch, worktree, PR, or code change exists for W2
  at specification time.

# Cleaning up worktrees

Agent sessions and devcontainer workflows leave many Git worktrees behind. Each
one holds its own dependencies and build output, and a devcontainer worktree
also keeps Docker containers and volumes. This guide shows how to find what is
safe to remove and remove only that.

Every command here is report-only or a dry run by default. Nothing is removed
until a person approves an exact list by its SHA-256 and the command runs with
`--yes`.

## Before you start

- Install the devrouter CLI and run `devrouter setup` once; see
  [Getting started](./GETTING_STARTED.md). A repository can require a minimum
  devrouter version in `.devrouter.yml`; `devrouter -V --repo .` shows whether
  your installed CLI meets it. An older CLI warns, and it fails when the
  configuration uses keys it does not know yet, such as `worktrees`.
- Docker must be running for the Docker leftover report.
- `gh` (GitHub) or `glab` (GitLab) must be logged in for `--check-merged`,
  which is how devrouter proves a branch was merged.
- Optional: the agent skills, including `worktree-reclaim`, install with
  `npx skills add rschlaefli/devrouter -g`. The skill needs Python 3 and can
  audit repositories that do not use devrouter.

Run every command from the repository's primary checkout, not from inside a
worktree. `--repo <path>` points at another repository.

## What each command does

| Command | Removes | Needs approval |
| --- | --- | --- |
| `devrouter workspace cleanup` | Nothing. Reports every worktree with a verdict and reason codes. | No |
| `devrouter workspace trim` | Declared rebuildable folders (for example `node_modules`, `.next`) inside quiet, clean worktrees. The worktree and branch stay. | Manifest SHA-256 |
| `devrouter workspace reclaim` | Whole worktrees whose pull or merge request is merged, plus their branch and any devrouter runtime. | Manifest SHA-256 |
| `devrouter workspace gc` | Devrouter records, routes and provider registrations of worktrees whose folder is already gone. | `--yes` after reading the dry run |
| `devrouter workspace leftover` | Docker containers, volumes and networks of devcontainer stacks whose worktree folder is already gone. | Manifest SHA-256 |

## The normal flow

1. **Audit.** Read the report first:

   ```bash
   devrouter workspace cleanup --all-worktrees --check-merged
   ```

   Each worktree gets `RECLAIM` (safe to remove), `KEEP` (with reason codes) or
   `PRUNE` (the folder is gone but Git still registers it). The report also
   lists Docker leftovers of deleted worktrees.

2. **Write a manifest.** Pick one action and write its exact candidate list:

   ```bash
   devrouter workspace cleanup --all-worktrees --check-merged --manifest --output reclaim.json
   devrouter workspace cleanup --all-worktrees --manifest --action trim --output trim.json
   devrouter workspace cleanup --manifest --action leftover --output leftover.json
   ```

   The command prints the file's SHA-256. Open the file and read it: every
   entry is something that will be removed.

3. **Dry run with the approved hash.** Without `--yes` nothing changes:

   ```bash
   devrouter workspace reclaim --manifest reclaim.json --sha256 <hash>
   ```

   Use `trim` or `leftover` in place of `reclaim` for the other manifests.

4. **Apply.** Add `--yes`. Each target is checked again immediately before it
   is removed. A target that changed since the audit is skipped with a code,
   and the others continue.

5. **Clean up after vanished folders.** When a worktree folder was deleted by
   hand, run `devrouter workspace gc` (dry run), then `devrouter workspace gc
   --yes` to remove its devrouter record and provider registration. If Git
   still lists the folder, `git worktree prune` removes that registration.
   Only then can its Docker stack be removed with `workspace leftover`.

Run reclaim before trim. Trimming touches a worktree, so a tree that was just
trimmed looks active and reclaim waits until it is quiet again.

A manifest expires after 24 hours (`--max-age`). Write a new one rather than
applying an old one.

## Why a worktree is kept

`KEEP` rows carry stable reason codes. Fix the cause in the worktree, then run
the audit again.

| Code | Meaning | How to unblock |
| --- | --- | --- |
| `dirty` | Tracked files changed | Commit, push or discard the changes |
| `untracked` | Untracked files exist | Commit them, move them elsewhere, or delete them |
| `ignored-state` | Ignored files that are not known to be rebuildable | Move them out, or declare them in `worktrees.disposable` if they are truly rebuildable |
| `detached` | No branch is checked out | Check out a branch or remove the worktree yourself |
| `submodule` | Initialized submodules may hold unpushed commits | Check and push the submodules |
| `operation-in-progress` | A merge, rebase or similar is unfinished | Finish or abort it |
| `index-lock` | Another Git process may be writing | Wait, or remove a stale `index.lock` after checking |
| `locked` | `git worktree lock` is set | Unlock it if the lock is no longer needed |
| `runtime-present` | A devrouter, DevPod or Devsy runtime still uses the path | Stop it with `devrouter stop`, or remove it with `devrouter workspace down` |
| `no-change`, `change-open`, `change-closed` | No merged pull or merge request for the branch | Merge it, or decide by hand |
| `head-beyond-merge` | Commits were added after the merge | Push or discard them |
| `forge-unavailable`, `forge-not-checked` | The merge state could not be read | Log in to `gh` or `glab` and add `--check-merged` |
| `primary` | The primary checkout | Never a target |

Trim follows the same rules except for merge state: it never touches a
worktree with changes, untracked files, a detached HEAD or undeclared ignored
files, even though it removes only rebuildable folders.

## Declaring rebuildable folders

A repository declares what trim may remove, and which extra ignored folders
never block reclaim, in `.devrouter.yml`:

```yaml
worktrees:
  disposable: ['**/.docusaurus']
  trim: ['**/node_modules', '**/.next', '**/.turbo']
```

List only folders that a fresh install or build fully recreates. Never list
folders that hold notes, uploads or other local work.

## Docker leftovers

A devcontainer worktree runs as a Docker Compose stack. Deleting the worktree
folder does not delete the stack, and removing the provider registration does
not delete it either. The report lists a stack as a leftover only when all of
these hold:

- all of its containers name the same worktree folder below `<repo>/trees/`,
  at least one of them was created by DevPod or Devsy, and that folder no
  longer exists;
- the missing folder is not inside another worktree that still exists;
- no Git worktree, devrouter record or provider registration still names that
  folder (otherwise the row says which command to run first);
- every container of the stack is stopped.

`workspace leftover` removes the stack's containers, then its volumes, then its
networks. A volume is removed only when no other container uses it and either
its name starts with the stack's project name or it is an anonymous volume
that only this stack mounted. Every removed volume is listed in the manifest,
and its data is gone afterwards.

Volumes that no remaining container ties to a worktree are listed as
unattributed with `--json` and never removed by devrouter. Remove one yourself
with `docker volume rm <name>` once you know what it held.

## What devrouter never deletes

- The primary checkout, and any worktree that is registered and not `RECLAIM`.
- Worktrees with changes, untracked files, unmerged branches or any other
  `KEEP` reason.
- Docker volumes and networks it cannot tie to a deleted worktree of this
  repository, explicitly named volumes, volumes another stack uses, and
  external volumes and networks.
- Anything not listed in the approved manifest.

## What removal means

Removal is permanent. A reclaimed worktree's branch survives only on the
forge, so devrouter requires it to be merged first. Data in removed Docker
volumes, such as a local Postgres database, is gone. There is no undo, and a
dry run is the only preview.

Each applied target writes a receipt below the repository's Git directory
(`.git/worktree-reclaim/receipts/` and `.git/devrouter-leftovers/receipts/`),
named by the manifest hash. A rerun of the same manifest reports finished
targets as `already-done` and completes a target that stopped halfway.

## Many repositories

The `worktree-reclaim` skill includes `fleet-audit.sh`, which audits every
repository under a folder and writes one manifest for all of them. Each
repository's removal still goes through the same approval and checks.

## Going back to an earlier version

If a new release misbehaves, install the previous one with
`npm install -g @devrouter/cli@<version>`. The older CLI warns about a
repository that requires a newer version, and fails on configuration keys it
does not know.

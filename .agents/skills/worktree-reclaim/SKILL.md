---
name: worktree-reclaim
description: Audit and safely remove finished Git worktrees across one or many repositories, with or without devrouter. Proves each worktree's work is recoverable elsewhere (newest same-repository PR/MR merged, tree clean, nothing unshipped, no runtime bound) before proposing removal, and applies only an approved, hash-bound manifest. Use when worktrees pile up from agent sessions, devcontainers, DevPod or Devsy, when disk fills with worktree copies, or when a user asks which worktrees are safe to delete.
user-invocable: true
---

# Worktree reclaim

Agent sessions and devcontainer workflows leave many worktrees behind, each
with its own dependencies and build output. Leaving them costs disk.
Clearing them carelessly costs someone's unpushed work.

The job is one judgement per worktree: is every piece of this recoverable from
somewhere else? That judgement is deterministic, so `scripts/` makes it. Do not
re-derive it by hand.

## Rules

- Run the scripts. Do not improvise `git worktree remove`, `rm -rf` or
  runtime deletion commands. Every obvious check is wrong somewhere; read
  `references/pitfalls.md` before changing the classifier or doubting a
  verdict.
- Audits are read-only. Removing anything requires the user's approval of the
  exact targets, given as a manifest SHA-256 or an exact path list.
- A verdict is stale once read. `reclaim.sh` and `apply-manifest.sh`
  re-classify each target immediately before removing it.
- Never delete a runtime. A tree with devrouter, DevPod or Devsy state stays
  KEEP (`runtime-present`). devrouter owns those resources and tears them down
  itself.
- If a script is wrong, fix the script, so the fix outlasts the conversation.

## Requirements

`bash` (3.2 or newer), `git`, `python3`, and the forge CLI for each origin:
`gh` for GitHub, `glab` plus `jq` for GitLab. A missing or failing CLI keeps
every affected row (`forge-unavailable`). `devrouter`, `devpod` and `devsy` are
optional; when present they are read for runtime evidence only.

## Workflow

**1. Audit one repository.**

```bash
scripts/audit.sh [repo-path]        # human table
scripts/audit.sh [repo-path] --tsv  # VERDICT, path, branch, codes, reason
```

| Verdict | Meaning | Action |
| --- | --- | --- |
| `RECLAIM` | Newest same-repository change merged, tree clean, HEAD at or behind the merged head, no runtime bound | Propose exact removal |
| `KEEP` | At least one reason code applies | Report the codes; never remove |
| `PRUNE` | The registered folder is gone | Report; `git worktree prune` needs its own approval |

KEEP is the default whenever a fact cannot be established. An unnecessary KEEP
costs disk. A wrong RECLAIM costs work that exists nowhere else.

**2. Reclaim approved targets.**

```bash
scripts/reclaim.sh <worktree-path>         # dry run: prints the plan
scripts/reclaim.sh <worktree-path> --yes   # after approval
```

It refuses anything that is not RECLAIM, runs `git worktree remove` without
`--force`, then `git branch -D`. It never runs a repository-wide prune.

**3. Bring KEEP rows to the user** as a table with the reason per row, not
bare paths. A closed-unmerged change or work that landed by another route needs
a person to decide.

## Reason codes

Codes are stable machine values shared with devrouter. Reason text is free.

| Code | Meaning |
| --- | --- |
| `primary` | The primary checkout, never a target |
| `detached` | Detached or unreadable HEAD |
| `locked` | `git worktree lock` is set |
| `index-lock` | An `index.lock` exists; another Git process may be writing |
| `operation-in-progress` | Merge, rebase, cherry-pick, revert or bisect unfinished |
| `submodule` | Initialized submodules, which may hold unpushed commits |
| `dirty` | Tracked changes |
| `untracked` | Untracked files |
| `ignored-state` | Ignored paths outside the disposable list |
| `git-error` | A Git check failed, so safety cannot be proven |
| `runtime-present` | devrouter, DevPod or Devsy state names this exact path, or a runtime list failed |
| `forge-unavailable` | Forge CLI missing, unknown forge, or repeated lookup failure |
| `no-change` | No same-repository PR/MR for the branch |
| `change-open` | The newest change is open |
| `change-closed` | The newest change closed without merging |
| `head-beyond-merge` | Local HEAD is not at or behind the merged head, or that head is unknown |
| `active` | Fleet audit only: an agent session used the tree inside the window, or session evidence is unreadable |

For `runtime-present`, suggest devrouter: `devrouter workspace down` for a
managed tree, or `devrouter workspace reclaim` with a manifest where the
installed devrouter provides it.

### Disposable ignored paths

Common reproducible caches and build outputs (`node_modules`, `dist`, `.next`,
`.turbo`, `*.tsbuildinfo` and similar) and empty ignored files do not block
removal. Everything else ignored is `ignored-state`. A repository can name more
disposable paths, one pattern per line, in the uncommitted file
`<git-common-dir>/info/worktree-reclaim-disposable`:

- Patterns are relative to the worktree root, with `/` as separator.
- `*` matches within one segment; `**` matches zero or more segments.
- A pattern also covers everything beneath a match.
- Absolute patterns and `..` are rejected.

Lines in the earlier `*/path/` syntax still work and produce a note asking for
the `**/path` form. Add a pattern only after proving the path is reproducible
and holds no user-owned state.

## Fleet sweep and manifests

`scripts/fleet-audit.sh` runs the same classifier across repositories and adds
an agent-session signal. It is report-only:

```bash
scripts/fleet-audit.sh <repo>...                       # named repositories
scripts/fleet-audit.sh --discover <root> --active-within 7d
scripts/fleet-audit.sh <repo> --size --json            # sizes, machine-readable
scripts/fleet-audit.sh --discover <root> --all-history --manifest > candidates.json
```

Discovery starts from each repository's `git worktree list`; session traces
only annotate rows. `SAFE-TO-PURGE` means RECLAIM and no Codex or Claude Code
session used the tree inside `--active-within` (default 24h). `HOLD` means a
session did, or the session signal is unavailable. The signal reads only
`cwd`/`workdir` fields and file times, never conversation content.
`--all-history` scans every session file instead of bounding old ones.

`--manifest` emits the `SAFE-TO-PURGE` rows as a canonical JSON manifest
(`worktree-reclaim-manifest`, version 1). Each candidate binds its repository,
path, branch ref, HEAD, Git common dir and worktree Git dir.

```bash
python3 scripts/manifest.py inspect candidates.json
python3 scripts/manifest.py hash candidates.json
python3 scripts/manifest.py select candidates.json --expected-sha256 <sha> --id <id>... > subset.json
scripts/apply-manifest.sh subset.json --sha256 <approved-sha>          # dry run
scripts/apply-manifest.sh subset.json --sha256 <approved-sha> --yes    # after approval
```

Approval names the final manifest's SHA-256. Pass that exact file; never
rebuild the list from paths or globs. Before any removal, `apply-manifest.sh`
validates the schema, the hash and the 24-hour maximum age, rebuilds session
evidence, and dry-runs every target. One stale target aborts the batch. It then
removes targets one at a time, re-checking each.

After each removed target it writes a receipt under
`<git-common-dir>/worktree-reclaim/receipts/<sha256>/<id>.json`. Re-running the
same manifest after an interruption reports receipted targets as done. A
target that vanished without a receipt stays a failure.

There is no transaction across targets. A target that changed after preflight
fails closed, so a run may remove fewer than approved; completed removals are
not rolled back.

## With devrouter

When `devrouter workspace reclaim --help` succeeds, `apply-manifest.sh` hands
the manifest to `devrouter workspace reclaim` and passes
`scripts/session-veto.sh` as its per-target veto. devrouter then tears down
managed runtimes in order. Set `WORKTREE_RECLAIM_NO_DEVROUTER=1` to force this
skill's own path.

`scripts/session-veto.sh <worktree-path>` exits 0 when no session used the path
inside `WORKTREE_RECLAIM_ACTIVE_WITHIN` (default 24h), 1 when one did, and 2
when evidence is unreadable.

Trim manifests (removing selected cache paths inside a kept tree) belong to
`devrouter workspace trim`. This skill refuses them and has no trim of its own.

## Reporting back

Lead with what changed and what is left:

```
Reclaimed 4 worktrees (~12 GB).
Kept 20: 6 change-open, 3 dirty or untracked, 2 runtime-present.
Needs your call: <branch> — change closed unmerged, 2 untracked files.
```

Then mention what the audit noticed but does not own: repository stashes, which
every worktree shares, and DevPod or Devsy workspaces whose source folder no
longer exists.

## Configuration

| Variable | Effect |
| --- | --- |
| `WORKTREE_RECLAIM_FORGE` | `github` or `gitlab` instead of detecting from `origin` |
| `WORKTREE_RECLAIM_GITLAB_HOSTS` | Space-separated self-hosted GitLab host names |
| `WORKTREE_RECLAIM_PR_CACHE_TTL` | Seconds to reuse the bulk GitHub listing (default 600; 0 disables) |
| `WORKTREE_RECLAIM_DEVROUTER_HOME` | devrouter state folder (default `~/.config/devrouter`) |
| `WORKTREE_RECLAIM_CODEX_SESSIONS_DIR`, `WORKTREE_RECLAIM_CLAUDE_PROJECTS_DIR` | Session stores to read |
| `WORKTREE_RECLAIM_ACTIVE_WITHIN` | Window for `session-veto.sh` |
| `WORKTREE_RECLAIM_NO_DEVROUTER` | `1` keeps manifest apply inside this skill |

## Scope and tests

Only worktrees registered with `git worktree list` are in scope. Sibling clones
and stray folders are not.

From the devrouter repository root, `pnpm test:skills` runs:

- `tests/worktree-reclaim/run-corpus.sh`, every reason code and edge case under
  GitHub, bulk GitHub and GitLab, from `tests/worktree-safety/`;
- `tests/worktree-reclaim/test-reclaim.sh` for retries, caching, session modes
  and the veto;
- `tests/worktree-reclaim/test-manifest.sh` for hashing, selection, freshness,
  batch preflight, scoped apply and receipts.

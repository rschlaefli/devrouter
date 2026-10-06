# Why the obvious checks are wrong

Each of these was a real false verdict caught while running the classifier against live worktrees. They are the reason the classifier looks more paranoid than you'd expect.

## `git stash list` cannot attribute a stash to a worktree

Stashes live in the **main repo's `refs/stash`** and are shared by every linked worktree. `git stash list` returns identical entries no matter which worktree you run it from.

Using it as a per-worktree blocker marks *every* worktree as unsafe — a check that never discriminates is worse than no check, because it looks like diligence while telling you nothing. Report stashes once at repo level and move on.

A common source of noise: `lint-staged automatic backup` entries left behind by interrupted pre-commit hooks. They're junk, but they're still not yours to delete silently.

## Squash merges destroy ancestry, so `git branch --merged` lies

Many repositories squash-merge PRs. The squash commit is a brand-new commit that shares no ancestry with the branch's commits, so:

- `git branch --merged main` will **not** list a squash-merged branch.
- `git merge-base --is-ancestor <branch> main` returns false for fully-merged work.
- `git branch -d` refuses with "not fully merged".

Ask the forge (`gh pr list` on GitHub or `glab api` against the matching GitLab project) instead of walking the graph. This is why `reclaim.sh` uses `git branch -D` — `-d` is unusable for squash merges, and the safety comes from the forge check rather than from git's own merge test.

## A missing upstream does not mean "never pushed"

Forges auto-delete the remote branch on merge. The local branch then loses its upstream, and `git rev-parse @{upstream}` fails — which naively reads as "this was never shared, keep it."

That's backwards: the missing upstream is *evidence the merge completed*. The classifier ignores upstream tracking and asks the forge instead.

## "Merged" is not the same as "everything local shipped"

A worktree can sit on a merged branch and still hold commits added *after* the merge, which would vanish with it. Comparing local `HEAD` to the PR's `headRefOid` settles it, and works despite squashing:

- `local == pr_head` → identical, safe.
- `local` is an **ancestor** of `pr_head` → local is merely behind, safe.
- otherwise → diverged, keep it and let a human look.

A rebased local branch that is a *superset* of the PR head is the usual way this happens.

## Ordinary `git status` hides ignored local work

`git status --porcelain --untracked-files=all` reports tracked and untracked changes, but it deliberately omits ignored paths. Those paths are often disposable caches, but they can also be local databases, uploads, generated credentials, or task records such as `project/_local/`.

The classifier therefore reads status once with `--untracked-files=all --ignored=matching`. It allowlists only common reproducible dependency caches and build output. Every other ignored path is `ignored-state`, with examples in the reason. Never expand the allowlist merely to make a live row green; first prove that the path is reproducible and contains no user-owned state.

## Conversation history is an activity signal, not the inventory

Codex and Claude Code metadata can show that a task used a worktree, but not every worktree was created by a conversation and old metadata may be absent. Fleet discovery must start from each repository's `git worktree list`, then annotate rows with any matching session evidence. Reversing that relationship silently omits precisely the old, untraced worktrees a cleanup sweep is meant to find.

The default scan bounds old work to first-line Codex metadata and the first 100 lines of each project's newest old Claude Code session. Use `--all-history` when going further back matters; it scans every Codex and Claude Code session, including Claude subagent logs, for `cwd`/`workdir` fields but still does not index conversation content. A missing trace is never evidence of inactivity by itself.

## Runtimes belong to the tool that created them

A running DevPod holds the worktree path, and routes outlive the container that served them. Teardown order matters, and a DevPod matched by a guessed name can be an unrelated environment. This skill therefore deletes no runtime at all: any devrouter, DevPod or Devsy state that names the exact path is `runtime-present`, and devrouter tears it down in order. A runtime list that fails also yields `runtime-present`, because an unreadable inventory cannot prove the tree unbound.

## Several changes for one branch

A branch name can carry several PRs or MRs: an old merged one and a newer open one, or one from a fork. Taking the first listed row lets an old merge outvote open work. Both lookups therefore ignore changes from forks and let the highest-numbered remaining change decide.

## Reused branch names across forge changes (known limitation)

Both forge lookups match by source branch. If a generic name (`patch-1`, `main`) were reused across unrelated PRs or MRs, the newest merged change could authorise a delete of a different branch that happens to share the name.

In practice this is guarded on two sides: the head-SHA divergence check refuses to reclaim unless local `HEAD` is at or behind *that specific change's* head SHA (a foreign PR or MR head will not be an ancestor of your local commits), and the merged-head-unverifiable guard keeps anything whose head SHA cannot be resolved. It only slips through when the local branch sits exactly at a shared base with zero commits of its own — worthless to keep anyway. The real mitigation is descriptive, unique branch names; do not reuse `patch-1`.

## Never `rm -rf` a worktree

`git worktree remove` without `--force` refuses a tree carrying uncommitted or untracked files. That refusal is a feature: it's an independent second opinion on top of the classifier. Reaching for `rm -rf` (or `--force`) throws away the one check that runs regardless of whether the classifier has a bug.

A leftover directory is a cheap annoyance. A wrongly deleted one is unrecoverable.

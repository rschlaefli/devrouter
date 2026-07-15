# ADR 0001: Persist managed-workspace ownership in the consumer Git common directory

Status: Accepted

Context: Per-worktree Git metadata disappears when a linked worktree is removed, while a global registry would make devrouter own repository discovery and cleanup outside the repository boundary.

Decision: Persist one static ownership record per managed workspace under `<git-common-dir>/devrouter/workspaces/<workspace>.json`. Derive runtime state live, keep normal devrouter commands Git-optional, and require explicit workspace garbage collection for missing owners.

Why: The Git common directory survives linked-worktree removal, is shared by all worktrees of the consumer repository, and keeps ownership scoped to that repository without hooks, a watcher, or a machine-global repository registry.

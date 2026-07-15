# Domain context

- **Managed workspace:** A linked Git worktree adopted by `workspace up` or `workspace ensure` and backed by one ownership record.
- **Ownership record:** A repo-local durable claim connecting a workspace token, exact worktree path, diagnostic branch, and DevPod ID.
- **Owner status:** The live relationship between an ownership record, Git worktree registration, persisted local identity, and DevPod source ownership: `present`, `missing`, `locked`, or `conflict`.
- **Legacy workspace:** Live Git, DevPod, or route evidence without a common ownership record. It may be handled explicitly but is never garbage-collected automatically.
- **Stop:** Reversible runtime shutdown that preserves the worktree and ownership record.
- **Down:** Destructive managed-workspace removal that deletes runtime resources, routes, the clean worktree unless retained explicitly, and finally the ownership record.
- **Garbage collection:** Explicit cleanup of missing, ledger-owned workspace resources. It never removes Git worktrees, branches, or unrelated records.

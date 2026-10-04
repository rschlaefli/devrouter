# ADR 0011: Reclaim worktrees outside the ownership ledger through approved manifests

Status: Accepted; source implemented and unit-qualified.

Context: Agent sessions leave many linked worktrees behind, and most were
never created through `workspace up`, so they have no ownership record.
`workspace down` and `workspace gc` act only on ledger-owned workspaces
([ADR 0001](./0001-repo-local-workspace-ownership.md)), which leaves the bulk of
the disk use to hand-run `git worktree remove` sequences. The
`worktree-reclaim` skill already decides safely which trees hold no
unrecoverable work, but it cannot take the devrouter lifecycle lock or tear
down a managed runtime in order.

Decision: `workspace reclaim` removes linked worktrees, managed or not, but
only the exact candidates of an approved manifest. A manifest is canonical JSON
whose SHA-256 the user approves. Each candidate is bound to its repository,
real path, branch ref, HEAD, Git common directory and worktree Git directory,
and its ID is the SHA-256 of that identity. Devrouter and the skill share the
format: either tool reads the other's manifests, and `hash` and `select`
produce byte-identical output. Apply never discovers a target. It takes one
forge listing per repository at start. Then, for each candidate inside one
acquisition of that worktree's lifecycle lock, it re-reads the identity, the
Git state and that path's runtime and activity evidence, re-classifies the
tree and runs the optional veto command. Teardown order is managed runtime and
routes, `git worktree remove` without `--force`, ownership record, then the
branch, deleted by one compare-and-delete `update-ref` only while it still
points at the approved HEAD. A moved branch is kept and reported. A completed target writes a receipt
under `<git-common-dir>/worktree-reclaim/receipts/<manifest-sha>/`, so a rerun
reports it as done. A changed target is skipped; an error after teardown
began stops the batch and names the completed steps.

Why: The ownership ledger answers "did devrouter create this runtime?", which
is the wrong question for reclaiming disk. The right question is whether every
piece of the tree is recoverable elsewhere, and the shared Git-safety
classifier answers it for any tree. Binding approval to a content hash keeps a
person's decision exact: an agent cannot widen the set by rewording a list,
and a stale audit fails closed. Taking the lock per target, not across the
batch, keeps unrelated `ensure` and `stop` calls unblocked during a long run.

Rejected alternatives:

- Adopt unmanaged trees into the ledger first. That creates ownership records
  only to delete them, and mislabels trees devrouter never ran.
- Extend `workspace gc` to unmanaged trees. GC acts on missing-owner evidence
  without approval of an exact set; reclaiming live checkouts needs one.
- Approve by path list or glob. Paths are reused after removal and globs
  widen silently; neither binds the HEAD a person reviewed.
- Hold one lock across the whole batch. A slow forge or veto call would block
  every lifecycle operation on the machine for the run.

Revisit when the ledger adopts unmanaged worktrees for another reason, or when
forge listings become too large to read once per repository.

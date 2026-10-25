# Domain context

- **Managed workspace:** A linked Git worktree adopted by `workspace up` or `workspace ensure` and backed by one ownership record.
- **Ownership record:** A repo-local durable claim connecting a workspace token, exact worktree path, diagnostic branch, and DevPod ID.
- **Owner status:** The live relationship between an ownership record, Git worktree registration, persisted local identity, and DevPod source ownership: `present`, `missing`, `locked`, or `conflict`.
- **Legacy workspace:** Live Git, DevPod, or route evidence without a common ownership record. It may be handled explicitly but is never garbage-collected automatically.
- **Stop:** Reversible runtime shutdown that preserves the worktree and ownership record.
- **Down:** Destructive managed-workspace removal that deletes runtime resources, routes, the clean worktree unless retained explicitly, and finally the ownership record.
- **Garbage collection:** Explicit cleanup of missing, ledger-owned workspace resources. It never removes Git worktrees, branches, or unrelated records.

## Remote previews — planned capability

These terms describe the remote-preview product direction; the capability is not implemented yet. Local workspace terms above retain their current meaning.

**Remote preview**:
An isolated application environment for reviewing a nominated source revision of a change request.
_Avoid_: Local workspace, staging environment

**Preview session**:
One disposable review environment’s lifetime, from its creation request through the confirmed removal of its resources and test data.
_Avoid_: Retained workspace, permanent staging

**Preview expiry**:
The confirmed time when a preview stops accepting work and cleanup is required.
_Avoid_: Proof of deletion

**Preview extension**:
An explicit request to add time to an existing unexpired preview session.
_Avoid_: Redeployment, automatic renewal

**Preview profile**:
A named application capability selected for a remote preview, including its required supporting capabilities.
_Avoid_: Machine size, deployment provider

**Preview access policy**:
The rules determining which viewers can reach a preview, independently of application login permissions.
_Avoid_: Repository visibility, application role

**Deployment provider**:
A platform that supplies the remote resources used by a preview.
_Avoid_: Forge, local workspace runtime

**Forge**:
The system hosting the repository and its pull or merge requests.
_Avoid_: Deployment provider

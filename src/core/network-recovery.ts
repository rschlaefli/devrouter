import { inspectWorkspaceContainers, workspaceAppContainers } from "./devpod-environment";
import { withMutationLock as withDevpodLock } from "./devpod-mutation";
import { withMutationLock as withDevsyLock } from "./devsy-mutation";
import { classifyIPv4RouteOverlap } from "./network-capacity";
import { findOwnedNetworkClaim } from "./network-claim-lookup";
import { releaseNetworkClaim } from "./network-claims";
import { withNetworkEffectGuard } from "./network-effect-scope";
import { collectDockerNetworkInventory } from "./network-inventory";
import {
  assertNetworkOperationCurrent,
  networkOperationSettled,
  readNetworkOperationAuthority,
} from "./network-lifecycle";
import { readNetworkPolicy } from "./network-policy";
import { assertNetworkProviderBinding } from "./network-provider-binding";
import { inspectNetworkProviderBinding } from "./network-provider-inspect";
import { readPersistedWorkspace } from "./workspace";
import { readWorkspaceOwnership } from "./workspace-ownership";
import { resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

/** Reconcile reservation metadata only; provider and Docker resources are never removed. */
export function recoverUnattachedNetworkReservation(
  repoPath: string,
  managedRuntime: boolean,
): void {
  const initial = findOwnedNetworkClaim(repoPath);
  if (!initial || initial.state === "attached") return;
  if (!managedRuntime)
    throw new Error("Retained network requires managed configuration for reconciliation.");
  const lock = initial.provider === "devsy" ? withDevsyLock : withDevpodLock;
  lock("Network reservation reconciliation", repoPath, () => {
    const claim = findOwnedNetworkClaim(repoPath);
    if (!claim || claim.state === "attached") return;
    if (
      claim.provider !== initial.provider ||
      resolveWorkspaceRuntimeOrDefault(repoPath) !== claim.provider
    )
      throw new Error("Retained network provider changed; reconciliation is blocked.");
    const workspace = readPersistedWorkspace(repoPath);
    const owner = workspace ? readWorkspaceOwnership(repoPath, workspace) : undefined;
    if (!workspace || owner?.worktreePath !== repoPath || owner.devpodId !== claim.providerId)
      throw new Error("Network reconciliation requires exact retained workspace ownership.");
    const identity = { repoPath, workspace, provider: claim.provider };
    const current = readNetworkOperationAuthority(identity);
    if (!networkOperationSettled(identity, claim.operationId, current))
      throw new Error("Earlier network operation can still have effects; reservation is retained.");
    const policy = readNetworkPolicy();
    if (policy.status !== "valid" || policy.policy.daemonId !== claim.daemonId)
      throw new Error("Network reservation recovery requires current policy for the saved daemon.");
    const assertCurrent = () => assertNetworkOperationCurrent(identity, current);
    withNetworkEffectGuard(
      assertCurrent,
      () => {
        const evidence = inspectNetworkProviderBinding({
          provider: claim.provider,
          providerId: claim.providerId,
          repoPath,
          endpoint: claim.endpoint,
          providerContext: claim.providerContext,
        });
        // A workspace-local binding is itself an effect, even without containers.
        assertNetworkProviderBinding(claim, evidence, true);
        const inventory = collectDockerNetworkInventory({
          endpoint: claim.endpoint,
          expectedDaemonId: claim.daemonId,
        });
        if (
          inventory.status !== "complete" ||
          inventory.daemonId !== claim.daemonId ||
          inventory.networks.some((network) =>
            network.subnets.some(
              (cidr) =>
                classifyIPv4RouteOverlap(claim.subnet, { status: "complete", routes: [{ cidr }] })
                  .status !== "clear",
            ),
          )
        )
          throw new Error("Network absence is unproven; reservation and resources are retained.");
        if (workspaceAppContainers(inspectWorkspaceContainers(), repoPath).length !== 0)
          throw new Error("Workspace retains containers; network reservation is retained.");
        assertCurrent();
        if (
          !networkOperationSettled(identity, claim.operationId, current) ||
          !releaseNetworkClaim({
            ...claim,
            expected: claim,
            proof: {
              terminalWorkerSettled: true,
              noFutureEffects: true,
              effects: {
                binding: "absent",
                registration: "absent",
                containers: "absent",
                network: "absent",
              },
            },
          })
        )
          throw new Error(
            "Network reservation changed during reconciliation; retry requires fresh evidence.",
          );
      },
      claim.endpoint,
    );
  });
}

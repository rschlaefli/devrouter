import { createHash } from "node:crypto";
import type { DevrouterManagedRuntime } from "../types";
import type { ManagedDevcontainerPlan } from "./devcontainer-profile";
import {
  hasExactComposeIdentity,
  inspectManagedStopDaemon,
  inspectWorkspaceContainers,
  resolveManagedStopEndpoint,
  workspaceAppContainers,
} from "./devpod-environment";
import {
  calculateIPv4EndpointCapacity,
  classifyIPv4RouteOverlap,
  type NetworkCapacityInventory,
} from "./network-capacity";
import { findOwnedNetworkClaim, networkOwnerKey } from "./network-claim-lookup";
import {
  attachNetworkClaim,
  markNetworkClaimUncertain,
  type NetworkClaim,
  reserveNetworkClaim,
} from "./network-claims";
import {
  classifyComposeNetworkEligibility,
  deriveComposeNetworkDemand,
  fingerprintComposeNetworkModel,
  SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS,
} from "./network-compose";
import { inspectNetworkComposeFiles, prepareNetworkComposeFiles } from "./network-compose-files";
import { exemptClaimedConnectedRoutes, inspectClaimedBridge } from "./network-connected-route";
import { collectDockerNetworkInventory } from "./network-inventory";
import { assertNetworkOperationCurrent, readNetworkOperationAuthority } from "./network-lifecycle";
import { readNetworkPolicy } from "./network-policy";
import {
  assertNetworkProviderBinding,
  type PreparedNetworkStart,
} from "./network-provider-binding";
import { inspectNetworkProviderBinding } from "./network-provider-inspect";
import { collectNetworkRoutes } from "./network-routes";
import { readWorkspaceOwnership } from "./workspace-ownership";

export type ManagedNetworkSession = {
  endpoint: string;
  prepare: (providerId: string) => PreparedNetworkStart;
  guard: () => void;
  prove: (project: string, containerId: string) => void;
  retained: () => boolean;
};

/** Configuration removal must not turn a retained allocation into a legacy start. */
export function assertRetainedNetworkConfiguration(input: {
  repoPath: string;
  managedRuntime: boolean;
  repair: boolean;
}): void {
  const claim = findOwnedNetworkClaim(input.repoPath);
  if (!claim) return;
  if (!input.managedRuntime || input.repair || claim.state !== "attached")
    throw new Error("Retained network requires exact reconciliation before ensure or repair.");
  assertNetworkProviderBinding(
    claim,
    inspectNetworkProviderBinding({
      provider: claim.provider,
      providerId: claim.providerId,
      repoPath: input.repoPath,
      endpoint: claim.endpoint,
      providerContext: claim.providerContext,
    }),
    false,
  );
}

export function createManagedNetworkSession(input: {
  repoPath: string;
  provider: "devsy" | "devpod";
  workspace?: { token: string; gitCommonDir: string };
  hadExactProvider: boolean;
  request?: DevrouterManagedRuntime["network"];
  plan: () => ManagedDevcontainerPlan;
  replacePlan: (plan: ManagedDevcontainerPlan) => void;
}): ManagedNetworkSession | undefined {
  const saved = findOwnedNetworkClaim(input.repoPath);
  const policy = readNetworkPolicy();
  if (!saved && (policy.status === "absent" || input.hadExactProvider)) {
    if (input.request && policy.status === "absent" && !input.hadExactProvider)
      throw new Error("Network allocation requires operator-approved machine policy.");
    return undefined;
  }
  if (!input.workspace) {
    if (input.request || saved)
      throw new Error("Network allocation requires a managed linked workspace.");
    return undefined;
  }
  if (policy.status === "invalid") throw new Error(policy.error);
  const workspace = input.workspace;
  const endpoint = saved?.endpoint ?? resolveManagedStopEndpoint();
  let claim = saved;
  let dispatched = false;
  let awaitingProviderSave = false;
  let provenProject: string | undefined;
  let endpointDemand = 0;
  const ownerKey = networkOwnerKey(input.repoPath);
  const identity = {
    repoPath: input.repoPath,
    workspace: workspace.token,
    provider: input.provider,
  };
  const owner = (providerId: string) => {
    const record = readWorkspaceOwnership(input.repoPath, workspace.token);
    if (!record || record.worktreePath !== input.repoPath || record.devpodId !== providerId)
      throw new Error("Network workspace ownership changed; repair is required.");
  };
  const inventory = (daemonId: string): NetworkCapacityInventory => {
    const result = collectDockerNetworkInventory({ endpoint, expectedDaemonId: daemonId });
    if (result.status !== "complete" || !result.daemonId)
      throw new Error("Network inventory is unknown; allocation is blocked.");
    return { ...result, endpoint, daemonId: result.daemonId };
  };
  const bindingEvidence = (current: NetworkClaim) =>
    inspectNetworkProviderBinding({
      provider: input.provider,
      providerId: current.providerId,
      repoPath: input.repoPath,
      endpoint,
      providerContext: current.providerContext,
    });
  const checkRoutes = (current: NetworkClaim, networkId?: string) => {
    const currentPolicy = readNetworkPolicy();
    if (currentPolicy.status === "invalid") throw new Error(currentPolicy.error);
    if (
      currentPolicy.status === "valid" &&
      (currentPolicy.policy.daemonId !== current.daemonId ||
        classifyIPv4RouteOverlap(current.subnet, {
          status: "complete",
          routes: currentPolicy.policy.exclusions.map((cidr) => ({ cidr })),
        }).status !== "clear")
    )
      throw new Error(
        "Current network policy conflicts with the retained claim; repair is required.",
      );
    const routes = collectNetworkRoutes({ endpoint });
    const filtered = networkId
      ? exemptClaimedConnectedRoutes(
          routes,
          current.subnet,
          inspectClaimedBridge(current, networkId),
        )
      : routes;
    if (classifyIPv4RouteOverlap(current.subnet, filtered).status !== "clear")
      throw new Error(
        "Network route overlap or unknown evidence blocks readiness; retain the claim and runtime.",
      );
  };
  const prove = (project: string, containerId: string, effectivePlan = input.plan()) => {
    awaitingProviderSave = false;
    if (!claim) throw new Error("Network has no durable reservation.");
    owner(claim.providerId);
    assertNetworkProviderBinding(claim, bindingEvidence(claim), false);
    const snapshot = inventory(claim.daemonId);
    const networks = snapshot.networks.filter(
      (network) => network.composeProject === project && network.composeNetwork === "default",
    );
    if (networks.length !== 1)
      throw new Error("Exact managed network is missing or ambiguous; repair is required.");
    const network = networks[0];
    if (
      network.driver !== "bridge" ||
      network.subnets.length !== 1 ||
      network.subnets[0] !== claim.subnet ||
      !network.retainedContainerIds?.includes(containerId) ||
      (claim.networkId && network.id !== claim.networkId)
    )
      throw new Error("Network postcondition changed; retain claim and runtime for repair.");
    const containers = inspectWorkspaceContainers({ ids: network.retainedContainerIds });
    if (
      containers.length !== network.retainedContainerIds.length ||
      containers.some(
        (container) =>
          !effectivePlan.composeServices.some((service) =>
            hasExactComposeIdentity(container, {
              repoPath: input.repoPath,
              service,
              composeProject: project,
              composeFiles: effectivePlan.composeFiles,
            }),
          ),
      )
    )
      throw new Error("Network retains containers whose exact workspace ownership is unproven.");
    const reservePolicy = readNetworkPolicy();
    const reserve = reservePolicy.status === "valid" ? reservePolicy.policy.endpointReserve : 8;
    if (
      calculateIPv4EndpointCapacity(
        claim.prefix,
        reserve,
        Math.max(endpointDemand, network.retainedContainerIds.length + 1),
      ).status !== "available"
    )
      throw new Error(
        "Retained containers leave insufficient endpoint headroom; network migration requires approval.",
      );
    checkRoutes(claim, network.id);
    if (claim.state === "reserved") {
      const authority = readNetworkOperationAuthority(identity);
      assertNetworkOperationCurrent(identity, authority);
      claim = attachNetworkClaim({
        ...claim,
        expected: claim,
        attachedProof: {
          endpoint,
          daemonId: claim.daemonId,
          subnet: claim.subnet,
          networkId: network.id,
        },
      });
    } else if (claim.state !== "attached")
      throw new Error("Network claim needs settlement before reuse.");
    provenProject = project;
  };
  return {
    endpoint,
    retained: () => dispatched || claim !== undefined,
    guard: () => {
      if (!claim) return;
      owner(claim.providerId);
      if (inspectManagedStopDaemon(endpoint) !== claim.daemonId)
        throw new Error("Network daemon identity changed; effects are blocked.");
      if ((dispatched && !awaitingProviderSave) || saved)
        assertNetworkProviderBinding(claim, bindingEvidence(claim), false);
      if (provenProject) checkRoutes(claim, claim.networkId);
    },
    prove,
    prepare: (providerId) => {
      owner(providerId);
      if (
        saved &&
        (saved.provider !== input.provider ||
          saved.providerId !== providerId ||
          saved.state !== "attached")
      )
        throw new Error("Retained network claim needs repair; automatic rebinding is forbidden.");
      const evidence = inspectNetworkProviderBinding({
        provider: input.provider,
        providerId,
        repoPath: input.repoPath,
        endpoint,
        ...(saved ? { providerContext: saved.providerContext } : {}),
      });
      const binding = {
        provider: input.provider,
        providerId,
        endpoint,
        daemonId: evidence.daemonId,
        definitionSha256: saved?.definitionSha256 ?? evidence.definitionSha256,
        providerContext: evidence.providerContext,
      };
      assertNetworkProviderBinding(binding, evidence, !saved);
      const model = inspectNetworkComposeFiles({ plan: input.plan(), endpoint, workspace });
      if (!classifyComposeNetworkEligibility(model).eligible)
        throw new Error("Compose topology is unsupported for managed default network allocation.");
      const demand = deriveComposeNetworkDemand({
        ...model,
        helperEndpoints: 0,
        retainedEndpoints: 0,
        recreationSurge: 1,
        staticReservations: 0,
        ...(input.request?.endpointUpperBound
          ? {
              endpointUpperBound: input.request.endpointUpperBound,
              endpointUpperBoundSemantics: SAFE_ENDPOINT_UPPER_BOUND_SEMANTICS,
            }
          : {}),
      });
      if (demand.status !== "known" || demand.upperBound === undefined)
        throw new Error(
          "Network endpoint demand is unknown; declare a full-lifecycle upper bound.",
        );
      endpointDemand = demand.upperBound;
      const prefixLength = input.request?.prefixLength ?? saved?.prefix ?? 26;
      if (saved && prefixLength !== saved.prefix)
        throw new Error("Network size change requires an approved migration.");
      const reserve = policy.status === "valid" ? policy.policy.endpointReserve : 8;
      if (
        calculateIPv4EndpointCapacity(prefixLength, reserve, endpointDemand).status !== "available"
      )
        throw new Error(
          "Insufficient endpoint headroom; request an allowed larger network before first allocation.",
        );
      const authority = readNetworkOperationAuthority(identity);
      const fingerprint = createHash("sha256")
        .update(input.plan().sourceConfigSha256)
        .update(fingerprintComposeNetworkModel(model))
        .digest("hex");
      if (!saved) {
        if (policy.status !== "valid")
          throw new Error("New network allocation requires valid machine policy.");
        if (workspaceAppContainers(inspectWorkspaceContainers(), input.repoPath).length)
          throw new Error("Existing runtime evidence prevents new network allocation.");
        claim = reserveNetworkClaim({
          ...binding,
          ownerKey,
          configFingerprint: fingerprint,
          ...authority,
          prefixLength,
          endpointDemand,
          revalidate: () => {
            assertNetworkOperationCurrent(identity, authority);
            owner(providerId);
            assertNetworkProviderBinding(
              binding,
              inspectNetworkProviderBinding({
                provider: input.provider,
                providerId,
                repoPath: input.repoPath,
                endpoint,
                providerContext: binding.providerContext,
              }),
              true,
            );
            const currentPolicy = readNetworkPolicy();
            if (currentPolicy.status !== "valid")
              throw new Error("Network policy changed before allocation.");
            return {
              policy: currentPolicy.policy,
              inventory: inventory(binding.daemonId),
              routes: collectNetworkRoutes({ endpoint }),
              endpointDemand,
            };
          },
        });
      } else {
        claim = saved;
        if (claim.configFingerprint !== fingerprint)
          throw new Error("Retained network source changed; repair is required.");
      }
      const prepared = prepareNetworkComposeFiles(input.plan(), claim.subnet);
      if (saved) {
        const snapshot = inventory(claim.daemonId);
        const network = snapshot.networks.find((network) => network.id === claim?.networkId);
        if (!network?.composeProject || !network.retainedContainerIds?.length)
          throw new Error(
            "Retained network is missing or has no proven container; repair is required.",
          );
        prove(network.composeProject, network.retainedContainerIds[0], prepared.plan);
      }
      prepared.write();
      input.replacePlan(prepared.plan);
      const current = claim;
      return {
        binding,
        evidence,
        firstAllocation: !saved,
        devcontainerPath: prepared.plan.generatedRelativePath,
        beforeDispatch: () => {
          assertNetworkOperationCurrent(identity, authority);
          if (!saved) {
            const latestPolicy = readNetworkPolicy();
            if (
              latestPolicy.status !== "valid" ||
              policy.status !== "valid" ||
              JSON.stringify(latestPolicy.policy) !== JSON.stringify(policy.policy)
            )
              throw new Error(
                "Network policy changed before provider dispatch; reservation is retained.",
              );
            checkRoutes(current);
            const snapshot = inventory(current.daemonId);
            if (
              snapshot.networks.some((network) =>
                network.subnets.some(
                  (cidr) =>
                    classifyIPv4RouteOverlap(current.subnet, {
                      status: "complete",
                      routes: [{ cidr }],
                    }).status !== "clear",
                ),
              )
            )
              throw new Error(
                "Docker subnet became occupied before dispatch; reservation is retained for reconciliation.",
              );
          }
          assertNetworkProviderBinding(
            binding,
            inspectNetworkProviderBinding({
              provider: input.provider,
              providerId,
              repoPath: input.repoPath,
              endpoint,
              providerContext: binding.providerContext,
            }),
            !saved,
          );
          dispatched = true;
          awaitingProviderSave = !saved;
        },
        retainUncertain: () => {
          dispatched = true;
          if (current.state === "reserved")
            claim = markNetworkClaimUncertain({ ...current, expected: current });
        },
      };
    },
  };
}

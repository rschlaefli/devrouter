import { readProviderGeneration } from "./capacity-ownership-resolver";
import { inspectManagedDevcontainerConfig } from "./devcontainer-profile";
import { readManagedRuntimeState } from "./managed-runtime-state";
import type { ReliabilityFence } from "./reliability-contract";
import {
  type CapacityStartupWitness,
  publishStartupWitness,
  type ReliabilityIdentity,
} from "./reliability-operation-store";
import { loadRuntimeConfig } from "./repo-config";
import { isLinkedWorktree } from "./workspace";

/**
 * Construct and publish the queued ensure startup witness outside the journal
 * transaction. The witness binds the requested profile, the exact provider
 * generation, the inspected Compose plan, and the already identity-proven
 * retained container IDs, so admission-time collection can classify a cold or
 * growing startup population before the worker mutates anything. Publication
 * revalidates the fence inside the journal; a failure must retire the queued
 * intent instead of letting a worker mutate an unwitnessed population.
 */
export async function publishQueuedStartupWitness(input: {
  identity: ReliabilityIdentity;
  providerId: string;
  operationId: string;
  fence: ReliabilityFence;
  profile: string;
  signal: AbortSignal;
}): Promise<void> {
  const generation = await readProviderGeneration(
    input.identity.repoPath,
    input.providerId,
    input.signal,
  );
  const runtime = loadRuntimeConfig(
    input.identity.repoPath,
    input.identity.workspace ?? "",
    input.profile,
  );
  const plan = inspectManagedDevcontainerConfig({
    repoPath: input.identity.repoPath,
    config: runtime.config,
    profile: runtime.resolvedProfile,
    linked: isLinkedWorktree(input.identity.repoPath),
  });
  const retainedContainerIds =
    readManagedRuntimeState(
      input.identity.repoPath,
      input.identity.workspace ?? undefined,
    )?.stopBaseline?.containers.map((container) => container.id) ?? [];
  const witness: CapacityStartupWitness = {
    operationId: input.operationId,
    fence: { ...input.fence },
    provider: { id: input.providerId, ...generation },
    profile: input.profile,
    sourceConfigSha256: plan.sourceConfigSha256,
    effectiveConfigSha256: plan.effectiveConfigSha256,
    composeFiles: [...plan.composeFiles],
    primaryService: plan.primaryService,
    startupServices: [...plan.desiredServices].sort(),
    retainedContainerIds,
  };
  publishStartupWitness(input.identity, witness);
}

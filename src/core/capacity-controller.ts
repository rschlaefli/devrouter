import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CapacityDomainSample } from "./capacity-accounting";
import { enrollCapacityLifecycle } from "./capacity-enrollment";
import { readCapacityPolicy } from "./capacity-policy";
import { CapacityQueue } from "./capacity-queue";
import { capacityRequest } from "./capacity-request";
import type { ControllerOperations } from "./controller-server";
import { resolveRunningWorkspaceContainer } from "./devpod-environment";
import { readLifecycleOperationStatus } from "./lifecycle-operation-status";
import { prepareManagedLifecycleOperation, retireQueuedLifecycle } from "./reliability-lifecycle";
import {
  type CapacityControllerIdentity,
  readReliabilityOperation,
} from "./reliability-operation-store";

/** Own transient requests independently of client connections within one controller incarnation. */
export function createCapacityController(options: {
  directory: string;
  controller: CapacityControllerIdentity;
  collect: () => Promise<Record<string, CapacityDomainSample>>;
}): ControllerOperations & { tick: () => Promise<void>; close: () => void } {
  const policy = readCapacityPolicy(options.directory);
  if (policy?.admissions !== "enabled") throw new Error("Capacity policy is not enabled.");
  const queue = new CapacityQueue({ ...options, policyRevision: policy.revision });
  const payloadKey = randomBytes(32);
  const acceptedPayloads = new Map<string, string>();
  let closed = false;
  return {
    async submit(request, environment, signal) {
      if (closed || signal.aborted) throw new Error("Capacity submission unavailable.");
      const current = readCapacityPolicy(options.directory);
      if (current?.admissions !== "enabled" || !isDeepStrictEqual(current, policy))
        throw new Error("Capacity controller policy changed.");
      const resolved = await enrollCapacityLifecycle(
        current,
        {
          path: environment.repoPath,
          profile: environment.profile,
          require: [],
        },
        signal,
        options.directory,
      );
      if (!isDeepStrictEqual(resolved.environment, environment) || closed || signal.aborted)
        throw new Error("Capacity submission binding changed.");
      if (!isDeepStrictEqual(readCapacityPolicy(options.directory), current))
        throw new Error("Capacity submission policy changed during resolution.");
      const identity = {
        repoPath: environment.repoPath,
        workspace: environment.workspace || null,
        provider: environment.provider,
      };
      const record = readReliabilityOperation(identity);
      if (!record) throw new Error("Capacity lifecycle journal unavailable.");
      const charge = capacityRequest(resolved.estimates, resolved.enrollment, {
        environmentId: record.state.environmentId,
        profile: environment.profile,
        ...(record.activeProfile ? { activeProfile: record.activeProfile } : {}),
        kind: request.kind,
        operation: request.operation,
      });
      const prepared = prepareManagedLifecycleOperation({
        identity,
        policyRevision: current.revision,
        requestId: request.requestId,
        kind: request.kind,
        profile: environment.profile,
        consumer: { id: "controller", requiredCapabilities: [], pinned: false },
        runtimeRunning:
          request.kind === "exec" &&
          Boolean(resolveRunningWorkspaceContainer(environment.repoPath)),
        ...(request.kind === "exec" ? { command: request.command } : {}),
      });
      const signature = createHmac("sha256", payloadKey)
        .update(
          JSON.stringify({
            repoPath: identity.repoPath,
            profile: environment.profile,
            kind: request.kind,
            operation: request.operation ?? null,
            command: request.kind === "exec" ? request.command : null,
          }),
        )
        .digest("hex");
      const previousPayload = acceptedPayloads.get(prepared.operationId);
      if (previousPayload && previousPayload !== signature)
        throw new Error("Operation request conflicts with its accepted payload.");
      if (prepared.request) {
        try {
          queue.enqueue(prepared.request, {
            ...charge,
            operationId: prepared.operationId,
            reservationId: randomUUID(),
            policyRevision: current.revision,
          });
          acceptedPayloads.set(prepared.operationId, signature);
          for (const id of acceptedPayloads.keys()) {
            if (!queue.observePage(id)) acceptedPayloads.delete(id);
          }
        } catch (error) {
          retireQueuedLifecycle(prepared.request);
          throw error;
        }
      }
      return { operation: readLifecycleOperationStatus(identity, prepared.operationId) ?? null };
    },
    async watch(request, environment, signal) {
      if (closed || signal.aborted) throw new Error("Capacity watch unavailable.");
      const identity = {
        repoPath: environment.repoPath,
        workspace: environment.workspace || null,
        provider: environment.provider,
      };
      const before = readLifecycleOperationStatus(identity, request.operationId);
      if (!before) throw new Error("Operation does not belong to this environment.");
      if (before.phase !== "terminal" && queue.observePage(request.operationId))
        await queue.wait(request.operationId, request.timeout * 1000, signal);
      if (signal.aborted) throw new Error("Capacity watch cancelled.");
      return {
        operation: readLifecycleOperationStatus(identity, request.operationId) ?? null,
        output: queue.observePage(request.operationId, request.output)?.output ?? null,
      };
    },
    tick: () => queue.tick(),
    close() {
      closed = true;
      queue.close();
      acceptedPayloads.clear();
    },
  };
}

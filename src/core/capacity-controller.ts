import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CapacityDomainSample } from "./capacity-accounting";
import { readDockerCapacityInfo } from "./capacity-docker-probe";
import { enrollCapacityLifecycle } from "./capacity-enrollment";
import { readCapacityPolicy } from "./capacity-policy";
import { CapacityQueue } from "./capacity-queue";
import { capacityRequest } from "./capacity-request";
import { type CapacityPoolReservation, CapacityStore } from "./capacity-store";
import { readControllerEvidence } from "./controller-binding";
import type { ControllerOperations, ControllerStartup } from "./controller-server";
import { ControllerStore } from "./controller-store";
import { resolveRunningWorkspaceContainer } from "./devpod-environment";
import { readLifecycleOperationStatus } from "./lifecycle-operation-status";
import { reliabilityFence } from "./reliability-contract";
import {
  prepareManagedLifecycleOperation,
  retireQueuedLifecycle,
  settlePreparedLifecycleCapacity,
} from "./reliability-lifecycle";
import { stepReliability } from "./reliability-model";
import {
  listReliabilityOperations,
  readReliabilityOperation,
  updateReliabilityOperation,
} from "./reliability-operation-store";
import { loadRepoConfig } from "./repo-config";

/** Own transient requests independently of client connections within one controller incarnation. */
export function createCapacityController(options: {
  directory: string;
  controller: ControllerStartup;
  // Host samples exclude VM usage covered by pool ceilings; sharedBytes excludes those ceilings.
  collect: () => Promise<Record<string, CapacityDomainSample>>;
}): ControllerOperations & { tick: () => Promise<void>; close: () => void } {
  options.controller.consumeStartup(options.directory);
  const policy = readCapacityPolicy(options.directory);
  if (policy?.admissions !== "enabled") throw new Error("Capacity policy is not enabled.");
  // The server invokes this factory under its owner lock, before accepting requests.
  for (const prior of listReliabilityOperations()) {
    if (!prior.enrollment) continue;
    updateReliabilityOperation(prior.identity, (record) => {
      const current = new ControllerStore(options.directory).read();
      if (current?.store !== options.controller.store || current.epoch !== options.controller.epoch)
        throw new Error("Capacity controller incarnation changed during startup.");
      if (!record.enrollment || record.state.executionPolicy !== "capacity-managed")
        throw new Error("Capacity enrollment changed during startup.");
      if (record.capacity) record.capacity.validUntilMs = 0;
      const operation = record.state.operation;
      if (record.worker || !operation || operation.drained || operation.status !== "NOT_STARTED")
        return;
      const transition = stepReliability(
        record.state,
        {
          ...reliabilityFence(record.state),
          type: "drained",
          operationId: operation.id,
        },
        Date.now(),
      );
      if (transition.outcome !== "accepted")
        throw new Error("Undispatched startup reconciliation was not accepted.");
      record.state = transition.state;
    });
  }
  const controller = { store: options.controller.store, epoch: options.controller.epoch };
  const lifetime = new AbortController();
  const collect = async (): Promise<Record<string, CapacityDomainSample>> => {
    const assertCurrent = () => {
      const current = new ControllerStore(options.directory).read();
      if (
        lifetime.signal.aborted ||
        current?.store !== controller.store ||
        current.epoch !== controller.epoch ||
        !isDeepStrictEqual(readCapacityPolicy(options.directory), policy)
      )
        throw new Error("Capacity collection authority changed.");
    };
    assertCurrent();
    const store = new CapacityStore(options.directory);
    const revision = store.read().revision;
    const runtimes = Object.entries(policy.domains).filter((entry) => entry[1].kind === "runtime");
    const observed: CapacityPoolReservation[] = [];
    const unknown = new Set<string>();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, cancellation.signal]);
    const deadline = performance.now() + 3000;
    const timer = setTimeout(() => cancellation.abort(), 3000);
    let next = 0;
    try {
      await Promise.allSettled(
        Array.from({ length: Math.min(4, runtimes.length) }, async () => {
          while (next < runtimes.length) {
            const [runtimeDomain, runtime] = runtimes[next++];
            if (runtime.kind !== "runtime") continue;
            try {
              if (signal.aborted || performance.now() >= deadline)
                throw new Error("Pool observation expired.");
              const info = await readDockerCapacityInfo(runtime.endpoint, signal);
              if (signal.aborted || performance.now() >= deadline || info.ID !== runtime.daemonId)
                throw new Error("Pool observation unavailable.");
              observed.push({
                daemonId: runtime.daemonId,
                runtimeDomain,
                hostDomain: runtime.hostDomain,
                hostChargeCeilingBytes: runtime.hostChargeCeilingBytes,
              });
            } catch {
              unknown.add(runtime.hostDomain);
              unknown.add(runtimeDomain);
            }
          }
        }),
      );
    } finally {
      clearTimeout(timer);
    }
    assertCurrent();
    // The injected collector has no cancellation contract; do not start it during pool shutdown.
    const samples = structuredClone(await options.collect());
    assertCurrent();
    // The revision predates observation, so a concurrent cessation cannot be undone by stale evidence.
    store.mergeObservedPools(observed, revision);
    for (const domain of unknown) {
      if (samples[domain]) samples[domain] = { ...samples[domain], pressure: "unknown" };
    }
    return samples;
  };
  const queue = new CapacityQueue({
    ...options,
    collect,
    controller,
    policyRevision: policy.revision,
  });
  const payloadKey = randomBytes(32);
  const acceptedPayloads = new Map<string, string>();
  const settlePreparations = (): void => {
    if (lifetime.signal.aborted) return;
    try {
      if (!isDeepStrictEqual(readCapacityPolicy(options.directory), policy)) return;
    } catch {
      // Settlement retains charges; the queue still applies its own policy checks.
      return;
    }
    for (const enrollment of policy.enrollments) {
      try {
        const identity = {
          repoPath: enrollment.repoPath,
          workspace: enrollment.workspace || null,
          provider: enrollment.provider,
        };
        const record = readReliabilityOperation(identity);
        if (
          !record?.capacity ||
          (!record.preparation && !record.capacity.execSteady) ||
          record.worker ||
          !record.state.operation?.drained ||
          !["ensure", "exec"].includes(record.state.operation.kind)
        )
          continue;
        const bytes = readControllerEvidence(path.join(enrollment.repoPath, ".devrouter.yml"));
        const estimates = loadRepoConfig(enrollment.repoPath, () => bytes).capacity;
        if (!estimates) continue;
        settlePreparedLifecycleCapacity({
          identity,
          controller,
          estimates,
          enrollment,
          directory: options.directory,
        });
      } catch {
        // Retain uncertain charges; another environment can still reconcile and queue.
      }
    }
  };
  return {
    async submit(request, environment, signal) {
      signal = AbortSignal.any([signal, lifetime.signal]);
      if (signal.aborted) throw new Error("Capacity submission unavailable.");
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
      if (!isDeepStrictEqual(resolved.environment, environment) || signal.aborted)
        throw new Error("Capacity submission binding changed.");
      if (!isDeepStrictEqual(readCapacityPolicy(options.directory), current))
        throw new Error("Capacity submission policy changed during resolution.");
      const runtime = current.domains[resolved.enrollment.runtimeDomain];
      if (
        runtime?.kind !== "runtime" ||
        runtime.hostDomain !== resolved.enrollment.hostDomain ||
        current.domains[runtime.hostDomain]?.kind !== "host" ||
        !current.enrollments.some((entry) => isDeepStrictEqual(entry, resolved.enrollment))
      )
        throw new Error("Capacity pool does not match policy enrollment.");
      const pool = {
        daemonId: runtime.daemonId,
        runtimeDomain: resolved.enrollment.runtimeDomain,
        hostDomain: runtime.hostDomain,
        hostChargeCeilingBytes: runtime.hostChargeCeilingBytes,
      };
      const identity = {
        repoPath: environment.repoPath,
        workspace: environment.workspace || null,
        provider: environment.provider,
      };
      const record = readReliabilityOperation(identity);
      if (!record) throw new Error("Capacity lifecycle journal unavailable.");
      if ((record.preparation || record.capacity?.execSteady) && record.state.operation?.drained)
        settlePreparedLifecycleCapacity({
          identity,
          controller,
          estimates: resolved.estimates,
          enrollment: resolved.enrollment,
          directory: options.directory,
        });
      const charge = capacityRequest(resolved.estimates, resolved.enrollment, {
        environmentId: record.state.environmentId,
        profile: environment.profile,
        ...(record.activeProfile ? { activeProfile: record.activeProfile } : {}),
        kind: request.kind,
        operation: request.operation,
      });
      const prepared = prepareManagedLifecycleOperation({
        identity,
        controller,
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
          queue.enqueue(
            prepared.request,
            {
              ...charge,
              operationId: prepared.operationId,
              reservationId: randomUUID(),
              policyRevision: current.revision,
            },
            { estimates: resolved.estimates, enrollment: resolved.enrollment, pool },
          );
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
      if (lifetime.signal.aborted || signal.aborted) throw new Error("Capacity watch unavailable.");
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
    tick: () => {
      settlePreparations();
      return queue.tick();
    },
    close() {
      lifetime.abort();
      queue.close();
      acceptedPayloads.clear();
    },
  };
}

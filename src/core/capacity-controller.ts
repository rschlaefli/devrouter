import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type CapacityDomainSample,
  type CapacityEvidenceClock,
  CapacityPressureTracker,
} from "./capacity-accounting";
import { readDockerCapacityInfo } from "./capacity-docker-probe";
import { enrollCapacityLifecycle, resolveCapacityEnrollment } from "./capacity-enrollment";
import { readCapacityPolicy } from "./capacity-policy";
import { CapacityQueue } from "./capacity-queue";
import { capacityRequest } from "./capacity-request";
import { publishQueuedStartupWitness } from "./capacity-startup-witness";
import type { CapacityPoolReservation } from "./capacity-store";
import { createControllerBindingResolver, readControllerEvidence } from "./controller-binding";
import {
  type ControllerCapacityDirective,
  type ControllerRecovery,
  environmentIdentity,
} from "./controller-monitor";
import type {
  ControllerOperations,
  ControllerResolver,
  ControllerStartup,
} from "./controller-server";
import { type ControllerEnvironment, ControllerStore } from "./controller-store";
import { resolveRunningWorkspaceContainer } from "./devpod-environment";
import { parseUpstream } from "./host-routes";
import { readLifecycleOperationStatus } from "./lifecycle-operation-status";
import { recoverySelectors } from "./recovery-budget";
import { reliabilityFence } from "./reliability-contract";
import {
  prepareManagedLifecycleOperation,
  prepareParkLifecycleOperation,
  prepareRecoveryLifecycleOperation,
  prepareResumeLifecycleOperation,
  reconcileParkedLifecycleStop,
  restoreParkedIntentAfterFailedResume,
  retireQueuedLifecycle,
  settlePreparedLifecycleCapacity,
} from "./reliability-lifecycle";
import { stepReliability } from "./reliability-model";
import {
  createLifecycleCapacityStore,
  listReliabilityOperations,
  readReliabilityOperation,
  updateReliabilityOperation,
} from "./reliability-operation-store";
import { runLifecycleWorker } from "./reliability-worker";
import { loadRepoConfig, loadRuntimeConfig } from "./repo-config";

/**
 * Capability selectors the prepared plan can attribute, split by dimension. An
 * app whose upstream alias names a declared retained service is bounded by the
 * service limit; every other routed app is served by the repository process
 * group and is bounded by the process limit. Unreadable configuration yields no
 * selectors, which leaves the aggregate ceiling in force.
 */
function recoverySelectorsFor(input: { repoPath: string; workspace: string; profile: string }): {
  process: string[];
  service: string[];
} {
  const { config } = loadRuntimeConfig(input.repoPath, input.workspace, input.profile);
  const registry = config.managedRuntime?.devcontainer;
  return recoverySelectors({
    apps: config.apps.flatMap((app) => {
      if (app.kind !== "app" || app.runtime !== "proxy" || app.protocol !== "http") return [];
      if (!("upstream" in app) || typeof app.upstream !== "string") return [];
      if (app.readiness === undefined) return [];
      return [{ name: app.name, upstreamHost: parseUpstream(app.upstream).host }];
    }),
    aliasPrefix: input.workspace,
    services: registry ? [...registry.baseServices, ...registry.profileServices] : [],
  });
}

/** Own transient requests independently of client connections within one controller incarnation. */
export function createCapacityController(options: {
  directory: string;
  controller: ControllerStartup;
  bindingResolver?: ControllerResolver;
  // Host samples exclude VM usage covered by pool ceilings; sharedBytes excludes those ceilings.
  // Collectors must cooperate with abort by draining their work and rejecting.
  collect: (signal: AbortSignal) => Promise<Record<string, CapacityDomainSample>>;
  clock?: () => CapacityEvidenceClock;
}): ControllerOperations & {
  tick: () => Promise<void>;
  close: () => void;
  recover: ControllerRecovery;
  pressureEvidence: (domains: { hostDomain: string; runtimeDomain: string }) => {
    domains: ReturnType<CapacityPressureTracker["read"]>;
    normalDwellSatisfied: boolean;
    sustainedPressure: boolean;
  };
} {
  const bindingResolver = options.bindingResolver ?? createControllerBindingResolver();
  options.controller.consumeStartup(options.directory);
  const policy = structuredClone(readCapacityPolicy(options.directory));
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
  const clock =
    options.clock ?? (() => ({ wallMs: Date.now(), monotonicMs: Math.floor(performance.now()) }));
  const maxSampleAgeMs = policy.scheduling.maxSampleAgeSeconds * 1000;
  const intervalMs = policy.scheduling.sampleIntervalSeconds * 1000;
  const tracker = new CapacityPressureTracker(Object.keys(policy.domains), maxSampleAgeMs);
  let generation = tracker.checkpoint(clock());
  let cached: Record<string, CapacityDomainSample> | undefined;
  let lastStarted: number | undefined;
  let invalidated = false;
  let collecting:
    | {
        result: Promise<Record<string, CapacityDomainSample>>;
        cancel: () => void;
        cancelled: boolean;
      }
    | undefined;
  const invalidateEvidence = () => {
    cached = undefined;
    tracker.invalidate();
  };
  const assertCurrent = () => {
    let current: ReturnType<ControllerStore["read"]>;
    let matches = false;
    try {
      current = new ControllerStore(options.directory).read();
      matches =
        current?.store === controller.store &&
        current.epoch === controller.epoch &&
        isDeepStrictEqual(readCapacityPolicy(options.directory), policy);
    } catch {
      // Unavailable authority cannot preserve an old duration or admission sample.
    }
    if (invalidated || lifetime.signal.aborted || !matches) {
      invalidated = true;
      invalidateEvidence();
      lifetime.abort();
      throw new Error("Capacity collection authority changed.");
    }
  };
  const checkedClock = () => {
    const now = clock();
    const next = tracker.checkpoint(now);
    if (next !== generation) {
      generation = next;
      cached = undefined;
      if (lastStarted !== undefined && now.monotonicMs < lastStarted) lastStarted = undefined;
      collecting?.cancel();
    }
    if (
      !Number.isSafeInteger(now.wallMs) ||
      now.wallMs < 0 ||
      !Number.isSafeInteger(now.monotonicMs) ||
      now.monotonicMs < 0
    )
      throw new Error("Capacity collection clock unavailable.");
    return now;
  };
  const collectRaw = async (
    collectionSignal: AbortSignal,
    check: () => CapacityEvidenceClock,
  ): Promise<Record<string, CapacityDomainSample>> => {
    const store = createLifecycleCapacityStore(options.directory);
    const revision = store.read().revision;
    const runtimes = Object.entries(policy.domains).filter((entry) => entry[1].kind === "runtime");
    const observed: CapacityPoolReservation[] = [];
    const unknown = new Set<string>();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([collectionSignal, cancellation.signal]);
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
    check();
    const samples = structuredClone(await options.collect(collectionSignal));
    check();
    for (const domain of unknown) {
      if (samples[domain]) samples[domain] = { ...samples[domain], pressure: "unknown" };
    }
    // The revision predates observation, so a concurrent cessation cannot be undone by stale evidence.
    check();
    store.mergeObservedPools(observed, revision);
    return tracker.observe(samples, check());
  };
  const collect = (): Promise<Record<string, CapacityDomainSample>> => {
    let now: CapacityEvidenceClock;
    try {
      assertCurrent();
      now = checkedClock();
    } catch (error) {
      return Promise.reject(error);
    }
    if (collecting)
      return collecting.cancelled
        ? Promise.reject(new Error("Capacity collection is still draining."))
        : collecting.result;
    if (lastStarted !== undefined && now.monotonicMs - lastStarted < intervalMs) {
      if (!cached) return Promise.reject(new Error("Capacity sample unavailable within cadence."));
      return Promise.resolve(
        structuredClone(
          Object.fromEntries(
            Object.entries(cached).filter(
              ([, sample]) =>
                sample.sampledAtMs <= now.wallMs &&
                now.wallMs - sample.sampledAtMs <= maxSampleAgeMs,
            ),
          ),
        ),
      );
    }
    const startedGeneration = generation;
    const expiresAt = now.monotonicMs + maxSampleAgeMs;
    lastStarted = now.monotonicMs;
    const cancellation = new AbortController();
    let resolveResult!: (samples: Record<string, CapacityDomainSample>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<Record<string, CapacityDomainSample>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const slot = {
      result,
      cancelled: false,
      cancel: () => {
        if (slot.cancelled) return;
        slot.cancelled = true;
        invalidateEvidence();
        cancellation.abort();
        rejectResult(new Error("Capacity collection expired or cancelled."));
      },
    };
    collecting = slot;
    const timer = setTimeout(slot.cancel, maxSampleAgeMs);
    lifetime.signal.addEventListener("abort", slot.cancel, { once: true });
    const check = () => {
      assertCurrent();
      const current = checkedClock();
      if (slot.cancelled || generation !== startedGeneration || current.monotonicMs >= expiresAt) {
        slot.cancel();
        throw new Error("Capacity collection evidence expired.");
      }
      return current;
    };
    void collectRaw(cancellation.signal, check)
      .then((samples) => {
        check();
        cached = structuredClone(samples);
        resolveResult(samples);
      })
      .catch((error: unknown) => {
        if (!slot.cancelled) invalidateEvidence();
        rejectResult(error);
      })
      .finally(() => {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", slot.cancel);
        if (collecting === slot) collecting = undefined;
      });
    return result;
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
  const readPressure = ({
    hostDomain,
    runtimeDomain,
  }: {
    hostDomain: string;
    runtimeDomain: string;
  }) => {
    assertCurrent();
    const now = checkedClock();
    const runtime = policy.domains[runtimeDomain];
    if (
      policy.domains[hostDomain]?.kind !== "host" ||
      runtime?.kind !== "runtime" ||
      runtime.hostDomain !== hostDomain
    )
      throw new Error("Capacity pressure domain pair is invalid.");
    const domains = tracker.read([hostDomain, runtimeDomain], now);
    const values = Object.values(domains);
    const known = values.every((entry) => entry.pressure !== "unknown");
    return {
      domains,
      normalDwellSatisfied:
        known &&
        values.every(
          (entry) =>
            entry.pressure === "normal" &&
            entry.observedDurationMs >= policy.recovery.resumeDwellSeconds * 1000,
        ),
      sustainedPressure:
        known &&
        values.some(
          (entry) =>
            entry.pressure === "pressured" &&
            entry.observedDurationMs >= policy.recovery.observationSeconds * 1000,
        ),
    };
  };

  /**
   * Resolve the exact enrolled runtime a capacity decision may act on. Parking
   * and resume reuse the operator ensure's enrollment, domain, and reservation
   * rules, so a controller decision never rests on weaker evidence than the
   * command it replaces. The caller re-proves pressure against these domains.
   */
  const resolveCapacityTarget = async (environment: ControllerEnvironment, signal: AbortSignal) => {
    const current = readCapacityPolicy(options.directory);
    if (current?.admissions !== "enabled" || !isDeepStrictEqual(current, policy)) return undefined;
    let resolved: Awaited<ReturnType<typeof resolveCapacityEnrollment>>;
    try {
      resolved = await resolveCapacityEnrollment(
        current,
        { path: environment.repoPath, profile: environment.profile, require: [] },
        signal,
        bindingResolver,
      );
    } catch {
      return undefined;
    }
    if (signal.aborted || !isDeepStrictEqual(resolved.environment, environment)) return undefined;
    if (!isDeepStrictEqual(readCapacityPolicy(options.directory), current)) return undefined;
    const runtime = current.domains[resolved.enrollment.runtimeDomain];
    if (
      runtime?.kind !== "runtime" ||
      runtime.hostDomain !== resolved.enrollment.hostDomain ||
      current.domains[runtime.hostDomain]?.kind !== "host" ||
      !current.enrollments.some((entry) => isDeepStrictEqual(entry, resolved.enrollment))
    )
      return undefined;
    return { current, resolved, runtime };
  };

  const capacityPool = (
    runtime: { daemonId: string; hostDomain: string; hostChargeCeilingBytes: number },
    runtimeDomain: string,
  ) => ({
    daemonId: runtime.daemonId,
    runtimeDomain,
    hostDomain: runtime.hostDomain,
    hostChargeCeilingBytes: runtime.hostChargeCeilingBytes,
  });

  /**
   * The controller's bounded capacity entry point. Parking releases capacity for
   * an environment whose live consumers proved it unusable; resume returns that
   * environment once all-domain headroom dwells normal. Both are inert unless
   * the operator enables recovery, both commit under the journal lock, and both
   * drive exactly one non-destructive worker so a crash leaves re-provable
   * intent rather than a fabricated result.
   */
  const capacity: ControllerCapacityDirective = {
    async park(environment, journalRevision, observation, signal) {
      const bounded = AbortSignal.any([signal, lifetime.signal]);
      if (bounded.aborted || !policy.recovery.enabled) return false;
      const target = await resolveCapacityTarget(environment, bounded);
      if (!target || bounded.aborted) return false;
      let sustained: boolean;
      try {
        sustained = readPressure({
          hostDomain: target.resolved.enrollment.hostDomain,
          runtimeDomain: target.resolved.enrollment.runtimeDomain,
        }).sustainedPressure;
      } catch {
        return false;
      }
      if (!sustained) return false;
      const identity = environmentIdentity(environment);
      const prepared = prepareParkLifecycleOperation({
        identity,
        controller,
        policyRevision: target.current.revision,
        journalRevision,
        observationSatisfied: (journal) => observation(journal) === "unusable-consumers-proven",
      });
      if (!prepared) return false;
      // A park stop is not a user stop: it keeps parked intent on the journal and
      // proves cessation before the charge is released.
      await runLifecycleWorker(prepared.request);
      return true;
    },
    async parkedStop(identity, signal) {
      const bounded = AbortSignal.any([signal, lifetime.signal]);
      if (bounded.aborted) return false;
      // A committed park owes the environment a physical stop even if recovery
      // was switched off afterwards; refusing here would strand a held charge.
      const current = readCapacityPolicy(options.directory);
      if (current?.admissions !== "enabled" || !isDeepStrictEqual(current, policy)) return false;
      const request = reconcileParkedLifecycleStop({
        identity: { ...identity },
        controller,
        policyRevision: current.revision,
      });
      if (!request || bounded.aborted) return false;
      await runLifecycleWorker(request);
      return true;
    },
    async resume(environment, journalRevision, liveDemand, signal) {
      const bounded = AbortSignal.any([signal, lifetime.signal]);
      if (bounded.aborted || !policy.recovery.enabled) return false;
      const target = await resolveCapacityTarget(environment, bounded);
      if (!target || bounded.aborted) return false;
      let headroom: boolean;
      try {
        headroom = readPressure({
          hostDomain: target.resolved.enrollment.hostDomain,
          runtimeDomain: target.resolved.enrollment.runtimeDomain,
        }).normalDwellSatisfied;
      } catch {
        return false;
      }
      if (!headroom) return false;
      const identity = environmentIdentity(environment);
      const record = readReliabilityOperation(identity);
      if (!record) return false;
      const prepared = prepareResumeLifecycleOperation({
        identity,
        controller,
        policyRevision: target.current.revision,
        journalRevision,
        profile: environment.profile,
        actionLimit: policy.recovery.maxCorrectiveActions,
        liveDemand,
      });
      if (!prepared) return false;
      const charge = capacityRequest(target.resolved.estimates, target.resolved.enrollment, {
        environmentId: record.state.environmentId,
        profile: environment.profile,
        ...(record.activeProfile ? { activeProfile: record.activeProfile } : {}),
        kind: "ensure",
      });
      try {
        queue.enqueue(
          prepared.request,
          {
            ...charge,
            operationId: prepared.operationId,
            reservationId: randomUUID(),
            policyRevision: target.current.revision,
          },
          {
            estimates: target.resolved.estimates,
            enrollment: target.resolved.enrollment,
            pool: capacityPool(target.runtime, target.resolved.enrollment.runtimeDomain),
          },
          true,
        );
      } catch {
        // A queue that cannot hold the resume must not leave running intent
        // behind: retire the exact operation, then return to parked intent so a
        // later pass re-proves cessation instead of resuming from nothing.
        try {
          retireQueuedLifecycle(prepared.request);
          restoreParkedIntentAfterFailedResume({
            identity,
            controller,
            request: prepared.request,
          });
        } catch {
          // Retain uncertainty: the journal keeps the conservative parked state.
        }
      }
      return true;
    },
  };

  return {
    async submit(request, environment, signal, validate) {
      signal = AbortSignal.any([signal, lifetime.signal]);
      if (signal.aborted) throw new Error("Capacity submission unavailable.");
      const current = readCapacityPolicy(options.directory);
      if (current?.admissions !== "enabled" || !isDeepStrictEqual(current, policy))
        throw new Error("Capacity controller policy changed.");
      // Prove the session before the first asynchronous step so a released or
      // expired lease never reaches enrollment.
      validate();
      const resolved = await enrollCapacityLifecycle(
        current,
        {
          path: environment.repoPath,
          profile: environment.profile,
          require: [],
        },
        signal,
        options.directory,
        bindingResolver,
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
      const identity = environmentIdentity(environment);
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
      // Enrollment is asynchronous; re-prove the exact binding and map the
      // session requirements onto the prepared consumer before any journal proof.
      if (signal.aborted) throw new Error("Capacity submission binding changed.");
      const initialConsumer = validate();
      const prepared = prepareManagedLifecycleOperation({
        identity,
        controller,
        policyRevision: current.revision,
        requestId: request.requestId,
        kind: request.kind,
        profile: environment.profile,
        consumer: initialConsumer,
        runtimeRunning:
          request.kind === "exec" &&
          Boolean(resolveRunningWorkspaceContainer(environment.repoPath)),
        ...(request.kind === "exec" ? { command: request.command } : {}),
      });
      if (prepared.request && request.kind === "ensure") {
        try {
          await publishQueuedStartupWitness({
            identity,
            provider: resolved.enrollment.provider,
            providerId: resolved.enrollment.providerId,
            operationId: prepared.operationId,
            fence: prepared.request.fence,
            profile: environment.profile,
            signal,
          });
        } catch (error) {
          retireQueuedLifecycle(prepared.request);
          throw error;
        }
      }
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
          // No await between this final proof and enqueue: a release or expiry
          // that lands here retires the exact undispatched request instead of
          // stranding queued work for an absent session.
          validate();
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
      const identity = environmentIdentity(environment);
      const before = readLifecycleOperationStatus(identity, request.operationId);
      if (!before) throw new Error("Operation does not belong to this environment.");
      if (before.phase !== "terminal" && queue.observePage(request.operationId))
        await queue.wait(request.operationId, request.timeout * 1000, signal);
      if (signal.aborted) throw new Error("Capacity watch cancelled.");
      const operation = readLifecycleOperationStatus(identity, request.operationId) ?? null;
      const queued = queue.observePage(request.operationId, request.output);
      if (operation?.phase === "queued" && queued?.phase === "queued")
        operation.reason = queued.reason;
      return {
        operation,
        output: queued?.output ?? null,
      };
    },
    tick: async () => {
      try {
        assertCurrent();
        checkedClock();
      } catch {
        // The queue still retires expired requests while collection remains fenced.
        await queue.tick();
        return;
      }
      settlePreparations();
      await queue.tick({ observeIdle: policy.recovery.enabled });
    },
    pressureEvidence: readPressure,
    capacity,
    /**
     * Open or advance one bounded automatic recovery for an environment whose
     * required capability has positively failed. It is inert unless the
     * operator policy enables recovery, and every decision, budget, and
     * admission rule is the one an operator-requested ensure obeys. The
     * producing observation supplies its own proof; recovery resolves and
     * commits nothing once that proof stops matching the live journal.
     */
    async recover(environment, failedCapabilities, signal, revalidate) {
      signal = AbortSignal.any([signal, lifetime.signal]);
      if (signal.aborted || !policy.recovery.enabled) return;
      if (failedCapabilities.length === 0 || failedCapabilities.length > 64) return;
      const current = readCapacityPolicy(options.directory);
      if (current?.admissions !== "enabled" || !isDeepStrictEqual(current, policy)) return;
      // Prove the producing observation before the first asynchronous step; a
      // released session, changed generation, or advanced journal revision
      // throws here and leaves the environment unrecovered.
      let observed: ReturnType<typeof revalidate>;
      try {
        observed = revalidate();
      } catch {
        return;
      }
      // A later observation may narrow the failures a still-live consumer
      // requires; it may never author a capability the producing proof omitted.
      if (
        !failedCapabilities.some((capability) => observed.failedCapabilities.includes(capability))
      )
        return;
      let resolved: Awaited<ReturnType<typeof resolveCapacityEnrollment>>;
      try {
        resolved = await resolveCapacityEnrollment(
          current,
          { path: environment.repoPath, profile: environment.profile, require: [] },
          signal,
          bindingResolver,
        );
      } catch {
        // An unresolvable binding keeps the environment unrecovered rather than
        // acting on evidence that no longer matches the durable enrollment.
        return;
      }
      if (signal.aborted || !isDeepStrictEqual(resolved.environment, environment)) return;
      if (!isDeepStrictEqual(readCapacityPolicy(options.directory), current)) return;
      const runtime = current.domains[resolved.enrollment.runtimeDomain];
      if (
        runtime?.kind !== "runtime" ||
        runtime.hostDomain !== resolved.enrollment.hostDomain ||
        current.domains[runtime.hostDomain]?.kind !== "host" ||
        !current.enrollments.some((entry) => isDeepStrictEqual(entry, resolved.enrollment))
      )
        return;
      const identity = environmentIdentity(environment);
      const record = readReliabilityOperation(identity);
      const durable = record?.enrollment;
      // Recovery never converts or repairs enrollment: the durable binding must
      // still equal the resolved policy binding exactly, because converting it
      // would advance the journal revision the producing proof resolved against.
      // A mismatch in policy revision, common directory, provider, domains,
      // daemon, endpoint, or estimates digest forbids the action.
      if (
        !record ||
        !durable ||
        durable.policyRevision !== current.revision ||
        durable.gitCommonDir !== resolved.enrollment.gitCommonDir ||
        durable.providerId !== resolved.enrollment.providerId ||
        durable.hostDomain !== resolved.enrollment.hostDomain ||
        durable.runtimeDomain !== resolved.enrollment.runtimeDomain ||
        durable.endpoint !== runtime.endpoint ||
        durable.daemonId !== runtime.daemonId ||
        durable.estimatesDigest !== resolved.enrollment.estimatesDigest
      )
        return;
      // Never supersede an operation the queue is still working on.
      if (record.state.operation && queue.hasOperation(record.state.operation.id)) return;
      // Re-prove the exact observation immediately before the transactional
      // preparation; only the revision this proof returns may be committed.
      let proof: ReturnType<typeof revalidate>;
      try {
        proof = revalidate();
      } catch {
        return;
      }
      const required = failedCapabilities.filter(
        (capability) =>
          observed.failedCapabilities.includes(capability) &&
          proof.failedCapabilities.includes(capability),
      );
      if (required.length === 0) return;
      const pool = {
        daemonId: runtime.daemonId,
        runtimeDomain: resolved.enrollment.runtimeDomain,
        hostDomain: runtime.hostDomain,
        hostChargeCeilingBytes: runtime.hostChargeCeilingBytes,
      };
      let prepared: ReturnType<typeof prepareRecoveryLifecycleOperation>;
      try {
        // Attribute the producing failure to one declared resource before the
        // journal transaction claims it. Unreadable configuration keeps the
        // aggregate ceiling instead of guessing a unit.
        let selectors = { process: [] as string[], service: [] as string[] };
        try {
          selectors = recoverySelectorsFor({
            repoPath: environment.repoPath,
            workspace: environment.workspace,
            profile: environment.profile,
          });
        } catch {
          selectors = { process: [], service: [] };
        }
        prepared = prepareRecoveryLifecycleOperation({
          identity,
          controller,
          policyRevision: current.revision,
          journalRevision: proof.journalRevision,
          actionLimit: policy.recovery.maxCorrectiveActions,
          failedCapabilities: required,
          recoveryLimits: {
            maxProcessRestarts: policy.recovery.maxProcessRestarts,
            maxServiceRestarts: policy.recovery.maxServiceRestarts,
            windowSeconds: policy.recovery.windowSeconds,
          },
          recoverySelectors: selectors,
          // Capacity-wait exclusion is not observable in this incarnation yet;
          // the budget module then falls back to the conservative wall duration.
          activeElapsedMs: null,
          profile: environment.profile,
          incidentId: `incident-${randomUUID()}`,
        });
      } catch {
        return;
      }
      if (!prepared) return;
      const charge = capacityRequest(resolved.estimates, resolved.enrollment, {
        environmentId: record.state.environmentId,
        profile: environment.profile,
        ...(record.activeProfile ? { activeProfile: record.activeProfile } : {}),
        kind: "ensure",
      });
      try {
        // No asynchronous session request can interleave before enqueue;
        // the queue independently rechecks intent before dispatch.
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
      } catch {
        // A full queue or changed revision must not strand the journal in a
        // dispatchable recovery; settle it so the next ensure can supersede it.
        try {
          retireQueuedLifecycle(prepared.request);
        } catch {
          // Retain uncertainty: the journal keeps the conservative recovery state.
        }
      }
    },
    close() {
      invalidateEvidence();
      lifetime.abort();
      queue.close();
      acceptedPayloads.clear();
    },
  };
}

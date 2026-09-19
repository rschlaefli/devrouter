import { isDeepStrictEqual } from "node:util";
import type { CapacityDomainSample } from "./capacity-accounting";
import { readCapacityPolicy } from "./capacity-policy";
import type { CapacityAdmissionContext } from "./capacity-request";
import { CapacityHistoryError, type CapacityReservation } from "./capacity-store";
import { reliabilityFence } from "./reliability-contract";
import {
  admitLifecycleCapacity,
  renewLifecycleCapacity,
  restoreParkedIntentAfterFailedResume,
  retireQueuedLifecycle,
} from "./reliability-lifecycle";
import {
  type CapacityControllerIdentity,
  readReliabilityOperation,
} from "./reliability-operation-store";
import {
  LifecycleOutput,
  type LifecycleWorkerRequest,
  runLifecycleWorker,
} from "./reliability-worker";

type Entry = {
  request: LifecycleWorkerRequest;
  reservation: CapacityReservation;
  admission?: CapacityAdmissionContext;
  phase: "queued" | "running" | "terminal";
  reason: string | null;
  expiresAt: number;
  /** True when the entry is the ensure that automatic resume requested. */
  autoResume: boolean;
  output: LifecycleOutput;
  abort: AbortController;
  waiters: Set<() => void>;
};

/** Owns transient payload and supervision independently of connected callers. */
export class CapacityQueue {
  private entries = new Map<string, Entry>();
  private ticking = false;
  private closed = false;
  private limits: { total: number; perDomain: number; lifetimeMs: number };

  constructor(
    private options: {
      directory: string;
      policyRevision: number;
      controller?: CapacityControllerIdentity;
      collect: () => Promise<Record<string, CapacityDomainSample>>;
    },
  ) {
    const policy = readCapacityPolicy(options.directory);
    if (!policy || policy.revision !== options.policyRevision)
      throw new Error("Capacity queue requires its operator policy revision.");
    const scheduling = policy.scheduling;
    this.limits = {
      total: scheduling.maxQueuedTotal,
      perDomain: scheduling.maxQueuedPerDomain,
      lifetimeMs: scheduling.queueLifetimeSeconds * 1000,
    };
    if (
      !Number.isSafeInteger(scheduling.queueLifetimeSeconds) ||
      Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      this.limits.total > 64 ||
      this.limits.perDomain > 32 ||
      this.limits.lifetimeMs > 900_000
    )
      throw new Error("Capacity queue policy exceeds supported bounds.");
  }

  enqueue(
    request: LifecycleWorkerRequest,
    reservation: CapacityReservation,
    admission?: CapacityAdmissionContext,
    autoResume = false,
  ): string {
    if (this.closed) throw new Error("Capacity queue is closed.");
    if (request.kind === "stop" || request.operationId !== reservation.operationId)
      throw new Error("Capacity queue requires prepared non-stop intent.");
    if (reservation.policyRevision !== this.options.policyRevision)
      throw new Error("Capacity request belongs to another policy revision.");
    const existing = this.entries.get(request.operationId);
    if (existing) {
      const existingRequest =
        existing.phase === "terminal"
          ? { ...existing.request, command: undefined }
          : existing.request;
      const incomingRequest =
        existing.phase === "terminal" ? { ...request, command: undefined } : request;
      if (
        !isDeepStrictEqual(existingRequest, incomingRequest) ||
        !isDeepStrictEqual(existing.reservation, reservation) ||
        !isDeepStrictEqual(existing.admission, admission) ||
        existing.autoResume !== autoResume
      )
        throw new Error("Operation reference belongs to another accepted request.");
      return request.operationId;
    }
    const active = [...this.entries.values()].filter((entry) => entry.phase !== "terminal");
    if (
      active.length >= this.limits.total ||
      Object.keys(reservation.totals).some(
        (domain) =>
          active.filter((entry) => Object.hasOwn(entry.reservation.totals, domain)).length >=
          this.limits.perDomain,
      )
    )
      throw new Error("Capacity queue is full.");
    if (active.some((entry) => entry.reservation.environmentId === reservation.environmentId))
      throw new Error("Environment already has an accepted operation.");
    const payload = structuredClone(request);
    if (Buffer.byteLength(JSON.stringify(payload)) > 65_536)
      throw new Error("Capacity request payload exceeds byte limit.");
    // Terminal state remains authoritative in the operation journal after eviction.
    for (const [id, entry] of this.entries) {
      if (this.entries.size < 64) break;
      if (entry.phase === "terminal") this.entries.delete(id);
    }
    this.entries.set(request.operationId, {
      request: payload,
      reservation: structuredClone(reservation),
      ...(admission ? { admission: structuredClone(admission) } : {}),
      phase: "queued",
      reason: null,
      expiresAt: performance.now() + this.limits.lifetimeMs,
      autoResume,
      output: new LifecycleOutput(),
      abort: new AbortController(),
      waiters: new Set(),
    });
    return request.operationId;
  }

  /** True while the queue still owns the operation, awaiting admission or running. */
  hasOperation(operationId: string): boolean {
    const entry = this.entries.get(operationId);
    return entry !== undefined && entry.phase !== "terminal";
  }

  observe(operationId: string) {
    const entry = this.entries.get(operationId);
    return entry
      ? { operationId, phase: entry.phase, reason: entry.reason, output: entry.output.read() }
      : undefined;
  }

  observePage(operationId: string, cursor?: Parameters<LifecycleOutput["readPage"]>[0]) {
    const entry = this.entries.get(operationId);
    return entry
      ? {
          operationId,
          phase: entry.phase,
          reason: entry.reason,
          output: entry.output.readPage(cursor),
        }
      : undefined;
  }

  async wait(operationId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 900_000)
      throw new Error("Invalid capacity caller wait.");
    const entry = this.entries.get(operationId);
    if (!entry) throw new Error("Operation is no longer in the transient queue.");
    if (signal?.aborted) throw new Error("Capacity wait was cancelled.");
    if (entry.phase === "terminal") return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        entry.waiters.delete(onFinished);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onFinished = () => settle(() => resolve(true));
      const onAbort = () => settle(() => reject(new Error("Capacity wait was cancelled.")));

      entry.waiters.add(onFinished);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => settle(() => resolve(false)), timeoutMs);
    });
  }

  async tick(options: { observeIdle?: boolean } = {}): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const entry of this.entries.values()) {
        if (entry.phase === "queued" && performance.now() >= entry.expiresAt)
          this.retire(entry, "queue-expired");
      }
      if (
        !options.observeIdle &&
        ![...this.entries.values()].some(
          (entry) =>
            (entry.phase === "queued" && performance.now() < entry.expiresAt) ||
            (entry.phase === "running" && this.options.controller !== undefined),
        )
      )
        return;
      let policy: ReturnType<typeof readCapacityPolicy>;
      try {
        policy = readCapacityPolicy(this.options.directory);
      } catch {
        this.pause("policy-unavailable");
        return;
      }
      if (policy?.admissions !== "enabled" || policy.revision !== this.options.policyRevision) {
        this.pause("policy-unavailable");
        return;
      }
      const policyBytes = JSON.stringify(policy);
      let samples: Record<string, CapacityDomainSample>;
      try {
        samples = await this.options.collect();
      } catch (error) {
        this.pause(error instanceof CapacityHistoryError ? error.code : "collection-unavailable");
        return;
      }
      if (this.closed) return;
      if (this.options.controller) {
        for (const entry of this.entries.values()) {
          if (entry.phase !== "running") continue;
          try {
            entry.reason = renewLifecycleCapacity(
              entry.request,
              policy,
              samples,
              this.options.controller,
              this.options.directory,
            )
              ? null
              : "authority-unavailable";
          } catch {
            entry.reason = "authority-unavailable";
          }
        }
      }
      const waitingDomains = new Set<string>();
      for (const entry of this.entries.values()) {
        if (entry.phase !== "queued") continue;
        const domains = Object.keys(entry.reservation.totals);
        if (
          performance.now() >= entry.expiresAt ||
          domains.some((domain) => waitingDomains.has(domain))
        ) {
          for (const domain of domains) waitingDomains.add(domain);
          continue;
        }
        let decision: ReturnType<typeof admitLifecycleCapacity>;
        try {
          if (JSON.stringify(readCapacityPolicy(this.options.directory)) !== policyBytes) {
            this.pause("policy-changed");
            return;
          }
          decision = admitLifecycleCapacity(
            entry.request,
            entry.reservation,
            policy.domains,
            samples,
            Date.now(),
            policy.scheduling.maxSampleAgeSeconds * 1000,
            this.options.directory,
            this.options.controller,
            entry.admission,
          );
        } catch (error) {
          if (error instanceof CapacityHistoryError) {
            entry.reason = error.code;
            try {
              const record = readReliabilityOperation(entry.request.identity);
              const operation =
                record?.state.operation?.id === entry.request.operationId
                  ? record.state.operation
                  : record?.state.operationHistory.find(
                      (operation) => operation.id === entry.request.operationId,
                    );
              if (
                record &&
                (!isDeepStrictEqual(reliabilityFence(record.state), entry.request.fence) ||
                  record.state.operation?.id !== entry.request.operationId) &&
                operation?.drained &&
                ["NOT_STARTED", "NOT_LAUNCHED"].includes(operation.status) &&
                record.worker?.operationId !== entry.request.operationId
              ) {
                // Durable supersession and drainage suffice to retire this transient
                // request. A history failure must not rewrite the surviving journal.
                entry.reason = "intent-superseded";
                entry.phase = "terminal";
                entry.request.command = undefined;
                this.finish(entry);
              }
            } catch {
              // Unavailable history cannot prove a queued worker absent.
            }
            if (entry.phase === "queued") for (const domain of domains) waitingDomains.add(domain);
            continue;
          }
          try {
            if (retireQueuedLifecycle(entry.request, true)) {
              entry.reason = "intent-superseded";
              entry.phase = "terminal";
              entry.request.command = undefined;
              this.finish(entry);
              continue;
            }
          } catch {
            // Retain uncertainty when supersession cannot prove dispatch absence.
          }
          // An uncertain journal or reservation blocks this domain, not unrelated work.
          entry.reason = "admission-unavailable";
          for (const domain of domains) waitingDomains.add(domain);
          continue;
        }
        if (!decision.admitted) {
          entry.reason = decision.reason;
          for (const domain of domains) waitingDomains.add(domain);
          continue;
        }
        if (performance.now() >= entry.expiresAt) {
          this.retire(entry, "queue-expired");
          if (entry.phase === "queued") for (const domain of domains) waitingDomains.add(domain);
          continue;
        }
        entry.phase = "running";
        entry.reason = null;
        void runLifecycleWorker(entry.request, { signal: entry.abort.signal, output: entry.output })
          .catch(() => {
            entry.reason = "worker-unavailable";
          })
          .finally(() => {
            entry.phase = "terminal";
            entry.request.command = undefined;
            this.finish(entry);
          });
      }
    } finally {
      this.ticking = false;
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.abort.abort();
      if (entry.phase === "queued") this.retire(entry, "controller-stopped");
    }
  }

  private pause(reason: string): void {
    for (const entry of this.entries.values()) if (entry.phase === "queued") entry.reason = reason;
  }

  private finish(entry: Entry): void {
    for (const notify of entry.waiters) notify();
  }

  private retire(entry: Entry, reason: string): void {
    try {
      retireQueuedLifecycle(entry.request);
    } catch {
      entry.reason = "retirement-unproven";
      return;
    }
    // A resume that never dispatched has no home for its running intent. Return
    // it to the park it came from so a later pass re-proves cessation and demand
    // instead of leaving the environment wedged in intent no worker will honor.
    if (entry.autoResume && this.options.controller) {
      try {
        restoreParkedIntentAfterFailedResume({
          identity: entry.request.identity,
          controller: this.options.controller,
          request: entry.request,
        });
      } catch {
        // Retain the conservative running intent; a later ensure supersedes it.
      }
    }
    entry.reason = reason;
    entry.phase = "terminal";
    entry.request.command = undefined;
    this.finish(entry);
  }
}

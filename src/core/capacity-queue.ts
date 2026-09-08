import type { CapacityDomainSample } from "./capacity-accounting";
import { readCapacityPolicy } from "./capacity-policy";
import type { CapacityReservation } from "./capacity-store";
import { admitLifecycleCapacity, retireQueuedLifecycle } from "./reliability-lifecycle";
import {
  LifecycleOutput,
  type LifecycleWorkerRequest,
  runLifecycleWorker,
} from "./reliability-worker";

type Entry = {
  request: LifecycleWorkerRequest;
  reservation: CapacityReservation;
  phase: "queued" | "running" | "terminal";
  reason: string | null;
  expiresAt: number;
  output: LifecycleOutput;
  abort: AbortController;
  finished: Promise<void>;
  finish: () => void;
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

  enqueue(request: LifecycleWorkerRequest, reservation: CapacityReservation): string {
    if (this.closed) throw new Error("Capacity queue is closed.");
    if (request.kind === "stop" || request.operationId !== reservation.operationId)
      throw new Error("Capacity queue requires prepared non-stop intent.");
    if (reservation.policyRevision !== this.options.policyRevision)
      throw new Error("Capacity request belongs to another policy revision.");
    const existing = this.entries.get(request.operationId);
    if (existing) {
      if (
        existing.request.requestId !== request.requestId ||
        existing.request.workerId !== request.workerId ||
        existing.request.repoPath !== request.repoPath ||
        existing.reservation.reservationId !== reservation.reservationId ||
        existing.reservation.environmentId !== reservation.environmentId
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
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Terminal state remains authoritative in the operation journal after eviction.
    for (const [id, entry] of this.entries) {
      if (this.entries.size < 64) break;
      if (entry.phase === "terminal") this.entries.delete(id);
    }
    this.entries.set(request.operationId, {
      request: payload,
      reservation: structuredClone(reservation),
      phase: "queued",
      reason: null,
      expiresAt: performance.now() + this.limits.lifetimeMs,
      output: new LifecycleOutput(),
      abort: new AbortController(),
      finished,
      finish,
    });
    return request.operationId;
  }

  observe(operationId: string) {
    const entry = this.entries.get(operationId);
    return entry
      ? { operationId, phase: entry.phase, reason: entry.reason, output: entry.output.read() }
      : undefined;
  }

  async wait(operationId: string, timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 900_000)
      throw new Error("Invalid capacity caller wait.");
    const entry = this.entries.get(operationId);
    if (!entry) throw new Error("Operation is no longer in the transient queue.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        entry.finished.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const entry of this.entries.values()) {
        if (entry.phase === "queued" && performance.now() >= entry.expiresAt)
          this.retire(entry, "queue-expired");
      }
      if (
        ![...this.entries.values()].some(
          (entry) => entry.phase === "queued" && performance.now() < entry.expiresAt,
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
      const samples = await this.options.collect();
      if (this.closed) return;
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
          );
        } catch {
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
        entry.phase = "running";
        entry.reason = null;
        void runLifecycleWorker(entry.request, { signal: entry.abort.signal, output: entry.output })
          .catch(() => {
            entry.reason = "worker-unavailable";
          })
          .finally(() => {
            entry.phase = "terminal";
            entry.request.command = undefined;
            entry.finish();
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

  private retire(entry: Entry, reason: string): void {
    try {
      retireQueuedLifecycle(entry.request);
      entry.reason = reason;
      entry.phase = "terminal";
      entry.request.command = undefined;
      entry.finish();
    } catch {
      entry.reason = "retirement-unproven";
    }
  }
}

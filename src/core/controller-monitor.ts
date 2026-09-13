import type { ControllerEnvironment } from "./controller-store";
import type { ReliabilityObservation } from "./reliability-contract";
import type {
  ReliabilityIdentity,
  ReliabilityOperationRecord,
} from "./reliability-operation-store";

export class ControllerObservationBindingChanged extends Error {}

export type ControllerObservationBatch = {
  environment: ControllerEnvironment;
  identity: ReliabilityIdentity;
  journal: ReliabilityOperationRecord;
  sampledAtMs: number;
  runtimeFingerprint: string;
  capabilities: ReliabilityObservation[];
  stopped: boolean;
  /** Bounded local persisted reads only. Called under the manual journal lock. */
  revalidatePersisted: () => boolean;
};
export type ControllerObservationCollector = (
  environment: ControllerEnvironment,
  requirements: string[],
  signal: AbortSignal,
) => Promise<ControllerObservationBatch>;

/**
 * The controller's bounded, policy-gated recovery entry point. The monitor
 * detects a positively failed required capability and asks the operations
 * owner to open or advance one recovery; it never decides the action itself.
 */
export type ControllerRecovery = (
  environment: ControllerEnvironment,
  failedCapabilities: string[],
  signal: AbortSignal,
) => Promise<void>;

import { createHash } from "node:crypto";
import type { ControllerBinding, ControllerSessions } from "./controller-sessions";
import type { ControllerProjection } from "./controller-store";
import { withReliabilityObservationFence } from "./reliability-operation-store";
import { projectReliability } from "./reliability-output";

export function controllerCapability(selector: string): string {
  return selector === "runtime"
    ? "runtime"
    : `app-${createHash("sha256").update(selector).digest("hex")}`;
}

/** Two fair batches at most; publication alone enters the owner serializer. */
export class ControllerMonitor {
  private active = new Map<string, AbortController>();
  private lastStarted = new Map<string, number>();
  private stopped = false;
  constructor(
    private readonly sessions: ControllerSessions,
    private readonly collect: ControllerObservationCollector,
    private readonly serialize: (operation: () => void) => Promise<void>,
    private readonly clock = () => Math.floor(performance.now()),
    private readonly fence = withReliabilityObservationFence,
    private readonly recover?: ControllerRecovery,
  ) {}
  stop(): void {
    this.stopped = true;
    for (const abort of this.active.values()) abort.abort();
  }
  tick(): void {
    if (this.stopped) return;
    const snapshot = this.sessions.read();
    const current = new Set(snapshot.environments.map((env) => env.id));
    for (const [id, abort] of this.active) if (!current.has(id)) abort.abort();
    for (const id of this.lastStarted.keys()) if (!current.has(id)) this.lastStarted.delete(id);
    const now = this.clock();
    const candidates = snapshot.environments
      .filter(
        (env) =>
          !this.active.has(env.id) && now - (this.lastStarted.get(env.id) ?? -Infinity) >= 5000,
      )
      .sort(
        (a, b) =>
          (this.lastStarted.get(a.id) ?? -Infinity) - (this.lastStarted.get(b.id) ?? -Infinity),
      );
    for (const environment of candidates) {
      if (this.active.size >= 2) break;
      const consumers = snapshot.sessions.filter(
        (session) => session.environmentId === environment.id,
      );
      const bindings: ControllerBinding[] = consumers.map((session) => ({
        session: session.id,
        generation: session.generation,
        store: snapshot.store,
        epoch: snapshot.epoch,
      }));
      const requirements = [...new Set(consumers.flatMap((session) => session.requirements))];
      const abort = new AbortController();
      this.active.set(environment.id, abort);
      this.lastStarted.set(environment.id, now);
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener(
          "abort",
          () => reject(new Error("Observation batch cancelled.")),
          { once: true },
        );
      });
      const timeout = setTimeout(() => abort.abort(), 10_000);
      const collection = this.collect(environment, requirements, abort.signal);
      // An unresponsive probe keeps its slot until it actually drains. A
      // timeout cannot authorize an unbounded succession of replacement probes.
      const drained = () => {
        this.active.delete(environment.id);
      };
      void collection.then(drained, drained);
      void Promise.race([collection, cancelled])
        .then(async (batch) => {
          if (this.stopped || abort.signal.aborted) return;
          await this.serialize(() => {
            const commitTime = this.clock();
            this.sessions.tick(commitTime, Date.now());
            if (
              this.stopped ||
              abort.signal.aborted ||
              batch.sampledAtMs < now ||
              commitTime - batch.sampledAtMs >= 15_000 ||
              JSON.stringify(batch.environment) !== JSON.stringify(environment)
            )
              return;
            this.fence(batch.identity, batch.journal.revision, (journal) => {
              if (!batch.revalidatePersisted())
                throw new ControllerObservationBindingChanged(
                  "Observation persisted fence changed.",
                );
              const projections = new Map<string, ControllerProjection>();
              for (const consumer of consumers) {
                const transient = structuredClone(journal.state);
                const consumerId = `observer-${createHash("sha256").update(consumer.id).digest("hex")}`;
                transient.consumers = [
                  {
                    id: consumerId,
                    requiredCapabilities: consumer.requirements.map(controllerCapability),
                    pinned: false,
                  },
                ];
                transient.observations = batch.capabilities.map((capability) => ({
                  ...capability,
                  observedAtMs: Math.max(Date.now(), transient.observationsAfterMs),
                  validForMs: 15_000,
                }));
                if (transient.desired === "stopped-by-user" && !batch.stopped)
                  transient.stopProof = { workloadsStopped: false, routesRemoved: false };
                const status = projectReliability(
                  transient,
                  consumerId,
                  Math.max(Date.now(), transient.observationsAfterMs),
                ).state;
                projections.set(consumer.id, {
                  status,
                  sampledAtMs: batch.sampledAtMs,
                  validUntilMs: batch.sampledAtMs + 15_000,
                  journalRevision: journal.revision,
                  runtimeFingerprint: batch.runtimeFingerprint,
                });
              }
              this.sessions.publish(bindings, projections, commitTime, Date.now());
            });
          });
          if (this.recover === undefined || this.stopped) return;
          const required = new Set(requirements.map(controllerCapability));
          const failed = batch.capabilities
            .filter(
              (capability) =>
                capability.infrastructure === "failed" && required.has(capability.capability),
            )
            .map((capability) => capability.capability);
          if (failed.length > 0)
            void this.recover(
              batch.environment,
              failed,
              this.active.get(environment.id)?.signal ?? abort.signal,
            ).catch(() => {});
        })
        .catch(async (error) => {
          if (!this.stopped)
            await this.serialize(() => {
              this.sessions.invalidate(
                environment.id,
                error instanceof ControllerObservationBindingChanged,
                bindings,
              );
            });
        })
        .finally(() => {
          clearTimeout(timeout);
        })
        .catch(() => {});
    }
  }
}

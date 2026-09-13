import type { ControllerEnvironment } from "./controller-store";
import type { ReliabilityObservation, ReliabilityOperation } from "./reliability-contract";
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
  revalidate: () => { journalRevision: number; failedCapabilities: string[] },
) => Promise<void>;

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ControllerBinding, ControllerSessions } from "./controller-sessions";
import type { ControllerProjection, ControllerSession } from "./controller-store";
import { withReliabilityObservationFence } from "./reliability-operation-store";
import { projectReliability } from "./reliability-output";

export function controllerCapability(selector: string): string {
  return selector === "runtime"
    ? "runtime"
    : `app-${createHash("sha256").update(selector).digest("hex")}`;
}

export type ControllerParkingObservation =
  | "observation-unavailable"
  | "consumer-set-changed"
  | "history-unproven"
  | "unresolved-consumers"
  | "consent-withheld"
  | "observation-stale"
  | "journal-changed"
  | "human-pinned"
  | "intent-protected"
  | "lifecycle-unsettled"
  | "capability-unknown"
  | "application-error"
  | "consumer-usable"
  | "ownership-unproven"
  | "unusable-consumers-proven";

function parkingConsumers(consumers: ControllerSession[]) {
  return consumers
    .map(({ id, generation, requirements, parkingConsent, consentRevision }) => ({
      id,
      generation,
      requirements: [...requirements].sort(),
      parkingConsent,
      consentRevision,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

type ParkingObservation = {
  store: string;
  epoch: number;
  parkingRevision: number;
  consumers: ReturnType<typeof parkingConsumers>;
  environment: ControllerEnvironment;
  identity: ReliabilityIdentity;
  journalRevision: number;
  startedAtMs: number;
  sampledAtMs: number;
  runtimeFingerprint: string;
  capabilities: ReliabilityObservation[];
  revalidatePersisted: () => boolean;
};

/** Two fair batches at most; publication alone enters the owner serializer. */
export class ControllerMonitor {
  private active = new Map<string, AbortController>();
  private lastStarted = new Map<string, number>();
  private stopped = false;
  private parkingObservations = new Map<string, ParkingObservation>();
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
    this.parkingObservations.clear();
    for (const abort of this.active.values()) abort.abort();
  }
  /** One prerequisite only. Caller holds the journal fence; this acquires no lock. */
  parkingObservation(
    environment: ControllerEnvironment,
    journal: ReliabilityOperationRecord,
  ): ControllerParkingObservation {
    const evidence = this.parkingObservations.get(environment.id);
    if (this.stopped || !evidence) return "observation-unavailable";
    const now = this.clock();
    this.sessions.tick(now, Date.now());
    const snapshot = this.sessions.read();
    const consumers = snapshot.sessions.filter(
      (session) => session.environmentId === environment.id,
    );
    if (
      evidence.store !== snapshot.store ||
      evidence.epoch !== snapshot.epoch ||
      evidence.parkingRevision !== snapshot.parkingRevision ||
      !isDeepStrictEqual(environment, evidence.environment) ||
      !isDeepStrictEqual(
        snapshot.environments.find((entry) => entry.id === environment.id),
        environment,
      ) ||
      !isDeepStrictEqual(parkingConsumers(consumers), evidence.consumers)
    )
      return "consumer-set-changed";
    if (snapshot.history !== "complete") return "history-unproven";
    if (snapshot.retainedSessions.some((session) => session.environment.id === environment.id))
      return "unresolved-consumers";
    if (
      !consumers.length ||
      consumers.some((session) => session.parkingConsent !== "allow-unusable")
    )
      return "consent-withheld";
    if (
      evidence.sampledAtMs < evidence.startedAtMs ||
      evidence.sampledAtMs > now ||
      now - evidence.sampledAtMs >= 15_000 ||
      consumers.some(
        ({ observation }) =>
          !observation ||
          observation.sampledAtMs !== evidence.sampledAtMs ||
          observation.journalRevision !== evidence.journalRevision ||
          observation.runtimeFingerprint !== evidence.runtimeFingerprint ||
          observation.validUntilMs !== evidence.sampledAtMs + 15_000 ||
          observation.validUntilMs <= now,
      )
    )
      return "observation-stale";
    if (
      journal.revision !== evidence.journalRevision ||
      !isDeepStrictEqual(journal.identity, evidence.identity)
    )
      return "journal-changed";
    if (journal.consumerProtection?.humanPinned) return "human-pinned";
    if (journal.state.desired !== "running") return "intent-protected";
    const operations: ReliabilityOperation[] = [...journal.state.operationHistory];
    if (journal.state.operation) operations.push(journal.state.operation);
    if (
      journal.worker ||
      !["stable", "recovering"].includes(journal.state.phase) ||
      operations.some(
        (operation) =>
          !operation.drained ||
          !["COMPLETED", "NOT_LAUNCHED", "INTERRUPTED"].includes(operation.status) ||
          (operation.kind === "exec" && operation.status === "INTERRUPTED"),
      )
    )
      return "lifecycle-unsettled";
    const required = consumers.map((consumer) =>
      consumer.requirements.map((selector) =>
        evidence.capabilities.filter(
          (capability) => capability.capability === controllerCapability(selector),
        ),
      ),
    );
    if (
      required.some((capabilities) =>
        capabilities.some(
          (matches) => matches.length !== 1 || matches[0].infrastructure === "unknown",
        ),
      )
    )
      return "capability-unknown";
    if (
      required.some((capabilities) =>
        capabilities.some(([capability]) => capability.application === "unready"),
      )
    )
      return "application-error";
    if (
      required.some(
        (capabilities) =>
          !capabilities.some(([capability]) => capability.infrastructure === "failed"),
      )
    )
      return "consumer-usable";
    try {
      if (!evidence.revalidatePersisted()) return "ownership-unproven";
    } catch {
      return "ownership-unproven";
    }
    return "unusable-consumers-proven";
  }
  tick(): void {
    if (this.stopped) return;
    const snapshot = this.sessions.read();
    const current = new Set(snapshot.environments.map((env) => env.id));
    for (const [id, abort] of this.active) if (!current.has(id)) abort.abort();
    for (const id of this.lastStarted.keys()) if (!current.has(id)) this.lastStarted.delete(id);
    for (const id of this.parkingObservations.keys())
      if (!current.has(id)) this.parkingObservations.delete(id);
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
              batch.sampledAtMs > commitTime ||
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
              const currentEnvironments = new Set(
                this.sessions.read().environments.map((entry) => entry.id),
              );
              for (const id of this.parkingObservations.keys())
                if (!currentEnvironments.has(id)) this.parkingObservations.delete(id);
              if (currentEnvironments.has(environment.id))
                this.parkingObservations.set(environment.id, {
                  store: snapshot.store,
                  epoch: snapshot.epoch,
                  parkingRevision: snapshot.parkingRevision,
                  consumers: parkingConsumers(consumers),
                  environment: structuredClone(environment),
                  identity: structuredClone(batch.identity),
                  journalRevision: journal.revision,
                  startedAtMs: now,
                  sampledAtMs: batch.sampledAtMs,
                  runtimeFingerprint: batch.runtimeFingerprint,
                  capabilities: structuredClone(batch.capabilities),
                  revalidatePersisted: batch.revalidatePersisted,
                });
            });
            if (this.recover === undefined || this.stopped || abort.signal.aborted) return;
            const revalidate = () => {
              const time = this.clock();
              this.sessions.tick(time, Date.now());
              if (
                this.stopped ||
                abort.signal.aborted ||
                batch.sampledAtMs < now ||
                batch.sampledAtMs > time ||
                time - batch.sampledAtMs >= 15_000 ||
                JSON.stringify(batch.environment) !== JSON.stringify(environment)
              )
                throw new ControllerObservationBindingChanged("Recovery observation expired.");
              return this.fence(batch.identity, batch.journal.revision, () => {
                if (!batch.revalidatePersisted())
                  throw new ControllerObservationBindingChanged(
                    "Recovery persisted fence changed.",
                  );
                const required = new Set<string>();
                for (const binding of bindings) {
                  try {
                    const consumer = this.sessions.validate(binding);
                    const bound = this.sessions
                      .read()
                      .environments.find((entry) => entry.id === consumer.environmentId);
                    if (JSON.stringify(bound) !== JSON.stringify(environment)) continue;
                    for (const selector of consumer.requirements)
                      required.add(controllerCapability(selector));
                  } catch {
                    // Only surviving original bindings may use this observation.
                  }
                }
                return {
                  journalRevision: batch.journal.revision,
                  failedCapabilities: batch.capabilities
                    .filter(
                      (capability) =>
                        capability.infrastructure === "failed" &&
                        required.has(capability.capability),
                    )
                    .map((capability) => capability.capability),
                };
              });
            };
            const proof = revalidate();
            if (proof.failedCapabilities.length > 0)
              void this.recover(
                batch.environment,
                proof.failedCapabilities,
                abort.signal,
                revalidate,
              ).catch(() => {});
          });
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

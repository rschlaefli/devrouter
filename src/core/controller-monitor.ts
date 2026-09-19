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

/**
 * The controller's bounded capacity entry point. The monitor supplies the live
 * observation and demand proofs; the controller owns policy, victim choice,
 * admission and worker dispatch. Returning true means the pass changed durable
 * lifecycle intent, so the monitor stops after one victim per pass.
 */
export type ControllerCapacityDirective = {
  park: (
    environment: ControllerEnvironment,
    journalRevision: number,
    observation: (journal: ReliabilityOperationRecord) => ControllerParkingObservation,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /**
   * Finish a committed park whose physical stop never ran to completion. The
   * durable journal names the environment, so this is driven by identity rather
   * than by a live session: the last consumer may already be gone.
   */
  parkedStop: (identity: ReliabilityIdentity, signal: AbortSignal) => Promise<boolean>;
  resume: (
    environment: ControllerEnvironment,
    journalRevision: number,
    liveDemand: () => string[],
    signal: AbortSignal,
  ) => Promise<boolean>;
};

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ControllerBinding, ControllerSessions } from "./controller-sessions";
import type { ControllerProjection, ControllerSession } from "./controller-store";
import {
  listReliabilityOperations,
  readReliabilityOperation,
  withReliabilityObservationFence,
} from "./reliability-operation-store";
import { projectReliability } from "./reliability-output";

export function controllerCapability(selector: string): string {
  return selector === "runtime"
    ? "runtime"
    : `app-${createHash("sha256").update(selector).digest("hex")}`;
}

/**
 * Deterministic consumer identity for one live session binding. Every request
 * from one session keeps the same consumer, so a reconnect under the same
 * generation stays idempotent and a lost session can never be impersonated.
 */
export function sessionConsumerId(input: {
  store: string;
  epoch: number;
  session: string;
  generation: string;
}): string {
  const { store, epoch, session, generation } = input;
  return `session-${createHash("sha256")
    .update(JSON.stringify([store, epoch, session, generation]))
    .digest("hex")}`;
}

/** The durable journal identity of one live environment binding. */
export function environmentIdentity(environment: ControllerEnvironment): ReliabilityIdentity {
  return {
    repoPath: environment.repoPath,
    workspace: environment.workspace || null,
    provider: environment.provider,
  };
}

function identityKey(identity: ReliabilityIdentity): string {
  return JSON.stringify([identity.repoPath, identity.workspace, identity.provider]);
}

/** How often the durable journal is enumerated for an unfinished park stop. */
const UNFINISHED_PARK_SCAN_MS = 10_000;

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
  private capacityActive = new Set<string>();
  private lastCapacity = new Map<string, number>();
  private unfinishedParkActive = new Set<string>();
  private lastUnfinishedParkScan: number | undefined;
  private readonly lifetime = new AbortController();
  private stopped = false;
  private parkingObservations = new Map<string, ParkingObservation>();
  constructor(
    private readonly sessions: ControllerSessions,
    private readonly collect: ControllerObservationCollector,
    private readonly serialize: (operation: () => void) => Promise<void>,
    private readonly clock = () => Math.floor(performance.now()),
    private readonly fence = withReliabilityObservationFence,
    private readonly recover?: ControllerRecovery,
    private readonly capacity?: ControllerCapacityDirective,
    private readonly readJournal: (
      identity: ReliabilityIdentity,
    ) => ReliabilityOperationRecord | undefined = readReliabilityOperation,
    private readonly listJournals: () => ReliabilityOperationRecord[] = listReliabilityOperations,
  ) {}
  stop(): void {
    this.stopped = true;
    this.lifetime.abort();
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
  /**
   * Exact live demand for one environment. Unknown or drifting session state
   * throws instead of returning an empty set, because a resume that cannot prove
   * demand must stay parked.
   */
  private liveConsumerIds(environment: ControllerEnvironment): string[] {
    const evidence = this.parkingObservations.get(environment.id);
    const snapshot = this.sessions.read();
    if (!evidence || evidence.store !== snapshot.store || evidence.epoch !== snapshot.epoch)
      throw new Error("Controller demand evidence is unavailable.");
    if (evidence.parkingRevision !== snapshot.parkingRevision)
      throw new Error("Controller demand binding changed.");
    const consumers = snapshot.sessions.filter(
      (session) => session.environmentId === environment.id,
    );
    if (!isDeepStrictEqual(parkingConsumers(consumers), evidence.consumers))
      throw new Error("Controller demand set changed.");
    return consumers.map((session) =>
      sessionConsumerId({
        store: snapshot.store,
        epoch: snapshot.epoch,
        session: session.id,
        generation: session.generation,
      }),
    );
  }
  /**
   * One bounded capacity decision per pass. The controller owns policy, victim
   * eligibility, admission and dispatch; this pass only supplies the live proof
   * it holds, keeps at most one victim in flight per incarnation, and never
   * retries an environment it just acted on.
   */
  private async capacityPass(): Promise<void> {
    if (this.stopped || !this.capacity) return;
    const snapshot = this.sessions.read();
    const now = this.clock();
    // A committed park outlives the session that requested it, so its stop is
    // reconciled from the durable journal before any live-session decision.
    if (await this.reconcileUnfinishedParkStops(now)) return;
    for (const environment of snapshot.environments) {
      if (this.stopped) return;
      if (this.capacityActive.has(environment.id)) continue;
      const evidence = this.parkingObservations.get(environment.id);
      if (!evidence || !isDeepStrictEqual(evidence.environment, environment)) continue;
      if (now - (this.lastCapacity.get(environment.id) ?? -Infinity) < 5000) continue;
      this.lastCapacity.set(environment.id, now);
      this.capacityActive.add(environment.id);
      const abort = this.lifetime;
      let acted = false;
      try {
        await this.serialize(async () => {
          if (this.stopped || abort.signal.aborted || !this.capacity) return;
          const record = this.readJournal(evidence.identity);
          if (!record) return;
          if (record.state.executionPolicy !== "capacity-managed") return;
          if (record.state.desired === "parked-for-capacity") {
            const settled =
              record.state.stopProof.workloadsStopped && record.state.stopProof.routesRemoved;
            // An unsettled stop is not a live-session decision: the durable
            // reconciliation above owns it, with or without a remaining session.
            if (settled)
              acted = await this.capacity.resume(
                environment,
                record.revision,
                () => this.liveConsumerIds(environment),
                abort.signal,
              );
            return;
          }
          if (record.state.desired !== "running") return;
          acted = await this.capacity.park(
            environment,
            record.revision,
            (journal) => this.parkingObservation(environment, journal),
            abort.signal,
          );
        });
      } catch {
        // A refused or failed decision leaves the environment untouched; the next
        // pass re-proves observation, pressure and demand before acting again.
      } finally {
        this.capacityActive.delete(environment.id);
      }
      // One victim per pass keeps a capacity decision subordinate to the next
      // observation rather than draining the whole host in one tick.
      if (acted) return;
    }
  }
  /**
   * Re-drive a committed park whose physical stop never finished. The durable
   * journal is the only authority that can still name that environment once the
   * controller restarts or the last consumer session expires, so this pass
   * enumerates journals instead of the live snapshot, re-proves each candidate
   * under the controller's own transactional reconciliation, and drives at most
   * one stop. Refusals and unreadable journals leave the held charge untouched
   * for a later pass rather than authorizing a stop on weaker evidence.
   */
  private async reconcileUnfinishedParkStops(now: number): Promise<boolean> {
    if (now - (this.lastUnfinishedParkScan ?? -Infinity) < UNFINISHED_PARK_SCAN_MS) return false;
    this.lastUnfinishedParkScan = now;
    let journals: ReliabilityOperationRecord[];
    try {
      journals = this.listJournals();
    } catch {
      // Journal authority is unavailable, so no unfinished park can be proven.
      return false;
    }
    for (const record of journals) {
      if (this.stopped || !this.capacity) return false;
      if (record.state.executionPolicy !== "capacity-managed") continue;
      if (record.state.desired !== "parked-for-capacity") continue;
      if (record.state.stopProof.workloadsStopped && record.state.stopProof.routesRemoved) continue;
      const key = identityKey(record.identity);
      if (this.unfinishedParkActive.has(key)) continue;
      this.unfinishedParkActive.add(key);
      const abort = this.lifetime;
      let acted = false;
      try {
        await this.serialize(async () => {
          if (this.stopped || abort.signal.aborted || !this.capacity) return;
          acted = await this.capacity.parkedStop({ ...record.identity }, abort.signal);
        });
      } catch {
        // A refused stop leaves the durable park untouched for a later pass.
      } finally {
        this.unfinishedParkActive.delete(key);
      }
      if (acted) return true;
    }
    return false;
  }
  tick(): void {
    if (this.stopped) return;
    void this.capacityPass();
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

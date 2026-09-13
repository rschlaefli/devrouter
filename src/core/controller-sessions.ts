import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ControllerEnvironment,
  ControllerEvent,
  ControllerProjection,
  ControllerSession,
  ControllerSnapshot,
  ControllerStore,
} from "./controller-store";

export type ControllerBinding = {
  session: string;
  store: string;
  epoch: number;
  generation: string;
};
export class ControllerSessions {
  private snapshot: ControllerSnapshot;
  private leases = new Map<string, number>();
  private previousTime: { monotonic: number; wall: number } | undefined;
  private failed = false;
  private uncertainty:
    | { since: number; reason: "continuity-unknown" | "orphan-suspected" }
    | undefined;
  constructor(private readonly store: ControllerStore) {
    this.snapshot = store.startIncarnation();
  }
  read(): ControllerSnapshot {
    this.assertHealthy();
    return structuredClone(this.snapshot);
  }
  private assertHealthy() {
    if (this.failed) throw new Error("Controller durability is unknown; restart required.");
  }
  private commit(next: ControllerSnapshot) {
    this.assertHealthy();
    if (next.revision === Number.MAX_SAFE_INTEGER)
      throw new Error("Controller revision exhausted.");
    next.revision++;
    try {
      this.store.persist(next);
    } catch {
      this.failed = true;
      throw new Error("Controller durability is unknown; restart required.");
    }
    this.snapshot = next;
  }
  private event(
    next: ControllerSnapshot,
    session: ControllerSession,
    kind: ControllerEvent["kind"],
  ) {
    if (next.nextSequence === Number.MAX_SAFE_INTEGER)
      throw new Error("Controller event sequence exhausted.");
    next.events.push({
      sequence: next.nextSequence++,
      session: session.id,
      generation: session.generation,
      kind,
    });
    while (next.events.length > 256 || Buffer.byteLength(JSON.stringify(next.events)) > 262_144)
      next.events.shift();
  }
  private removeUnused(next: ControllerSnapshot) {
    next.environments = next.environments.filter((env) =>
      next.sessions.some((s) => s.environmentId === env.id),
    );
  }
  private advanceParking(next: ControllerSnapshot) {
    if (next.parkingRevision === Number.MAX_SAFE_INTEGER)
      throw new Error("Controller parking revision exhausted.");
    next.parkingRevision++;
  }
  private retain(
    next: ControllerSnapshot,
    session: ControllerSession,
    reason: "expired" | "discontinuity" | "binding-changed",
  ) {
    const environment = next.environments.find((entry) => entry.id === session.environmentId);
    if (!environment) throw new Error("Controller retained environment unavailable.");
    next.retainedSessions.push({
      id: session.id,
      generation: session.generation,
      epoch: next.epoch,
      environment: structuredClone(environment),
      requirements: [...session.requirements],
      parkingConsent: session.parkingConsent,
      consentRevision: session.consentRevision,
      reason,
    });
  }
  private checkEnvironment(next: ControllerSnapshot, environment: ControllerEnvironment) {
    const shared = next.environments.find((entry) => entry.repoPath === environment.repoPath);
    if (shared && !isDeepStrictEqual(shared, environment))
      throw new Error("Controller environment binding conflicts.");
    const known = [
      ...next.environments,
      ...next.retainedSessions.map((entry) => entry.environment),
    ];
    if (
      known.some(
        (entry) => (entry.id === environment.id) !== (entry.repoPath === environment.repoPath),
      )
    )
      throw new Error("Controller environment identity conflicts.");
    if (
      !known.some((entry) => entry.id === environment.id) &&
      new Set(known.map((entry) => entry.id)).size >= 32
    )
      throw new Error("Controller coordination capacity exhausted.");
    return shared;
  }
  /** Call before requests and publication. Monotonic time never enters the manual journal. */
  tick(monotonic: number, wall: number): boolean {
    this.assertHealthy();
    if (
      !Number.isSafeInteger(monotonic) ||
      monotonic < 0 ||
      !Number.isSafeInteger(wall) ||
      wall < 0
    )
      throw new Error("Invalid controller clock.");
    const previous = this.previousTime;
    const elapsed = previous ? monotonic - previous.monotonic : 0;
    const wallElapsed = previous ? wall - previous.wall : 0;
    const discontinuity =
      !!previous &&
      (elapsed < 0 ||
        elapsed > 15_000 ||
        wallElapsed < 0 ||
        Math.abs(wallElapsed - elapsed) > 2_000);
    if (!this.uncertainty || discontinuity)
      this.uncertainty = { since: monotonic, reason: "continuity-unknown" };
    const next = this.read();
    const removed = next.sessions.filter(
      (s) => discontinuity || monotonic >= (this.leases.get(s.id) ?? 0),
    );
    if (removed.length) {
      if (!discontinuity) this.uncertainty = { since: monotonic, reason: "orphan-suspected" };
      for (const session of removed) {
        this.retain(next, session, discontinuity ? "discontinuity" : "expired");
        this.event(next, session, discontinuity ? "invalidated" : "expired");
      }
      const ids = new Set(removed.map((s) => s.id));
      next.sessions = next.sessions.filter((s) => !ids.has(s.id));
      this.removeUnused(next);
    }
    let expiredEvidence = false;
    for (const session of next.sessions) {
      if (!session.observation || monotonic < session.observation.validUntilMs) continue;
      delete session.observation;
      this.event(next, session, "invalidated");
      expiredEvidence = true;
    }
    if (removed.length || discontinuity) this.advanceParking(next);
    if (removed.length || expiredEvidence || discontinuity) {
      this.commit(next);
      for (const session of removed) this.leases.delete(session.id);
    }
    this.previousTime = { monotonic, wall };
    return discontinuity;
  }
  /** Loss of continuity never establishes that an environment has no other consumers. */
  protection(environment: ControllerEnvironment, monotonic: number, wall: number) {
    this.tick(monotonic, wall);
    const snapshot = this.read();
    const current = snapshot.environments.find((candidate) => candidate.id === environment.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(environment))
      throw new Error("Controller protection binding changed.");
    const consumers = snapshot.sessions.filter(
      (session) => session.environmentId === environment.id,
    );
    const liveConsumers = consumers.length;
    const consentingConsumers = consumers.filter(
      (session) => session.parkingConsent === "allow-unusable",
    ).length;
    const unresolvedConsumers = snapshot.retainedSessions.filter(
      (session) => session.environment.id === environment.id,
    ).length;
    const uncertainty = this.uncertainty;
    if (!uncertainty) throw new Error("Controller continuity evidence unavailable.");
    const graceRemainingMs = Math.max(0, 60_000 - (monotonic - uncertainty.since));
    return {
      liveConsumers,
      protectedConsumers: liveConsumers - consentingConsumers,
      consentingConsumers,
      unresolvedConsumers,
      history: snapshot.history,
      // Consent is only one input to parking; it is not an execution permission.
      consentSatisfied:
        snapshot.history === "complete" &&
        unresolvedConsumers === 0 &&
        liveConsumers > 0 &&
        consentingConsumers === liveConsumers,
      continuity: graceRemainingMs > 0 ? uncertainty.reason : "revalidation-required",
      graceRemainingMs,
    };
  }
  acquire(
    id: string,
    environment: ControllerEnvironment,
    requirements: string[],
    monotonic: number,
    wall: number,
  ): ControllerBinding {
    this.tick(monotonic, wall);
    const next = this.read();
    const required = [...requirements].sort();
    const existing = next.sessions.find((s) => s.id === id);
    // ID is assigned by the canonical resolver, never inferred from a session.
    const shared = this.checkEnvironment(next, environment);
    if (existing) {
      if (
        existing.environmentId !== environment.id ||
        JSON.stringify(existing.requirements) !== JSON.stringify(required)
      )
        throw new Error("Controller session binding conflicts.");
      return this.binding(existing);
    }
    if (next.sessions.length + next.retainedSessions.length >= 128)
      throw new Error("Controller coordination capacity exhausted.");
    const session: ControllerSession = {
      id,
      environmentId: environment.id,
      generation: randomUUID(),
      requirements: required,
      renewedAtMs: wall,
      parkingConsent: "protected",
      consentRevision: 0,
    };
    if (!shared) next.environments.push(structuredClone(environment));
    next.sessions.push(session);
    this.event(next, session, "acquired");
    this.advanceParking(next);
    this.commit(next);
    this.leases.set(id, monotonic + 30_000);
    return this.binding(session);
  }
  reconnect(
    previous: ControllerBinding,
    environment: ControllerEnvironment,
    requirements: string[],
    monotonic: number,
    wall: number,
  ): ControllerBinding {
    this.tick(monotonic, wall);
    const next = this.read();
    const required = [...requirements].sort();
    const retained = next.retainedSessions.find(
      (entry) =>
        entry.id === previous.session &&
        entry.epoch === previous.epoch &&
        entry.generation === previous.generation,
    );
    if (
      previous.store !== next.store ||
      !retained ||
      next.sessions.some((entry) => entry.id === previous.session) ||
      !isDeepStrictEqual(retained.environment, environment) ||
      !isDeepStrictEqual([...retained.requirements].sort(), required)
    )
      throw new Error("Controller reconnect binding is unavailable or changed.");
    const shared = this.checkEnvironment(next, environment);
    const session: ControllerSession = {
      id: previous.session,
      environmentId: environment.id,
      generation: randomUUID(),
      requirements: required,
      renewedAtMs: wall,
      parkingConsent: "protected",
      consentRevision: 0,
    };
    next.retainedSessions = next.retainedSessions.filter((entry) => entry !== retained);
    if (!shared) next.environments.push(structuredClone(environment));
    next.sessions.push(session);
    this.event(next, session, "reconnected");
    this.advanceParking(next);
    this.commit(next);
    this.leases.set(session.id, monotonic + 30_000);
    return this.binding(session);
  }
  setParkingConsent(
    binding: ControllerBinding,
    expectedRevision: number,
    consent: ControllerSession["parkingConsent"],
    monotonic: number,
    wall: number,
  ): { parkingConsent: ControllerSession["parkingConsent"]; consentRevision: number } {
    this.tick(monotonic, wall);
    const current = this.validate(binding);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !["protected", "allow-unusable"].includes(consent)
    )
      throw new Error("Invalid controller consent request.");
    const receipt = {
      parkingConsent: current.parkingConsent,
      consentRevision: current.consentRevision,
    };
    if (current.consentRevision !== expectedRevision) {
      if (
        expectedRevision < Number.MAX_SAFE_INTEGER &&
        current.consentRevision === expectedRevision + 1 &&
        current.parkingConsent === consent
      )
        return receipt;
      throw new Error("Controller consent revision changed.");
    }
    if (current.parkingConsent === consent) return receipt;
    if (current.consentRevision === Number.MAX_SAFE_INTEGER)
      throw new Error("Controller consent revision exhausted.");
    const next = this.read();
    const session = next.sessions.find((entry) => entry.id === binding.session);
    if (!session) throw new Error("Controller session is absent.");
    session.parkingConsent = consent;
    session.consentRevision++;
    this.advanceParking(next);
    this.event(next, session, "consent");
    this.commit(next);
    return { parkingConsent: session.parkingConsent, consentRevision: session.consentRevision };
  }
  publish(
    bindings: ControllerBinding[],
    projections: Map<string, ControllerProjection>,
    monotonic: number,
    wall: number,
  ): void {
    this.tick(monotonic, wall);
    const next = this.read();
    let changed = false;
    for (const binding of bindings) {
      try {
        this.validate(binding);
      } catch {
        continue;
      }
      const session = next.sessions.find((candidate) => candidate.id === binding.session);
      const projection = projections.get(binding.session);
      if (
        !session ||
        !projection ||
        projection.sampledAtMs > monotonic ||
        projection.validUntilMs <= monotonic
      )
        continue;
      const previous = session.observation;
      session.observation = { ...projection };
      changed = true;
      if (
        !previous ||
        previous.status !== projection.status ||
        previous.journalRevision !== projection.journalRevision ||
        previous.runtimeFingerprint !== projection.runtimeFingerprint
      )
        this.event(next, session, "observed");
    }
    if (changed) this.commit(next);
  }
  invalidate(environmentId: string, bindingChanged = false, expected?: ControllerBinding[]): void {
    const next = this.read();
    let changed = false;
    const affected = next.sessions.filter(
      (s) =>
        s.environmentId === environmentId &&
        (!expected ||
          expected.some(
            (binding) =>
              binding.session === s.id &&
              binding.generation === s.generation &&
              binding.store === next.store &&
              binding.epoch === next.epoch,
          )),
    );
    for (const session of affected) {
      if (!session.observation && !bindingChanged) continue;
      delete session.observation;
      this.event(next, session, "invalidated");
      changed = true;
    }
    if (bindingChanged && affected.length) {
      for (const session of affected) this.retain(next, session, "binding-changed");
      this.advanceParking(next);
      next.sessions = next.sessions.filter((session) => !affected.includes(session));
      this.removeUnused(next);
    }
    if (changed) {
      this.commit(next);
      if (bindingChanged)
        for (const id of this.leases.keys())
          if (!next.sessions.some((s) => s.id === id)) this.leases.delete(id);
    }
  }
  projection(
    session: ControllerSession,
    monotonic: number,
  ): ControllerSession & { status: string; validForMs: number } {
    const observation = session.observation;
    if (
      !observation ||
      observation.sampledAtMs > monotonic ||
      observation.validUntilMs <= monotonic
    ) {
      const { observation: _observation, ...binding } = session;
      return { ...binding, status: "UNKNOWN", validForMs: 0 };
    }
    return {
      ...session,
      status: observation.status,
      validForMs: observation.validUntilMs - monotonic,
    };
  }
  private binding(session: ControllerSession): ControllerBinding {
    return {
      session: session.id,
      store: this.snapshot.store,
      epoch: this.snapshot.epoch,
      generation: session.generation,
    };
  }
  validate(binding: ControllerBinding): ControllerSession {
    this.assertHealthy();
    const session = this.snapshot.sessions.find((s) => s.id === binding.session);
    if (
      binding.store !== this.snapshot.store ||
      binding.epoch !== this.snapshot.epoch ||
      !session ||
      session.generation !== binding.generation
    )
      throw new Error("Controller session binding is stale or absent.");
    return structuredClone(session);
  }
  renew(binding: ControllerBinding, monotonic: number, wall: number): ControllerBinding {
    this.tick(monotonic, wall);
    this.validate(binding);
    const next = this.read();
    const session = next.sessions.find((s) => s.id === binding.session);
    if (!session) throw new Error("Controller session is absent.");
    session.renewedAtMs = wall;
    this.event(next, session, "renewed");
    this.commit(next);
    this.leases.set(session.id, monotonic + 30_000);
    return this.binding(session);
  }
  release(binding: ControllerBinding, monotonic: number, wall: number): void {
    this.tick(monotonic, wall);
    const session = this.validate(binding);
    const next = this.read();
    next.sessions = next.sessions.filter((s) => s.id !== session.id);
    this.removeUnused(next);
    this.event(next, session, "released");
    this.advanceParking(next);
    this.commit(next);
    this.leases.delete(session.id);
  }
}

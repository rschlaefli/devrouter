import { randomUUID } from "node:crypto";
import type {
  ControllerEnvironment,
  ControllerEvent,
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
    const next = this.read();
    const removed = next.sessions.filter(
      (s) => discontinuity || monotonic >= (this.leases.get(s.id) ?? 0),
    );
    if (removed.length) {
      for (const session of removed)
        this.event(next, session, discontinuity ? "invalidated" : "expired");
      const ids = new Set(removed.map((s) => s.id));
      next.sessions = next.sessions.filter((s) => !ids.has(s.id));
      this.removeUnused(next);
      this.commit(next);
      for (const id of ids) this.leases.delete(id);
    }
    this.previousTime = { monotonic, wall };
    return discontinuity;
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
    const shared = next.environments.find((env) => env.repoPath === environment.repoPath);
    // ID is assigned by the canonical resolver, never inferred from a session.
    if (shared && JSON.stringify(shared) !== JSON.stringify(environment))
      throw new Error("Controller environment binding conflicts.");
    if (existing) {
      if (
        existing.environmentId !== environment.id ||
        JSON.stringify(existing.requirements) !== JSON.stringify(required)
      )
        throw new Error("Controller session binding conflicts.");
      return this.binding(existing);
    }
    if (next.sessions.length >= 128 || (!shared && next.environments.length >= 32))
      throw new Error("Controller coordination capacity exhausted.");
    const session: ControllerSession = {
      id,
      environmentId: environment.id,
      generation: randomUUID(),
      requirements: required,
      renewedAtMs: wall,
    };
    if (!shared) next.environments.push(structuredClone(environment));
    next.sessions.push(session);
    this.event(next, session, "acquired");
    this.commit(next);
    this.leases.set(id, monotonic + 30_000);
    return this.binding(session);
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
    this.commit(next);
    this.leases.delete(session.id);
  }
}

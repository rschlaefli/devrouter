import { createHash } from "node:crypto";
import { isPreviewAlias, type PreviewCommand } from "./command";
import {
  createPreviewSession,
  MAX_PREVIEW_DEADLINE_EARLINESS_MS,
  transitionPreviewSession,
} from "./lifecycle";
import {
  decodePreviewPool,
  type PreviewEffect,
  type PreviewEffectStep,
  type PreviewPool,
  type PreviewPoolEntry,
  type PreviewStateStore,
  updatePreviewState,
} from "./state";
import type { PreviewPlanReport } from "./types";

export type PreviewIdentity = { forgeHost: string; projectId: string; change: number };
export type PreviewEffectReceipt = {
  phase: "pending" | "terminal";
  resources: string[];
  ready?: boolean;
  cleanupRequired?: boolean;
  confirmedDeadline?: number;
  outcome?: "succeeded" | "failed" | "cancelled";
};

// Resource IDs are bounded ownership receipts. Destroy and absent must discover
// the complete generation independently, including allocations omitted on overflow.
export interface PreviewWriteGate {
  read(): Promise<PreviewEffectStep[]>;
  fenced(): Promise<boolean>;
  begin(
    name: string,
    mode: "once" | "convergent",
    fingerprint?: string,
  ): Promise<"write" | "resolve" | "fenced">;
  record(name: string, state: "accepted" | "uncertain", ref?: string): Promise<void>;
}

export interface PreviewProvider {
  validatePlan?(plan: PreviewPlanReport): void;
  submit(
    effect: PreviewEffect,
    entry: PreviewPoolEntry,
    gate: PreviewWriteGate,
  ): Promise<PreviewEffectReceipt>;
  observe(
    effect: PreviewEffect,
    entry: PreviewPoolEntry,
    gate: PreviewWriteGate,
  ): Promise<PreviewEffectReceipt>;
  absent(entry: PreviewPoolEntry): Promise<boolean>;
}

export type PreviewAdmission = {
  identity: PreviewIdentity;
  commandId: string;
  createdAt: number;
  actorCanWrite: boolean;
  originalHumanRoot: boolean;
  open: boolean;
  sameProject: boolean;
  command: PreviewCommand;
  plan?: PreviewPlanReport;
  hourlyCents?: number;
};

export type PreviewEnginePolicy = {
  installationId: string;
  maxActive: number;
  maxReservedCents: number;
  maxCommandAgeMs: number;
  startupBudgetMs: number;
  leaseMs: number;
  allowedProjects: string[];
  allowedAliases: string[];
  manifestDigests: string[];
  localConfigDigests: string[];
};

export function previewIdentityKey(identity: PreviewIdentity): string {
  if (
    !/^[a-z0-9.-]+$/.test(identity.forgeHost) ||
    identity.forgeHost.length > 253 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(identity.projectId) ||
    !Number.isSafeInteger(identity.change) ||
    identity.change < 1
  )
    throw new Error("Invalid immutable preview identity.");
  return createHash("sha256")
    .update(JSON.stringify([identity.forgeHost, identity.projectId, identity.change]))
    .digest("hex");
}

function costs(pool: PreviewPool): number {
  return Object.values(pool.sessions).reduce((total, entry) => total + entry.reservedCents, 0);
}

function tracked(effect: PreviewEffect): boolean {
  return effect.kind === "deploy" || effect.kind === "deadline";
}

function confirms(target: number | undefined, confirmed: number | undefined): boolean {
  return (
    target !== undefined &&
    confirmed !== undefined &&
    Number.isSafeInteger(confirmed) &&
    confirmed <= target &&
    confirmed >= target - MAX_PREVIEW_DEADLINE_EARLINESS_MS
  );
}

function isStopping(session: PreviewPoolEntry["session"]): boolean {
  return session.status === "stopping" || session.status === "cleanup-pending";
}

function writeFenced(
  session: PreviewPoolEntry["session"],
  effect: PreviewEffect,
  now: number,
): boolean {
  const cutoff = session.firstReadyAt === undefined ? session.setupDeadline : session.expiresAt;
  return (
    tracked(effect) &&
    (isStopping(session) ||
      now >= cutoff ||
      (effect.kind === "deadline"
        ? session.deadlineVersion !== effect.deadlineVersion
        : session.operationVersion !== effect.operationVersion))
  );
}

function prunePool(pool: PreviewPool, now: number, age: number): void {
  pool.processedCommands = pool.processedCommands.filter(
    (receipt) => now - receipt.admittedAt <= age,
  );
  for (const [id, entry] of Object.entries(pool.sessions)) {
    if (
      !entry.session.reservationHeld &&
      entry.completedAt !== undefined &&
      now - entry.completedAt > age
    ) {
      delete pool.sessions[id];
      continue;
    }
    const keep = new Map<string, string>();
    for (const [key, effect] of Object.entries(entry.operations)) {
      if (effect.phase !== "terminal") continue;
      const group =
        effect.kind === "deadline"
          ? `${effect.kind}:${effect.target}`
          : `${effect.kind}:${effect.operationVersion}`;
      const previous = keep.get(group);
      if (previous) delete entry.operations[previous];
      keep.set(group, key);
      if (effect.operationVersion < entry.session.operationVersion && effect.kind !== "deadline")
        delete entry.operations[key];
      if (
        effect.kind === "deadline" &&
        effect.target !== entry.session.expiresAt &&
        effect.confirmedDeadline !== entry.session.expiresAt &&
        effect.target !== entry.session.pendingDeadline?.target &&
        effect.target !== (entry.readyObservedAt ?? 0) + 2 * 3_600_000
      )
        delete entry.operations[key];
    }
  }
}

export class PreviewEngine {
  private readonly key: string;
  constructor(
    private readonly options: {
      store: PreviewStateStore;
      policy: PreviewEnginePolicy;
      provider: PreviewProvider;
      workerId: string;
      now: () => number;
    },
  ) {
    const { policy, workerId } = options;
    for (const number of [
      policy.maxActive,
      policy.maxReservedCents,
      policy.maxCommandAgeMs,
      policy.startupBudgetMs,
      policy.leaseMs,
    ]) {
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("Invalid preview policy limit.");
    }
    if (!/^[a-z0-9-]{1,63}$/.test(policy.installationId) || !workerId || workerId.length > 128) {
      throw new Error("Invalid preview installation or worker identity.");
    }
    if (policy.maxActive > 4)
      throw new Error("Preview pool supports at most four active sessions.");
    if (!policy.allowedAliases.every(isPreviewAlias))
      throw new Error("Invalid allowed preview aliases.");
    this.key = `installations/${policy.installationId}/pool`;
  }

  private async update(update: (pool: PreviewPool) => PreviewPool): Promise<PreviewPool> {
    const result = await updatePreviewState({
      store: this.options.store,
      key: this.key,
      validate: decodePreviewPool,
      update: (pool) => {
        if (pool.installationId !== this.options.policy.installationId)
          throw new Error("Foreign preview pool.");
        const copy = structuredClone(pool);
        prunePool(copy, this.options.now(), this.options.policy.maxCommandAgeMs);
        return update(copy);
      },
    });
    return result.value;
  }

  async status(identity: PreviewIdentity): Promise<PreviewPoolEntry | null> {
    const record = await this.options.store.read(this.key, decodePreviewPool);
    if (!record || record.value.installationId !== this.options.policy.installationId) {
      throw new Error("Preview installation state is unavailable.");
    }
    return record.value.sessions[previewIdentityKey(identity)] ?? null;
  }

  async admit(input: PreviewAdmission): Promise<PreviewPoolEntry | null> {
    const { policy } = this.options;
    const id = previewIdentityKey(input.identity);
    const now = this.options.now();
    const project = `${input.identity.forgeHost}/${input.identity.projectId}`;
    if (
      !policy.allowedProjects.includes(project) ||
      !input.actorCanWrite ||
      !input.originalHumanRoot ||
      !input.sameProject ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(input.createdAt) ||
      now < input.createdAt ||
      now - input.createdAt > policy.maxCommandAgeMs ||
      !input.commandId ||
      input.commandId.length > 128
    )
      throw new Error("Preview command is not eligible for admission.");
    if (input.command.kind === "status" || input.command.kind === "profiles")
      return this.status(input.identity);
    if (!input.open && input.command.kind !== "stop") throw new Error("Change request is closed.");
    const receipt = `${id}:${input.commandId}`;
    const pool = await this.update((pool) => {
      if (pool.processedCommands.some((item) => item.id === receipt)) return pool;
      if (pool.processedCommands.length >= 1024 && input.command.kind !== "stop")
        throw new Error("Preview command recovery window is full.");
      const current = pool.sessions[id];
      if (input.command.kind === "stop") {
        if (current)
          current.session = transitionPreviewSession(current.session, {
            kind: "stop",
            now: now,
            commandId: input.commandId,
          });
      } else if (input.command.kind === "extend") {
        if (!current) throw new Error("Preview does not exist.");
        current.session = transitionPreviewSession(current.session, {
          kind: "extend",
          now: now,
          commandId: input.commandId,
        });
        const pending = current.session.pendingDeadline;
        if (!pending) throw new Error("Extension did not produce a deadline intent.");
        const reserve = Math.ceil((current.hourlyCents / 60) * ((pending.target - now) / 60_000));
        current.reservedCents = Math.max(current.reservedCents, reserve);
      } else if (input.command.kind === "start") {
        const plan = input.plan;
        if (
          plan?.status !== "planned" ||
          !plan.source?.complete ||
          plan.reasons.includes("source-unbound") ||
          plan.aliases.length === 0 ||
          !plan.aliases.every((alias) => policy.allowedAliases.includes(alias)) ||
          !policy.manifestDigests.includes(plan.manifestDigest) ||
          !policy.localConfigDigests.includes(plan.localConfigDigest) ||
          (input.command.aliases.length > 0 &&
            JSON.stringify([...input.command.aliases].sort()) !== JSON.stringify(plan.aliases))
        )
          throw new Error("A complete approved source-bound plan is required.");
        this.options.provider.validatePlan?.(plan);
        const hourly = input.hourlyCents;
        if (Buffer.byteLength(JSON.stringify(plan)) > 32 * 1024)
          throw new Error("Preview plan exceeds the installation metadata bound.");
        if (!Number.isSafeInteger(hourly) || hourly === undefined || hourly < 1)
          throw new Error("A bounded allocation estimate is required.");
        if (current?.session.reservationHeld) {
          current.session = transitionPreviewSession(current.session, {
            kind: "start",
            now: now,
            commandId: input.commandId,
            revision: plan.source.head,
            aliases: plan.aliases,
            startupBudgetMs: policy.startupBudgetMs,
          });
          current.plan = plan;
          current.hourlyCents = Math.max(current.hourlyCents, hourly);
          current.reservedCents = Math.max(
            current.reservedCents,
            Math.ceil(
              current.hourlyCents *
                Math.max(140 / 60, (current.session.expiresAt - now) / 3_600_000),
            ),
          );
        } else {
          if (
            current &&
            current.session.status !== "stopped" &&
            current.session.status !== "expired"
          )
            throw new Error("Previous generation cleanup is incomplete.");
          const generation = createHash("sha256").update(receipt).digest("hex").slice(0, 24);
          pool.sessions[id] = {
            session: createPreviewSession({
              generation,
              now: now,
              revision: plan.source.head,
              aliases: plan.aliases,
              commandId: input.commandId,
            }),
            plan,
            hourlyCents: hourly,
            reservedCents: Math.ceil((hourly * 140) / 60),
            operations: {},
            effectSequence: 0,
          };
        }
      }
      const active = Object.values(pool.sessions).filter(
        (entry) => entry.session.reservationHeld,
      ).length;
      if (
        input.command.kind !== "stop" &&
        (active > policy.maxActive || costs(pool) > policy.maxReservedCents)
      )
        throw new Error("Preview installation capacity or cost allowance is exhausted.");
      if (
        input.command.kind === "start" &&
        Buffer.byteLength(JSON.stringify(pool)) + active * 128 * 1024 > 1024 * 1024
      )
        throw new Error("Preview pool metadata capacity is reserved for cleanup.");
      if (pool.processedCommands.length < 1024)
        pool.processedCommands.push({ id: receipt, admittedAt: now });
      return pool;
    });
    return pool.sessions[id] ?? null;
  }

  async close(identity: PreviewIdentity): Promise<void> {
    const id = previewIdentityKey(identity);
    await this.update((pool) => {
      const entry = pool.sessions[id];
      if (entry)
        entry.session = transitionPreviewSession(entry.session, {
          kind: "closed",
          now: this.options.now(),
        });
      return pool;
    });
  }

  private prepare(
    entry: PreviewPoolEntry,
    kind: PreviewEffect["kind"],
    now: number,
    target?: number,
  ): PreviewEffect {
    const session = entry.session;
    const id = `${session.generation}:${++entry.effectSequence}`;
    const effect: PreviewEffect = {
      id,
      kind,
      generation: session.generation,
      operationVersion: session.operationVersion,
      deadlineVersion: session.deadlineVersion,
      ownershipVersion: session.ownershipVersion,
      phase: "prepared",
      leaseOwner: this.options.workerId,
      leaseExpiresAt: now + this.options.policy.leaseMs,
      resources: [...session.ownedResources],
      ...(target === undefined ? {} : { target }),
    };
    entry.operations[id] = effect;
    if (tracked(effect))
      entry.session = transitionPreviewSession(session, {
        kind: "effect-started",
        now,
        generation: session.generation,
        operationVersion: session.operationVersion,
        operationId: id,
      });
    return effect;
  }

  async reconcile(identity: PreviewIdentity): Promise<PreviewPoolEntry | null> {
    const id = previewIdentityKey(identity);
    const now = this.options.now();
    let action: PreviewEffect | undefined;
    const pool = await this.update((pool) => {
      // A conflict retry must never retain an action selected from an older snapshot.
      action = undefined;
      const entry = pool.sessions[id];
      if (!entry?.session.reservationHeld) return pool;
      entry.session = transitionPreviewSession(entry.session, { kind: "tick", now });
      const session = entry.session;
      const pending = Object.values(entry.operations).filter(
        (effect) => effect.phase !== "terminal",
      );
      const stopping = isStopping(session);
      if (
        !stopping &&
        session.pendingDeadline &&
        !Object.values(entry.operations).some(
          (effect) =>
            effect.kind === "deadline" &&
            effect.deadlineVersion === session.deadlineVersion &&
            effect.target === session.pendingDeadline?.target,
        )
      ) {
        action = this.prepare(entry, "deadline", now, session.pendingDeadline.target);
        return pool;
      }
      const cancelled = Object.values(entry.operations).some(
        (effect) =>
          effect.kind === "cancel" && effect.operationVersion === session.operationVersion,
      );
      if (stopping && pending.some((effect) => tracked(effect)) && !cancelled) {
        action = this.prepare(entry, "cancel", now);
        return pool;
      }
      const first = stopping ? "cancel" : "deadline";
      const candidate = pending
        .sort((left, right) => Number(right.kind === first) - Number(left.kind === first))
        .find(
          (effect) => effect.leaseOwner === this.options.workerId || effect.leaseExpiresAt <= now,
        );
      if (candidate) {
        candidate.leaseOwner = this.options.workerId;
        candidate.leaseExpiresAt = now + this.options.policy.leaseMs;
        action = candidate;
        return pool;
      }
      if (pending.length > 0) return pool;
      if (stopping) {
        if (
          session.ownedResources.length > 0 &&
          !Object.values(entry.operations).some(
            (effect) =>
              effect.kind === "destroy" &&
              effect.phase === "terminal" &&
              effect.outcome === "succeeded" &&
              effect.ownershipVersion === session.ownershipVersion &&
              session.ownedResources.every((resource) => effect.resources.includes(resource)),
          )
        )
          action = this.prepare(entry, "destroy", now);
      } else if (session.pendingDeadline) {
        action = this.prepare(entry, "deadline", now, session.pendingDeadline.target);
      } else {
        const terminal = Object.values(entry.operations).filter(
          (effect) => effect.phase === "terminal",
        );
        const deployment = terminal.find(
          (effect) =>
            effect.kind === "deploy" && effect.operationVersion === session.operationVersion,
        );
        const deadline = terminal.find(
          (effect) =>
            effect.kind === "deadline" &&
            effect.outcome === "succeeded" &&
            (effect.confirmedDeadline === session.expiresAt ||
              (effect.target === session.expiresAt &&
                confirms(session.expiresAt, effect.confirmedDeadline))),
        );
        if (!deadline) action = this.prepare(entry, "deadline", now, session.expiresAt);
        else if (!deployment) action = this.prepare(entry, "deploy", now);
        else if (deployment.ready && session.firstReadyAt === undefined) {
          entry.readyObservedAt ??= now;
          const target = entry.readyObservedAt + 2 * 60 * 60_000;
          const tightened = terminal.find(
            (effect) =>
              effect.kind === "deadline" &&
              effect.target === target &&
              effect.outcome === "succeeded" &&
              confirms(target, effect.confirmedDeadline),
          );
          if (!tightened) action = this.prepare(entry, "deadline", now, target);
          else sessionReady(entry, entry.readyObservedAt, tightened.confirmedDeadline);
        } else if (deployment.ready && session.status === "updating") sessionReady(entry, now);
      }
      return pool;
    });
    const entry = pool.sessions[id];
    if (!entry) return null;
    if (action) await this.execute(id, entry, action);
    else if (
      isStopping(entry.session) &&
      Object.values(entry.operations).every((effect) => effect.phase === "terminal")
    ) {
      const ownershipVersion = entry.session.ownershipVersion;
      const absent = await this.options.provider.absent(entry);
      await this.update((latest) => {
        const current = latest.sessions[id];
        if (current?.session.generation === entry.session.generation) {
          current.session = transitionPreviewSession(current.session, {
            kind: "cleanup-observed",
            now: this.options.now(),
            generation: entry.session.generation,
            ownershipVersion,
            absent,
          });
          if (!current.session.reservationHeld) {
            current.reservedCents = 0;
            current.completedAt ??= this.options.now();
          }
        }
        return latest;
      });
    }
    return this.status(identity);
  }

  private writeGate(id: string, effect: PreviewEffect): PreviewWriteGate {
    const mutate = async <T>(
      change: (entry: PreviewPoolEntry, live: PreviewEffect) => T,
    ): Promise<T> => {
      let result: T | undefined;
      await this.update((pool) => {
        result = undefined;
        const entry = pool.sessions[id];
        const live = entry?.operations[effect.id];
        if (
          !live ||
          entry.session.generation !== effect.generation ||
          live.phase !== "submitted" ||
          live.leaseOwner !== this.options.workerId ||
          live.leaseExpiresAt <= this.options.now()
        )
          throw new Error("Preview provider write lease changed.");
        result = change(entry, live);
        return pool;
      });
      return result as T;
    };
    return {
      read: () => mutate((_entry, live) => structuredClone(live.steps ?? [])),
      fenced: () => mutate((entry, live) => writeFenced(entry.session, live, this.options.now())),
      begin: (name, mode, fingerprint) => {
        return mutate((entry, live) => {
          if (writeFenced(entry.session, live, this.options.now())) return "fenced";
          const previous = live.steps?.find((step) => step.name === name);
          if (previous) {
            if (
              previous.mode !== mode ||
              (fingerprint !== undefined && previous.fingerprint !== fingerprint)
            )
              throw new Error("Preview provider step identity changed.");
            if (mode === "once") return "resolve";
            previous.state = "intent";
            previous.at = this.options.now();
            live.leaseExpiresAt = this.options.now() + this.options.policy.leaseMs;
            return "write";
          }
          live.steps ??= [];
          live.steps.push({
            name,
            mode,
            state: "intent",
            at: this.options.now(),
            ...(fingerprint ? { fingerprint } : {}),
          });
          live.leaseExpiresAt = this.options.now() + this.options.policy.leaseMs;
          return "write";
        });
      },
      record: (name, state, ref) =>
        mutate((_entry, live) => {
          const step = live.steps?.find((item) => item.name === name);
          if (!step || (state !== "accepted" && state !== "uncertain"))
            throw new Error("Preview provider step intent is missing.");
          if (step.state === "accepted" && (step.ref !== ref || state !== "accepted"))
            throw new Error("Preview provider receipt cannot be overwritten.");
          step.state = state;
          if (ref !== undefined) step.ref = ref;
        }),
    };
  }

  private async execute(id: string, entry: PreviewPoolEntry, effect: PreviewEffect): Promise<void> {
    let dispatch: "submit" | "observe" | undefined;
    await this.update((pool) => {
      dispatch = undefined;
      const current = pool.sessions[id];
      const live = current?.operations[effect.id];
      if (
        !live ||
        live.phase === "terminal" ||
        live.leaseOwner !== this.options.workerId ||
        live.leaseExpiresAt <= this.options.now()
      )
        throw new Error("Preview effect lease changed.");
      if (current.session.generation !== effect.generation)
        throw new Error("Preview generation changed.");
      if (live.phase === "prepared") {
        if (writeFenced(current.session, live, this.options.now())) {
          live.phase = "terminal";
          current.session = transitionPreviewSession(current.session, {
            kind: "effect-settled",
            now: this.options.now(),
            generation: effect.generation,
            operationId: effect.id,
            resources: [],
          });
          return pool;
        }
        live.phase = "submitted";
        dispatch = "submit";
      } else dispatch = "observe";
      return pool;
    });
    if (!dispatch) return;
    const receipt = await this.options.provider[dispatch](
      effect,
      entry,
      this.writeGate(id, effect),
    );
    if (receipt.phase !== "pending" && receipt.phase !== "terminal")
      throw new Error("Invalid provider operation status.");
    if (
      !Array.isArray(receipt.resources) ||
      receipt.resources.length > 1024 ||
      receipt.resources.some(
        (resource) => typeof resource !== "string" || !resource || resource.length > 128,
      )
    )
      throw new Error("Invalid provider ownership receipt.");
    await this.update((pool) => {
      const current = pool.sessions[id];
      const live = current?.operations[effect.id];
      if (
        !live ||
        live.phase === "terminal" ||
        current.session.generation !== effect.generation ||
        live.leaseOwner !== this.options.workerId ||
        live.leaseExpiresAt <= this.options.now()
      )
        return pool;
      if (receipt.phase === "terminal") {
        const additions = [...new Set(receipt.resources)].filter(
          (resource) => !current.session.ownedResources.includes(resource),
        );
        const overflow = current.session.ownedResources.length + additions.length > 64;
        const recorded = [...current.session.ownedResources, ...additions].slice(0, 64);
        if (overflow) current.ownershipOverflow = true;
        live.phase = "terminal";
        live.resources =
          live.kind === "destroy"
            ? [...new Set([...live.resources, ...receipt.resources])].slice(0, 64)
            : receipt.resources.slice(0, 64);
        live.ready = receipt.ready;
        live.confirmedDeadline = receipt.confirmedDeadline;
        live.outcome =
          live.kind === "deadline" && !confirms(live.target, receipt.confirmedDeadline)
            ? "failed"
            : (receipt.outcome ?? "succeeded");
        if (tracked(live))
          current.session = transitionPreviewSession(current.session, {
            kind: "effect-settled",
            now: this.options.now(),
            generation: effect.generation,
            operationId: effect.id,
            resources: recorded,
          });
        if ((overflow || receipt.cleanupRequired) && !isStopping(current.session))
          current.session = transitionPreviewSession(current.session, {
            kind: "stop",
            now: this.options.now(),
          });
        if (
          live.kind === "deadline" &&
          current.session.pendingDeadline &&
          confirms(live.target, receipt.confirmedDeadline) &&
          live.outcome === "succeeded" &&
          live.deadlineVersion === current.session.deadlineVersion
        ) {
          current.session = transitionPreviewSession(current.session, {
            kind: "deadline-confirmed",
            now: this.options.now(),
            generation: effect.generation,
            deadlineVersion: live.deadlineVersion,
            expiresAt: receipt.confirmedDeadline as number,
          });
        }
      }
      if (
        receipt.phase === "terminal" &&
        live.kind === "deadline" &&
        live.outcome !== "succeeded" &&
        live.deadlineVersion === current.session.deadlineVersion
      ) {
        if (
          current.session.pendingDeadline &&
          live.deadlineVersion === current.session.deadlineVersion
        ) {
          current.session = transitionPreviewSession(current.session, {
            kind: "deadline-rejected",
            now: this.options.now(),
            generation: live.generation,
            deadlineVersion: live.deadlineVersion,
          });
        } else if (!isStopping(current.session)) {
          current.session = transitionPreviewSession(current.session, {
            kind: "stop",
            now: this.options.now(),
          });
        }
      }
      live.leaseExpiresAt = 0;
      return pool;
    });
  }
}

function sessionReady(entry: PreviewPoolEntry, now: number, expiresAt?: number): void {
  entry.session = transitionPreviewSession(entry.session, {
    kind: "ready",
    now,
    generation: entry.session.generation,
    operationVersion: entry.session.operationVersion,
    revision: entry.session.desiredRevision,
    deadlineConfirmed: true,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

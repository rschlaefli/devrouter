import { createHash } from "node:crypto";
import { isPreviewAlias, type PreviewCommand } from "./command";
import { createPreviewSession, transitionPreviewSession } from "./lifecycle";
import {
  decodePreviewPool,
  type PreviewEffect,
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
  confirmedDeadline?: number;
};

export interface PreviewProvider {
  submit(effect: PreviewEffect, entry: PreviewPoolEntry): Promise<PreviewEffectReceipt>;
  observe(effect: PreviewEffect, entry: PreviewPoolEntry): Promise<PreviewEffectReceipt>;
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
        return update(structuredClone(pool));
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
      input.commandId.length > 256
    )
      throw new Error("Preview command is not eligible for admission.");
    if (input.command.kind === "status" || input.command.kind === "profiles")
      return this.status(input.identity);
    if (!input.open && input.command.kind !== "stop") throw new Error("Change request is closed.");
    const receipt = `${id}:${input.commandId}`;
    const pool = await this.update((pool) => {
      if (pool.processedCommands.includes(receipt)) return pool;
      if (pool.processedCommands.length >= 2048 && input.command.kind !== "stop")
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
        const hourly = input.hourlyCents;
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
      if (pool.processedCommands.length < 2048) pool.processedCommands.push(receipt);
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
    const id = `${session.generation}:${kind}:${session.operationVersion}:${session.deadlineVersion}:${session.ownershipVersion}:${target ?? 0}`;
    const effect: PreviewEffect = {
      id,
      kind,
      generation: session.generation,
      operationVersion: session.operationVersion,
      deadlineVersion: session.deadlineVersion,
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
      const stopping = session.status === "stopping" || session.status === "cleanup-pending";
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
      const candidates = stopping
        ? [...pending].sort(
            (left, right) => Number(right.kind === "cancel") - Number(left.kind === "cancel"),
          )
        : [...pending].sort(
            (left, right) => Number(right.kind === "deadline") - Number(left.kind === "deadline"),
          );
      const candidate = candidates.find(
        (effect) => effect.leaseOwner === this.options.workerId || effect.leaseExpiresAt <= now,
      );
      if (candidate) {
        candidate.leaseOwner = this.options.workerId;
        candidate.leaseExpiresAt = now + this.options.policy.leaseMs;
        action = structuredClone(candidate);
        return pool;
      }
      if (pending.length > 0) return pool;
      if (stopping) {
        if (session.ownedResources.length > 0) action = this.prepare(entry, "destroy", now);
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
            effect.target === session.expiresAt &&
            effect.confirmedDeadline !== undefined &&
            effect.confirmedDeadline <= session.expiresAt &&
            effect.confirmedDeadline >= session.expiresAt - 60_000,
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
              effect.confirmedDeadline !== undefined &&
              effect.confirmedDeadline <= target &&
              effect.confirmedDeadline >= target - 60_000,
          );
          if (!tightened) action = this.prepare(entry, "deadline", now, target);
          else sessionReady(entry, entry.readyObservedAt);
        } else if (deployment.ready && session.status === "updating") sessionReady(entry, now);
      }
      return pool;
    });
    const entry = pool.sessions[id];
    if (!entry) return null;
    if (action) await this.execute(id, entry, action);
    else if (
      (entry.session.status === "stopping" || entry.session.status === "cleanup-pending") &&
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
          if (!current.session.reservationHeld) current.reservedCents = 0;
        }
        return latest;
      });
    }
    return this.status(identity);
  }

  private async execute(id: string, entry: PreviewPoolEntry, effect: PreviewEffect): Promise<void> {
    let submitted = effect.phase === "submitted";
    let cancelledBeforeDispatch = false;
    await this.update((pool) => {
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
        const cutoff =
          current.session.firstReadyAt === undefined
            ? current.session.setupDeadline
            : current.session.expiresAt;
        if (
          tracked(live) &&
          (current.session.status === "stopping" ||
            current.session.status === "cleanup-pending" ||
            current.session.operationVersion !== live.operationVersion ||
            this.options.now() >= cutoff)
        ) {
          live.phase = "terminal";
          current.session = transitionPreviewSession(current.session, {
            kind: "effect-settled",
            now: this.options.now(),
            generation: effect.generation,
            operationId: effect.id,
            resources: [],
          });
          cancelledBeforeDispatch = true;
          return pool;
        }
        live.phase = "submitted";
      } else submitted = true;
      return pool;
    });
    if (cancelledBeforeDispatch) return;
    const receipt = submitted
      ? await this.options.provider.observe(effect, entry)
      : await this.options.provider.submit(effect, entry);
    if (receipt.phase !== "pending" && receipt.phase !== "terminal")
      throw new Error("Invalid provider operation status.");
    if (
      !Array.isArray(receipt.resources) ||
      receipt.resources.some(
        (resource) => typeof resource !== "string" || !resource || resource.length > 1024,
      )
    )
      throw new Error("Invalid provider ownership receipt.");
    if (
      effect.kind === "deadline" &&
      receipt.phase === "terminal" &&
      (receipt.confirmedDeadline === undefined ||
        effect.target === undefined ||
        receipt.confirmedDeadline > effect.target ||
        receipt.confirmedDeadline < effect.target - 60_000)
    )
      throw new Error("Provider deadline is not confirmed.");
    await this.update((pool) => {
      const current = pool.sessions[id];
      const live = current?.operations[effect.id];
      if (!live || live.phase === "terminal" || current.session.generation !== effect.generation)
        return pool;
      if (receipt.phase === "terminal") {
        live.phase = "terminal";
        live.resources = receipt.resources;
        live.ready = receipt.ready;
        live.confirmedDeadline = receipt.confirmedDeadline;
        if (tracked(live))
          current.session = transitionPreviewSession(current.session, {
            kind: "effect-settled",
            now: this.options.now(),
            generation: effect.generation,
            operationId: effect.id,
            resources: receipt.resources,
          });
        if (live.kind === "destroy") {
          current.session.ownedResources = current.session.ownedResources.filter(
            (resource) => !effect.resources.includes(resource),
          );
          current.session.ownershipVersion += 1;
        }
        if (
          live.kind === "deadline" &&
          current.session.pendingDeadline &&
          receipt.confirmedDeadline !== undefined &&
          live.deadlineVersion === current.session.deadlineVersion
        ) {
          current.session = transitionPreviewSession(current.session, {
            kind: "deadline-confirmed",
            now: this.options.now(),
            generation: effect.generation,
            deadlineVersion: live.deadlineVersion,
            expiresAt: receipt.confirmedDeadline,
          });
        }
      }
      live.leaseExpiresAt = 0;
      return pool;
    });
  }
}

function sessionReady(entry: PreviewPoolEntry, now: number): void {
  entry.session = transitionPreviewSession(entry.session, {
    kind: "ready",
    now,
    generation: entry.session.generation,
    operationVersion: entry.session.operationVersion,
    revision: entry.session.desiredRevision,
    deadlineConfirmed: true,
  });
}

import { isPreviewAlias, PreviewAdmissionRefused } from "./command";

export const MAX_PREVIEW_DEADLINE_EARLINESS_MS = 75_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SETUP_LIMIT = 20 * MINUTE;
const READY_LIFETIME = 2 * HOUR;
const BACKSTOP = 140 * MINUTE;
const MAX_EXTENSIONS = 2;
const MAX_AFTER_READY = 4 * HOUR;
const MAX_COMMANDS = 1024;
const MAX_ITEMS = 64;
const MAX_ALIASES = 64;
const MAX_ID = 256;
const MAX_RESOURCE_ID = 128;
const REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type PreviewSessionStatus =
  | "waiting-images"
  | "provisioning"
  | "ready"
  | "updating"
  | "stopping"
  | "cleanup-pending"
  | "stopped"
  | "expired"
  | "failed";

export type PreviewSession = {
  generation: string;
  status: PreviewSessionStatus;
  createdAt: number;
  provisioningStartedAt?: number;
  setupDeadline: number;
  expiresAt: number;
  firstReadyAt?: number;
  extensions: number;
  operationVersion: number;
  ownershipVersion: number;
  deadlineVersion: number;
  desiredRevision: string;
  desiredAliases: string[];
  stale: boolean;
  stopReason?: "stop" | "closed" | "expiry" | "setup-timeout";
  pendingDeadline?: { target: number; commandId: string };
  processedCommands: string[];
  outstandingOperations: string[];
  ownedResources: string[];
  reservationHeld: boolean;
};

type Timed = { now: number };
export type PreviewLifecycleEvent =
  | ({
      kind: "ready";
      generation: string;
      operationVersion: number;
      revision: string;
      deadlineConfirmed: boolean;
      expiresAt?: number;
    } & Timed)
  | ({
      kind: "start";
      commandId: string;
      revision: string;
      aliases: string[];
      startupBudgetMs: number;
    } & Timed)
  | ({ kind: "images-ready" } & Timed)
  | ({ kind: "push"; revision: string } & Timed)
  | ({ kind: "deadline-rejected"; generation: string; deadlineVersion: number } & Timed)
  | ({ kind: "extend"; commandId: string } & Timed)
  | ({
      kind: "deadline-confirmed";
      generation: string;
      deadlineVersion: number;
      expiresAt: number;
    } & Timed)
  | ({ kind: "stop" | "closed" | "tick"; commandId?: string } & Timed)
  | ({
      kind: "effect-started";
      generation: string;
      operationVersion: number;
      operationId: string;
    } & Timed)
  | ({
      kind: "effect-settled";
      generation: string;
      operationId: string;
      resources: string[];
    } & Timed)
  | ({
      kind: "cleanup-observed";
      generation: string;
      absent: boolean;
      ownershipVersion: number;
    } & Timed);

export function createPreviewSession({
  generation,
  now,
  revision,
  aliases,
  commandId,
  waitForImages = false,
}: {
  generation: string;
  now: number;
  revision: string;
  aliases: string[];
  commandId: string;
  waitForImages?: boolean;
}): PreviewSession {
  assertTime(now);
  assertId(generation, "generation");
  assertId(commandId, "commandId");
  assertRevision(revision);
  return {
    generation,
    status: waitForImages ? "waiting-images" : "provisioning",
    createdAt: now,
    ...(waitForImages ? {} : { provisioningStartedAt: now }),
    setupDeadline: add(now, SETUP_LIMIT),
    expiresAt: add(now, BACKSTOP),
    extensions: 0,
    operationVersion: 1,
    ownershipVersion: 1,
    deadlineVersion: 1,
    desiredRevision: revision,
    desiredAliases: normalizeAliases(aliases),
    stale: false,
    processedCommands: [commandId],
    outstandingOperations: [],
    ownedResources: [],
    reservationHeld: true,
  };
}

// Invalid and out-of-order events throw. Replayed command and provider
// acknowledgements return a fresh clone without changing state.
export function transitionPreviewSession(
  session: PreviewSession,
  event: PreviewLifecycleEvent,
): PreviewSession {
  assertTime(event.now);
  switch (event.kind) {
    case "ready": {
      assertGeneration(session, event.generation);
      assertVersion(event.operationVersion);
      assertRevision(event.revision);
      if (
        event.operationVersion !== session.operationVersion ||
        event.revision !== session.desiredRevision ||
        session.outstandingOperations.length !== 0 ||
        !event.deadlineConfirmed
      ) {
        throw new Error("ready does not match the live operation");
      }
      if (session.firstReadyAt === undefined) {
        if (session.status !== "provisioning" || event.now >= session.setupDeadline) {
          throw new Error("ready arrived after setup cutoff");
        }
        const target = add(event.now, READY_LIFETIME);
        const expiresAt = event.expiresAt ?? target;
        assertTime(expiresAt);
        if (expiresAt > target || expiresAt < target - MAX_PREVIEW_DEADLINE_EARLINESS_MS)
          throw new Error("ready deadline does not match its confirmed target");
        if (expiresAt >= session.expiresAt) throw new Error("ready did not tighten backstop");
        return {
          ...clone(session),
          status: "ready",
          firstReadyAt: event.now,
          expiresAt,
          deadlineVersion: increment(session.deadlineVersion),
        };
      }
      if (session.status === "ready") return clone(session);
      if (session.status !== "updating" || event.now >= session.expiresAt) {
        throw new Error("preview cannot become ready");
      }
      return { ...clone(session), status: "ready" };
    }

    case "start": {
      if (!acceptCommand(session, event.commandId)) return clone(session);
      assertRevision(event.revision);
      assertTime(event.startupBudgetMs);
      const aliases = normalizeAliases(event.aliases);
      const cutoff =
        session.status === "waiting-images"
          ? session.expiresAt
          : session.firstReadyAt === undefined
            ? session.setupDeadline
            : session.expiresAt;
      if (!isActive(session.status) || event.now >= cutoff)
        throw new Error("preview cannot accept start");
      const next = clone(session);
      next.processedCommands.push(event.commandId);
      if (
        event.revision === session.desiredRevision &&
        sameAliases(aliases, session.desiredAliases)
      ) {
        return next;
      }
      if (session.pendingDeadline || add(event.now, event.startupBudgetMs) > cutoff) {
        throw new PreviewAdmissionRefused(
          "update-unavailable",
          "preview update does not fit remaining time or has an unresolved deadline",
        );
      }
      next.desiredRevision = event.revision;
      next.desiredAliases = aliases;
      next.operationVersion = increment(session.operationVersion);
      next.status =
        session.status === "waiting-images"
          ? "waiting-images"
          : session.firstReadyAt === undefined
            ? "provisioning"
            : "updating";
      next.stale = false;
      return next;
    }

    case "images-ready": {
      if (session.status !== "waiting-images" || session.provisioningStartedAt !== undefined)
        return clone(session);
      return {
        ...clone(session),
        status: "provisioning",
        provisioningStartedAt: event.now,
        setupDeadline: add(event.now, SETUP_LIMIT),
        expiresAt: add(event.now, BACKSTOP),
      };
    }

    case "push": {
      assertRevision(event.revision);
      const next = clone(session);
      if (isActive(session.status) && event.revision !== session.desiredRevision) {
        next.stale = true;
      }
      return next;
    }

    case "extend": {
      if (!acceptCommand(session, event.commandId)) return clone(session);
      if (
        session.firstReadyAt === undefined ||
        (session.status !== "ready" && session.status !== "updating") ||
        event.now >= session.expiresAt ||
        session.pendingDeadline ||
        session.extensions >= MAX_EXTENSIONS
      ) {
        throw new PreviewAdmissionRefused(
          "extension-unavailable",
          "preview extension is unavailable",
        );
      }
      const target = add(session.expiresAt, HOUR);
      if (target > add(session.firstReadyAt, MAX_AFTER_READY)) {
        throw new PreviewAdmissionRefused(
          "extension-unavailable",
          "preview extension exceeds readiness ceiling",
        );
      }
      const next = clone(session);
      next.processedCommands.push(event.commandId);
      next.pendingDeadline = { target, commandId: event.commandId };
      next.deadlineVersion = increment(session.deadlineVersion);
      return next;
    }

    case "deadline-confirmed": {
      assertGeneration(session, event.generation);
      assertVersion(event.deadlineVersion);
      assertTime(event.expiresAt);
      const pending = session.pendingDeadline;
      if (
        !pending &&
        event.deadlineVersion === session.deadlineVersion &&
        event.expiresAt === session.expiresAt
      ) {
        return clone(session);
      }
      if (
        !pending ||
        event.deadlineVersion !== session.deadlineVersion ||
        (session.status !== "ready" && session.status !== "updating") ||
        event.now >= session.expiresAt ||
        event.expiresAt > pending.target ||
        event.expiresAt < pending.target - MAX_PREVIEW_DEADLINE_EARLINESS_MS
      ) {
        throw new Error("deadline confirmation does not match target");
      }
      const next = clone(session);
      next.expiresAt = event.expiresAt;
      next.extensions = session.extensions + 1;
      delete next.pendingDeadline;
      return next;
    }

    case "deadline-rejected": {
      assertGeneration(session, event.generation);
      if (event.deadlineVersion !== session.deadlineVersion || !session.pendingDeadline)
        return clone(session);
      const next = clone(session);
      delete next.pendingDeadline;
      return next;
    }

    case "stop":
    case "closed":
    case "tick": {
      if (event.commandId !== undefined) {
        assertId(event.commandId, "commandId");
        if (session.processedCommands.includes(event.commandId)) return clone(session);
      }
      if (isFenced(session.status)) return clone(session);
      if (event.kind === "tick") {
        if (
          session.firstReadyAt === undefined &&
          session.status === "provisioning" &&
          event.now >= session.setupDeadline
        ) {
          return stop(session, "setup-timeout");
        }
        if (
          session.firstReadyAt !== undefined &&
          (session.status === "ready" || session.status === "updating") &&
          event.now >= session.expiresAt
        ) {
          return stop(session, "expiry");
        }
        return clone(session);
      }
      if (!isActive(session.status) && session.status !== "failed") {
        throw new Error("preview stop is invalid");
      }
      const next = stop(session, event.kind);
      if (event.commandId && next.processedCommands.length < MAX_COMMANDS)
        next.processedCommands.push(event.commandId);
      return next;
    }

    case "effect-started": {
      assertGeneration(session, event.generation);
      assertVersion(event.operationVersion);
      assertId(event.operationId, "operationId");
      const cutoff = session.firstReadyAt === undefined ? session.setupDeadline : session.expiresAt;
      if (
        event.operationVersion !== session.operationVersion ||
        !isActive(session.status) ||
        event.now >= cutoff
      ) {
        throw new Error("effect does not belong to active operation");
      }
      if (session.outstandingOperations.includes(event.operationId)) return clone(session);
      if (session.outstandingOperations.length >= MAX_ITEMS) {
        throw new Error("outstanding operation bound reached");
      }
      return {
        ...clone(session),
        ownershipVersion: increment(session.ownershipVersion),
        outstandingOperations: [...session.outstandingOperations, event.operationId],
      };
    }

    case "effect-settled": {
      assertGeneration(session, event.generation);
      assertId(event.operationId, "operationId");
      const resources = normalizeResources(event.resources);
      if (!session.outstandingOperations.includes(event.operationId)) return clone(session);
      const additions = resources.filter((id) => !session.ownedResources.includes(id));
      if (session.ownedResources.length + additions.length > MAX_ITEMS) {
        throw new Error("owned resource bound reached");
      }
      return {
        ...clone(session),
        ownershipVersion: increment(session.ownershipVersion),
        outstandingOperations: session.outstandingOperations.filter(
          (id) => id !== event.operationId,
        ),
        ownedResources: [...session.ownedResources, ...additions],
      };
    }

    case "cleanup-observed": {
      assertGeneration(session, event.generation);
      assertVersion(event.ownershipVersion);
      if (session.status === "stopped" || session.status === "expired") {
        if (event.absent) return clone(session);
        throw new Error("terminal preview cannot return to cleanup");
      }
      if (session.status !== "stopping" && session.status !== "cleanup-pending") {
        throw new Error("cleanup observed before stopping");
      }
      const next = clone(session);
      if (
        !event.absent ||
        event.ownershipVersion !== session.ownershipVersion ||
        session.outstandingOperations.length !== 0
      ) {
        next.status = "cleanup-pending";
        return next;
      }
      next.status = session.stopReason === "expiry" ? "expired" : "stopped";
      next.ownedResources = [];
      next.reservationHeld = false;
      return next;
    }
  }
}

function clone(session: PreviewSession): PreviewSession {
  return {
    ...session,
    desiredAliases: [...session.desiredAliases],
    pendingDeadline: session.pendingDeadline ? { ...session.pendingDeadline } : undefined,
    processedCommands: [...session.processedCommands],
    outstandingOperations: [...session.outstandingOperations],
    ownedResources: [...session.ownedResources],
  };
}

function stop(
  session: PreviewSession,
  reason: "stop" | "closed" | "expiry" | "setup-timeout",
): PreviewSession {
  const next = clone(session);
  next.status = "stopping";
  next.stopReason = reason;
  next.operationVersion = increment(session.operationVersion);
  delete next.pendingDeadline;
  return next;
}

function acceptCommand(session: PreviewSession, commandId: string): boolean {
  assertId(commandId, "commandId");
  if (session.processedCommands.includes(commandId)) return false;
  assertCommandCapacity(session);
  return true;
}

function assertCommandCapacity(session: PreviewSession): void {
  if (session.processedCommands.length >= MAX_COMMANDS) {
    throw new Error("processed command watermark is full");
  }
}

function assertGeneration(session: PreviewSession, generation: string): void {
  assertId(generation, "generation");
  if (generation !== session.generation) throw new Error("generation mismatch");
}

function assertRevision(revision: string): void {
  if (!REVISION_RE.test(revision)) throw new Error("invalid revision");
}

function normalizeAliases(aliases: string[]): string[] {
  if (
    !Array.isArray(aliases) ||
    aliases.length > MAX_ALIASES ||
    aliases.some((alias) => !isPreviewAlias(alias)) ||
    new Set(aliases).size !== aliases.length
  ) {
    throw new Error("invalid aliases");
  }
  return [...aliases];
}

function normalizeResources(resources: string[]): string[] {
  if (!Array.isArray(resources) || resources.length > MAX_ITEMS) {
    throw new Error("resources exceed their bound");
  }
  const unique = [...new Set(resources)];
  for (const id of unique) assertId(id, "resourceId", MAX_RESOURCE_ID);
  return unique;
}

function sameAliases(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.length === right.length && left.every((alias) => rightSet.has(alias));
}

function assertId(value: string, name: string, max = MAX_ID): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`${name} must be a bounded, non-blank identifier`);
  }
}

function assertTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid timestamp");
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid version");
}

function increment(value: number): number {
  assertVersion(value);
  if (value >= Number.MAX_SAFE_INTEGER) throw new Error("version overflow");
  return value + 1;
}

function add(time: number, duration: number): number {
  assertTime(time);
  assertTime(duration);
  const result = time + duration;
  if (!Number.isSafeInteger(result)) throw new Error("timestamp overflow");
  return result;
}

function isActive(status: PreviewSessionStatus): boolean {
  return (
    status === "waiting-images" ||
    status === "provisioning" ||
    status === "ready" ||
    status === "updating"
  );
}

function isFenced(status: PreviewSessionStatus): boolean {
  return (
    status === "stopping" ||
    status === "cleanup-pending" ||
    status === "stopped" ||
    status === "expired"
  );
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";

export const CONTROLLER_SNAPSHOT_BYTES = 1_048_576;
export type ControllerEnvironment = {
  id: string;
  repoPath: string;
  workspace: string;
  provider: "devpod" | "devsy";
  providerId: string;
  profile: string;
  fingerprint: string;
};
export type ControllerProjection = {
  status:
    | "READY"
    | "APP_ERROR"
    | "BLOCKED"
    | "STOPPED"
    | "STARTING"
    | "RECOVERING"
    | "WAITING_CAPACITY"
    | "PARKED_CAPACITY"
    | "UNKNOWN";
  sampledAtMs: number;
  validUntilMs: number;
  journalRevision: number;
  runtimeFingerprint: string;
};
/** Consumer intent for one live binding; only `allow-unusable` grants parking consent. */
export type ControllerParkingConsent = "protected" | "allow-unusable";
export type ControllerSession = {
  id: string;
  environmentId: string;
  generation: string;
  requirements: string[];
  renewedAtMs: number;
  parkingConsent: ControllerParkingConsent;
  consentRevision: number;
  observation?: ControllerProjection;
};
export type ControllerRetainedReason = "expired" | "restart" | "discontinuity" | "binding-changed";
/** Durable uncertainty for a consumer whose live binding ended without release. */
export type ControllerRetainedSession = {
  id: string;
  generation: string;
  epoch: number;
  requirements: string[];
  parkingConsent: ControllerParkingConsent;
  consentRevision: number;
  reason: ControllerRetainedReason;
  environment: ControllerEnvironment;
};
export type ControllerEventKind =
  | "acquired"
  | "renewed"
  | "released"
  | "expired"
  | "invalidated"
  | "observed"
  | "consent"
  | "reconnected";
export type ControllerEvent = {
  sequence: number;
  session: string;
  generation: string;
  kind: ControllerEventKind;
};
export type ControllerHistory = "complete" | "legacy-unknown";
export type ControllerSnapshot = {
  version: 2;
  store: string;
  epoch: number;
  revision: number;
  parkingRevision: number;
  history: ControllerHistory;
  nextSequence: number;
  environments: ControllerEnvironment[];
  sessions: ControllerSession[];
  retainedSessions: ControllerRetainedSession[];
  events: ControllerEvent[];
};

type ControllerLegacySession = {
  id: string;
  environmentId: string;
  generation: string;
  requirements: string[];
  renewedAtMs: number;
  observation?: ControllerProjection;
};
type ControllerLegacySnapshot = {
  version: 1;
  store: string;
  epoch: number;
  revision: number;
  nextSequence: number;
  environments: ControllerEnvironment[];
  sessions: ControllerLegacySession[];
  events: ControllerEvent[];
};

const EVENT_KINDS: readonly string[] = [
  "acquired",
  "renewed",
  "released",
  "expired",
  "invalidated",
  "observed",
  "consent",
  "reconnected",
];
const LEGACY_EVENT_KINDS: readonly string[] = EVENT_KINDS.slice(0, 6);
const PROJECTION_STATUSES: readonly string[] = [
  "READY",
  "APP_ERROR",
  "BLOCKED",
  "STOPPED",
  "STARTING",
  "RECOVERING",
  "WAITING_CAPACITY",
  "PARKED_CAPACITY",
  "UNKNOWN",
];

function fail(): never {
  throw new Error("Invalid controller snapshot.");
}
function fields(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) fail();
}
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
function id(value: unknown): value is string {
  return text(value, 128) && /^[a-zA-Z0-9_-]+$/.test(value);
}
function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function requirements(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 16 &&
    new Set(value).size === value.length &&
    value.every(
      (entry: unknown) => text(entry, 132) && /^(runtime|app:[a-z0-9][a-z0-9-]*)$/.test(entry),
    )
  );
}
function parkingConsent(value: unknown): value is ControllerParkingConsent {
  return value === "protected" || value === "allow-unusable";
}
function retainedReason(value: unknown): value is ControllerRetainedReason {
  return (
    value === "expired" ||
    value === "restart" ||
    value === "discontinuity" ||
    value === "binding-changed"
  );
}
/**
 * Validate one environment and register its logical identity. An id or path may
 * only ever map to the one counterpart, so drifted own fields stay one logical
 * environment while incompatible id/path mappings refuse.
 */
function checkEnvironment(
  value: unknown,
  ids: Map<string, string>,
  paths: Map<string, string>,
): void {
  fields(value, [
    "id",
    "repoPath",
    "workspace",
    "provider",
    "providerId",
    "profile",
    "fingerprint",
  ]);
  if (
    !id(value.id) ||
    !text(value.repoPath, 4096) ||
    !path.isAbsolute(value.repoPath) ||
    path.resolve(value.repoPath) !== value.repoPath ||
    !id(value.workspace) ||
    !id(value.providerId) ||
    !text(value.profile) ||
    !/^[a-z0-9-]+(?:,[a-z0-9-]+)*$/.test(value.profile) ||
    !text(value.fingerprint, 128) ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !["devpod", "devsy"].includes(String(value.provider))
  )
    fail();
  const knownPath = ids.get(value.id);
  if (knownPath !== undefined && knownPath !== value.repoPath) fail();
  const knownId = paths.get(value.repoPath);
  if (knownId !== undefined && knownId !== value.id) fail();
  ids.set(value.id, value.repoPath);
  paths.set(value.repoPath, value.id);
}
function checkProjection(session: Record<string, unknown>): void {
  if (session.observation === undefined) return;
  const observation = session.observation;
  fields(observation, [
    "status",
    "sampledAtMs",
    "validUntilMs",
    "journalRevision",
    "runtimeFingerprint",
  ]);
  if (
    !PROJECTION_STATUSES.includes(String(observation.status)) ||
    !counter(observation.sampledAtMs) ||
    !counter(observation.validUntilMs) ||
    observation.validUntilMs < observation.sampledAtMs ||
    !counter(observation.journalRevision) ||
    !text(observation.runtimeFingerprint, 128) ||
    !/^[a-f0-9]{64}$/.test(observation.runtimeFingerprint)
  )
    fail();
}
function checkEvents(events: unknown[], nextSequence: number, kinds: readonly string[]): void {
  let previous = 0;
  for (const event of events) {
    fields(event, ["sequence", "session", "generation", "kind"]);
    if (
      !counter(event.sequence) ||
      event.sequence <= previous ||
      event.sequence >= nextSequence ||
      !id(event.session) ||
      !id(event.generation) ||
      typeof event.kind !== "string" ||
      !kinds.includes(event.kind)
    )
      fail();
    previous = event.sequence;
  }
  if (Buffer.byteLength(JSON.stringify(events)) > 262_144) fail();
}

export function validateControllerSnapshot(value: unknown): asserts value is ControllerSnapshot {
  fields(value, [
    "version",
    "store",
    "epoch",
    "revision",
    "parkingRevision",
    "history",
    "nextSequence",
    "environments",
    "sessions",
    "retainedSessions",
    "events",
  ]);
  if (
    value.version !== 2 ||
    !id(value.store) ||
    !counter(value.epoch) ||
    !counter(value.revision) ||
    !counter(value.parkingRevision) ||
    (value.history !== "complete" && value.history !== "legacy-unknown") ||
    !counter(value.nextSequence) ||
    value.nextSequence < 1 ||
    !Array.isArray(value.environments) ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.retainedSessions) ||
    !Array.isArray(value.events) ||
    value.events.length > 256 ||
    value.sessions.length + value.retainedSessions.length > 128
  )
    fail();
  const ids = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const environment of value.environments) checkEnvironment(environment, ids, paths);
  if (ids.size !== value.environments.length) fail();
  const activeEnvironments = new Set(ids.keys());
  const usedEnvironments = new Set<string>();
  const activeSessions = new Set<string>();
  const tuples = new Set<string>();
  for (const session of value.sessions) {
    fields(session, [
      "id",
      "environmentId",
      "generation",
      "requirements",
      "renewedAtMs",
      "parkingConsent",
      "consentRevision",
      ...(Object.hasOwn(session, "observation") ? ["observation"] : []),
    ]);
    const tuple = `${session.id}\u0000${value.epoch}\u0000${session.generation}`;
    if (
      !id(session.id) ||
      activeSessions.has(session.id) ||
      !id(session.environmentId) ||
      !activeEnvironments.has(session.environmentId) ||
      !id(session.generation) ||
      !counter(session.renewedAtMs) ||
      !requirements(session.requirements) ||
      !parkingConsent(session.parkingConsent) ||
      !counter(session.consentRevision) ||
      tuples.has(tuple)
    )
      fail();
    activeSessions.add(session.id);
    usedEnvironments.add(session.environmentId);
    tuples.add(tuple);
    checkProjection(session);
  }
  if (usedEnvironments.size !== value.environments.length) fail();
  for (const retainedSession of value.retainedSessions) {
    fields(retainedSession, [
      "id",
      "generation",
      "epoch",
      "requirements",
      "parkingConsent",
      "consentRevision",
      "reason",
      "environment",
    ]);
    const tuple = `${retainedSession.id}\u0000${retainedSession.epoch}\u0000${retainedSession.generation}`;
    if (
      !id(retainedSession.id) ||
      !id(retainedSession.generation) ||
      !counter(retainedSession.epoch) ||
      retainedSession.epoch > value.epoch ||
      !requirements(retainedSession.requirements) ||
      !parkingConsent(retainedSession.parkingConsent) ||
      !counter(retainedSession.consentRevision) ||
      !retainedReason(retainedSession.reason) ||
      tuples.has(tuple)
    )
      fail();
    tuples.add(tuple);
    checkEnvironment(retainedSession.environment, ids, paths);
  }
  if (ids.size > 32) fail();
  checkEvents(value.events, value.nextSequence, EVENT_KINDS);
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > CONTROLLER_SNAPSHOT_BYTES) fail();
}

function validateLegacySnapshot(value: unknown): asserts value is ControllerLegacySnapshot {
  fields(value, [
    "version",
    "store",
    "epoch",
    "revision",
    "nextSequence",
    "environments",
    "sessions",
    "events",
  ]);
  if (
    value.version !== 1 ||
    !id(value.store) ||
    !counter(value.epoch) ||
    !counter(value.revision) ||
    !counter(value.nextSequence) ||
    value.nextSequence < 1 ||
    !Array.isArray(value.environments) ||
    value.environments.length > 32 ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 128 ||
    !Array.isArray(value.events) ||
    value.events.length > 256
  )
    fail();
  const ids = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const environment of value.environments) checkEnvironment(environment, ids, paths);
  if (ids.size !== value.environments.length) fail();
  const activeEnvironments = new Set(ids.keys());
  const usedEnvironments = new Set<string>();
  const sessions = new Set<string>();
  for (const session of value.sessions) {
    fields(session, [
      "id",
      "environmentId",
      "generation",
      "requirements",
      "renewedAtMs",
      ...(Object.hasOwn(session, "observation") ? ["observation"] : []),
    ]);
    if (
      !id(session.id) ||
      sessions.has(session.id) ||
      !id(session.environmentId) ||
      !activeEnvironments.has(session.environmentId) ||
      !id(session.generation) ||
      !counter(session.renewedAtMs) ||
      !requirements(session.requirements)
    )
      fail();
    sessions.add(session.id);
    usedEnvironments.add(session.environmentId);
    checkProjection(session);
  }
  if (usedEnvironments.size !== value.environments.length) fail();
  checkEvents(value.events, value.nextSequence, LEGACY_EVENT_KINDS);
  if (Buffer.byteLength(JSON.stringify(value)) + 1 > CONTROLLER_SNAPSHOT_BYTES) fail();
}

/**
 * Read-only shape migration. Absent consent never implies consent, so every
 * surviving session stays protected at revision zero.
 */
function normalizeLegacySnapshot(value: ControllerLegacySnapshot): ControllerSnapshot {
  return {
    version: 2,
    store: value.store,
    epoch: value.epoch,
    revision: value.revision,
    parkingRevision: 0,
    history: "legacy-unknown",
    nextSequence: value.nextSequence,
    environments: value.environments.map((environment) => ({ ...environment })),
    sessions: value.sessions.map((session) => ({
      id: session.id,
      environmentId: session.environmentId,
      generation: session.generation,
      requirements: [...session.requirements],
      renewedAtMs: session.renewedAtMs,
      parkingConsent: "protected",
      consentRevision: 0,
      ...(session.observation ? { observation: { ...session.observation } } : {}),
    })),
    retainedSessions: [],
    events: value.events.map((event) => ({ ...event })),
  };
}
/** Version dispatch is exact: legacy bytes validate strictly, then normalize in memory only. */
function parseStoredSnapshot(value: unknown): ControllerSnapshot {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1
  ) {
    validateLegacySnapshot(value);
    return normalizeLegacySnapshot(value);
  }
  validateControllerSnapshot(value);
  return value;
}

/** Only the controller's exclusive lifetime owner may read-modify-write this store. */
export class ControllerStore {
  readonly file: string;
  constructor(
    readonly directory: string,
    private readonly write = writeFileAtomically,
  ) {
    this.file = path.join(directory, "snapshot.json");
  }

  private readBytes(): Buffer | undefined {
    let fd: number;
    try {
      fd = fs.openSync(
        this.file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Controller snapshot cannot be opened.");
    }
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > CONTROLLER_SNAPSHOT_BYTES
      )
        fail();
      const bytes = Buffer.alloc(CONTROLLER_SNAPSHOT_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > CONTROLLER_SNAPSHOT_BYTES) fail();
      return bytes.subarray(0, length);
    } catch {
      throw new Error("Controller snapshot is unreadable or invalid.");
    } finally {
      fs.closeSync(fd);
    }
  }

  read(): ControllerSnapshot | undefined {
    const bytes = this.readBytes();
    if (!bytes) return undefined;
    try {
      return parseStoredSnapshot(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Error("Controller snapshot is unreadable or invalid.");
    }
  }

  persist(snapshot: ControllerSnapshot): void {
    validateControllerSnapshot(snapshot);
    // Reject an unsafe or corrupt existing destination before replacing it.
    this.read();
    const contents = `${JSON.stringify(snapshot)}\n`;
    try {
      this.write(this.file, contents);
    } catch {
      // Rename can precede a failed directory sync. Only the exact stored bytes
      // prove this transition reached disk; a normalized legacy view does not.
      const stored = this.readBytes();
      if (!stored || stored.toString("utf8") !== contents)
        throw new Error("Controller snapshot commit failed.");
      for (const file of [this.file, this.directory]) {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  }

  startIncarnation(): ControllerSnapshot {
    const previous = this.read();
    if (
      previous &&
      (previous.epoch === Number.MAX_SAFE_INTEGER ||
        previous.revision === Number.MAX_SAFE_INTEGER ||
        previous.parkingRevision === Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Controller snapshot counters exhausted.");
    const snapshot: ControllerSnapshot = {
      version: 2,
      store: previous?.store ?? randomUUID(),
      epoch: (previous?.epoch ?? 0) + 1,
      revision: (previous?.revision ?? 0) + 1,
      parkingRevision: previous ? previous.parkingRevision + 1 : 0,
      history: previous?.history ?? "complete",
      nextSequence: 1,
      environments: [],
      sessions: [],
      retainedSessions: previous
        ? [...previous.retainedSessions, ...previous.sessions.map((s) => retain(s, previous))]
        : [],
      events: [],
    };
    this.persist(snapshot);
    return snapshot;
  }
}

function retain(
  session: ControllerSession,
  previous: ControllerSnapshot,
): ControllerRetainedSession {
  const environment = previous.environments.find(
    (candidate) => candidate.id === session.environmentId,
  );
  if (!environment) fail();
  return {
    id: session.id,
    generation: session.generation,
    epoch: previous.epoch,
    requirements: [...session.requirements],
    parkingConsent: session.parkingConsent,
    consentRevision: session.consentRevision,
    reason: "restart",
    environment: { ...environment },
  };
}

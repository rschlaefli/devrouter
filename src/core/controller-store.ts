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
export type ControllerSession = {
  id: string;
  environmentId: string;
  generation: string;
  requirements: string[];
  renewedAtMs: number;
  observation?: ControllerProjection;
};
export type ControllerEvent = {
  sequence: number;
  session: string;
  generation: string;
  kind: "acquired" | "renewed" | "released" | "expired" | "invalidated" | "observed";
};
export type ControllerSnapshot = {
  version: 1;
  store: string;
  epoch: number;
  revision: number;
  nextSequence: number;
  environments: ControllerEnvironment[];
  sessions: ControllerSession[];
  events: ControllerEvent[];
};

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

export function validateControllerSnapshot(value: unknown): asserts value is ControllerSnapshot {
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
  const environments = new Set<string>();
  const checkouts = new Set<string>();
  for (const env of value.environments) {
    fields(env, [
      "id",
      "repoPath",
      "workspace",
      "provider",
      "providerId",
      "profile",
      "fingerprint",
    ]);
    if (
      !id(env.id) ||
      environments.has(env.id) ||
      !text(env.repoPath, 4096) ||
      !path.isAbsolute(env.repoPath) ||
      path.resolve(env.repoPath) !== env.repoPath ||
      checkouts.has(env.repoPath) ||
      !id(env.workspace) ||
      !id(env.providerId) ||
      !text(env.profile) ||
      !/^[a-z0-9-]+(?:,[a-z0-9-]+)*$/.test(env.profile) ||
      !text(env.fingerprint, 128) ||
      !/^[a-f0-9]{64}$/.test(env.fingerprint) ||
      !["devpod", "devsy"].includes(String(env.provider))
    )
      fail();
    environments.add(env.id);
    checkouts.add(env.repoPath);
  }
  const sessions = new Set<string>();
  const usedEnvironments = new Set<string>();
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
      !environments.has(session.environmentId) ||
      !id(session.generation) ||
      !counter(session.renewedAtMs) ||
      !Array.isArray(session.requirements) ||
      session.requirements.length < 1 ||
      session.requirements.length > 16 ||
      new Set(session.requirements).size !== session.requirements.length ||
      session.requirements.some(
        (r: unknown) => !text(r, 132) || !/^(runtime|app:[a-z0-9][a-z0-9-]*)$/.test(r),
      )
    )
      fail();
    if (session.observation !== undefined) {
      const observation = session.observation;
      fields(observation, [
        "status",
        "sampledAtMs",
        "validUntilMs",
        "journalRevision",
        "runtimeFingerprint",
      ]);
      if (
        ![
          "READY",
          "APP_ERROR",
          "BLOCKED",
          "STOPPED",
          "STARTING",
          "RECOVERING",
          "WAITING_CAPACITY",
          "PARKED_CAPACITY",
          "UNKNOWN",
        ].includes(String(observation.status)) ||
        !counter(observation.sampledAtMs) ||
        !counter(observation.validUntilMs) ||
        observation.validUntilMs < observation.sampledAtMs ||
        !counter(observation.journalRevision) ||
        !text(observation.runtimeFingerprint, 128) ||
        !/^[a-f0-9]{64}$/.test(observation.runtimeFingerprint)
      )
        fail();
    }
    sessions.add(session.id);
    usedEnvironments.add(session.environmentId);
  }
  if (usedEnvironments.size !== environments.size) fail();
  let previous = 0;
  for (const event of value.events) {
    fields(event, ["sequence", "session", "generation", "kind"]);
    if (
      !counter(event.sequence) ||
      event.sequence <= previous ||
      event.sequence >= value.nextSequence ||
      !id(event.session) ||
      !id(event.generation) ||
      !["acquired", "renewed", "released", "expired", "invalidated", "observed"].includes(
        String(event.kind),
      )
    )
      fail();
    previous = event.sequence;
  }
  if (
    Buffer.byteLength(JSON.stringify(value.events)) > 262_144 ||
    Buffer.byteLength(JSON.stringify(value)) + 1 > CONTROLLER_SNAPSHOT_BYTES
  )
    fail();
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

  read(): ControllerSnapshot | undefined {
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
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      validateControllerSnapshot(value);
      return value;
    } catch {
      throw new Error("Controller snapshot is unreadable or invalid.");
    } finally {
      fs.closeSync(fd);
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
      // Rename can precede a failed directory sync. Exact bytes must be synced
      // again before acknowledging this transition; otherwise the owner exits.
      const current = this.read();
      if (!current || `${JSON.stringify(current)}\n` !== contents)
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
      (previous.epoch === Number.MAX_SAFE_INTEGER || previous.revision === Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Controller snapshot counters exhausted.");
    const snapshot: ControllerSnapshot = {
      version: 1,
      store: previous?.store ?? randomUUID(),
      epoch: (previous?.epoch ?? 0) + 1,
      revision: (previous?.revision ?? 0) + 1,
      nextSequence: 1,
      environments: [],
      sessions: [],
      events: [],
    };
    this.persist(snapshot);
    return snapshot;
  }
}

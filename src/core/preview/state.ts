import { stringify } from "yaml";
import { parsePreviewManifest } from "./manifest";

export type StateRecord<T> = { version: string; value: T };

export interface PreviewStateStore {
  read<T>(key: string, validate: (value: unknown) => T): Promise<StateRecord<T> | null>;
  compareAndSwap<T>(key: string, expectedVersion: string | null, value: T): Promise<string>;
}

export class PreviewStateConflict extends Error {
  constructor() {
    super("Preview state changed concurrently; re-read before retrying.");
    this.name = "PreviewStateConflict";
  }
}

export function validateStateKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    !/^[A-Za-z0-9/_-]+$/.test(key) ||
    key.split("/").some((segment) => segment.length === 0)
  )
    throw new Error("Preview state key must be a bounded relative namespace.");
}

export async function updatePreviewState<T>(options: {
  store: PreviewStateStore;
  key: string;
  validate: (value: unknown) => T;
  update: (current: T) => T;
}): Promise<StateRecord<T>> {
  validateStateKey(options.key);
  // The callback is pure: a conflict may evaluate it again, before any provider effect.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await options.store.read(options.key, options.validate);
    if (!current)
      throw new Error("Preview state is absent; explicit installation initialization is required.");
    const value = options.validate(options.update(current.value));
    try {
      const version = await options.store.compareAndSwap(options.key, current.version, value);
      return { value, version };
    } catch (error) {
      if (!(error instanceof PreviewStateConflict)) throw error;
    }
  }
  throw new PreviewStateConflict();
}

export type PreviewEffectStep = {
  name: string;
  mode: "once" | "convergent";
  state: "intent" | "accepted" | "uncertain";
  fingerprint?: string;
  at: number;
  ref?: string;
};

export type PreviewEffect = {
  id: string;
  kind: "deploy" | "deadline" | "cancel" | "destroy";
  generation: string;
  operationVersion: number;
  deadlineVersion: number;
  ownershipVersion: number;
  target?: number;
  phase: "prepared" | "submitted" | "terminal";
  leaseOwner: string;
  leaseExpiresAt: number;
  resources: string[];
  ready?: boolean;
  confirmedDeadline?: number;
  outcome?: "succeeded" | "failed" | "cancelled";
  steps?: PreviewEffectStep[];
};

export type PreviewPoolEntry = {
  session: import("./lifecycle").PreviewSession;
  plan: import("./types").PreviewPlanReport;
  reservedCents: number;
  hourlyCents: number;
  operations: Record<string, PreviewEffect>;
  effectSequence: number;
  ownershipOverflow?: boolean;
  readyObservedAt?: number;
  completedAt?: number;
};

export type PreviewPool = {
  schemaVersion: 1;
  installationId: string;
  sessions: Record<string, PreviewPoolEntry>;
  processedCommands: Array<{ id: string; admittedAt: number }>;
};

export function createPreviewPool(installationId: string): PreviewPool {
  return decodePreviewPool({
    schemaVersion: 1,
    installationId,
    sessions: {},
    processedCommands: [],
  });
}

export function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid preview state object.");
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => ![...required, ...optional].includes(key))
  ) {
    throw new Error("Invalid preview state fields.");
  }
  return record;
}

function text(value: unknown, max = 256): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error("Invalid preview state identifier.");
  }
}

function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error("Invalid preview state number.");
}

function strings(value: unknown, max = 1024, length = 256): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid preview state list.");
  for (const entry of value) text(entry, length);
  if (new Set(value).size !== value.length) throw new Error("Duplicate preview state entries.");
}

function oneOf(value: unknown, allowed: unknown[]): void {
  if (!allowed.includes(value)) throw new Error("Invalid preview state enum.");
}

function decodeSession(value: unknown): import("./lifecycle").PreviewSession {
  const row = object(
    value,
    [
      "generation",
      "status",
      "createdAt",
      "setupDeadline",
      "expiresAt",
      "extensions",
      "operationVersion",
      "ownershipVersion",
      "deadlineVersion",
      "desiredRevision",
      "desiredAliases",
      "stale",
      "processedCommands",
      "outstandingOperations",
      "ownedResources",
      "reservationHeld",
    ],
    ["firstReadyAt", "stopReason", "pendingDeadline"],
  );
  text(row.generation);
  oneOf(row.status, [
    "provisioning",
    "ready",
    "updating",
    "stopping",
    "cleanup-pending",
    "stopped",
    "expired",
    "failed",
  ]);
  for (const key of ["createdAt", "setupDeadline", "expiresAt", "extensions"]) integer(row[key]);
  for (const key of ["operationVersion", "ownershipVersion", "deadlineVersion"])
    integer(row[key], 1);
  text(row.desiredRevision, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.desiredRevision))
    throw new Error("Invalid preview source revision.");
  strings(row.desiredAliases, 64, 63);
  if (row.desiredAliases.some((alias) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias)))
    throw new Error("Invalid preview alias.");
  strings(row.processedCommands);
  strings(row.outstandingOperations);
  strings(row.ownedResources, 64, 128);
  if (typeof row.stale !== "boolean" || typeof row.reservationHeld !== "boolean")
    throw new Error("Invalid preview state flag.");
  if (row.stopReason !== undefined)
    oneOf(row.stopReason, ["stop", "closed", "expiry", "setup-timeout"]);
  if (row.pendingDeadline !== undefined) {
    const pending = object(row.pendingDeadline, ["target", "commandId"]);
    integer(pending.target);
    text(pending.commandId);
  }
  if (row.firstReadyAt !== undefined) integer(row.firstReadyAt);
  const session = row as unknown as import("./lifecycle").PreviewSession;
  if (
    session.setupDeadline !== session.createdAt + 20 * 60_000 ||
    session.extensions > 2 ||
    session.expiresAt < session.createdAt
  ) {
    throw new Error("Inconsistent preview lifetime.");
  }
  if (session.firstReadyAt === undefined) {
    if (
      session.expiresAt !== session.createdAt + 140 * 60_000 ||
      session.extensions !== 0 ||
      session.pendingDeadline
    )
      throw new Error("Inconsistent initial preview deadline.");
  } else if (
    session.firstReadyAt < session.createdAt ||
    session.firstReadyAt >= session.setupDeadline ||
    session.expiresAt > session.firstReadyAt + (2 + session.extensions) * 3_600_000 ||
    session.expiresAt < session.firstReadyAt + 2 * 3_600_000 - 120_000
  ) {
    throw new Error("Inconsistent ready preview deadline.");
  }
  const terminal = session.status === "stopped" || session.status === "expired";
  if (
    terminal &&
    (session.reservationHeld ||
      session.ownedResources.length ||
      session.outstandingOperations.length)
  )
    throw new Error("Terminal preview still owns effects.");
  if (!terminal && !session.reservationHeld)
    throw new Error("Active preview lost its reservation.");
  if (
    session.pendingDeadline &&
    (session.extensions >= 2 ||
      session.pendingDeadline.target !== session.expiresAt + 3_600_000 ||
      !session.processedCommands.includes(session.pendingDeadline.commandId))
  )
    throw new Error("Invalid pending preview extension.");
  return session;
}

function decodePlan(value: unknown): import("./types").PreviewPlanReport {
  const row = object(
    value,
    [
      "schemaVersion",
      "status",
      "aliases",
      "resources",
      "reasons",
      "manifestDigest",
      "localConfigDigest",
      "source",
      "omissions",
    ],
    ["profiles"],
  );
  if (row.schemaVersion !== 1 || row.status !== "planned")
    throw new Error("Stored preview plan is not deployable.");
  for (const key of [
    "aliases",
    "reasons",
    "omissions",
    ...(row.profiles === undefined ? [] : ["profiles"]),
  ])
    strings(row[key]);
  for (const key of ["manifestDigest", "localConfigDigest"]) {
    text(row[key], 64);
    if (!/^[a-f0-9]{64}$/.test(row[key] as string))
      throw new Error("Invalid preview config digest.");
  }
  const source = object(row.source, ["head", "target", "mergeBase", "complete", "changes"]);
  for (const key of ["head", "target", "mergeBase"]) {
    text(source[key], 64);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source[key] as string))
      throw new Error("Invalid stored source identity.");
  }
  if (source.complete !== true || !Array.isArray(source.changes) || source.changes.length > 10_000)
    throw new Error("Incomplete stored preview source.");
  for (const change of source.changes) {
    const item = object(change, ["status", "path"], ["oldPath"]);
    oneOf(item.status, ["A", "M", "D", "R", "C", "T"]);
    for (const key of ["path", ...(item.oldPath === undefined ? [] : ["oldPath"])]) {
      text(item[key], 4096);
      if (
        (item[key] as string).startsWith("/") ||
        (item[key] as string).includes("\\") ||
        (item[key] as string).split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Invalid stored source path.");
    }
    if ((item.status === "R" || item.status === "C") !== (item.oldPath !== undefined))
      throw new Error("Invalid stored rename.");
  }
  if (!Array.isArray(row.resources) || row.resources.length > 256)
    throw new Error("Invalid stored preview graph.");
  const resources: Record<string, unknown> = {};
  for (const resource of row.resources) {
    const item = object(
      resource,
      ["id", "kind"],
      ["dependsOn", "image", "build", "ports", "command"],
    );
    text(item.id, 63);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id))
      throw new Error("Invalid stored preview resource identifier.");
    if (Object.hasOwn(resources, item.id)) throw new Error("Duplicate stored preview resource.");
    const { id, ...definition } = item;
    resources[id as string] = definition;
  }
  // Reuse the strict resource/DAG schema rather than maintain a second deployment vocabulary.
  const aliases = row.aliases as string[];
  if (!aliases.length || (row.reasons as string[]).includes("source-unbound"))
    throw new Error("Unbound stored preview plan.");
  parsePreviewManifest(
    stringify({
      version: 1,
      aliases: Object.fromEntries(
        aliases.map((alias) => [alias, { resources: Object.keys(resources) }]),
      ),
      bindings: { apps: {}, dependencies: {}, services: {}, processes: {} },
      resources,
      selection: { rules: [], ignorePaths: [], controlPaths: [], allowedUnions: [] },
    }),
  );
  return row as unknown as import("./types").PreviewPlanReport;
}

export function decodePreviewPool(value: unknown): PreviewPool {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 1024 * 1024)
    throw new Error("Preview pool exceeds its bound.");
  const root = object(value, ["schemaVersion", "installationId", "sessions", "processedCommands"]);
  if (root.schemaVersion !== 1) throw new Error("Unsupported preview pool version.");
  text(root.installationId, 63);
  if (!/^[a-z0-9-]+$/.test(root.installationId)) throw new Error("Invalid preview installation.");
  if (!Array.isArray(root.processedCommands) || root.processedCommands.length > 1024)
    throw new Error("Invalid preview command window.");
  const receiptIds = new Set<string>();
  for (const receipt of root.processedCommands) {
    const item = object(receipt, ["id", "admittedAt"]);
    text(item.id, 512);
    integer(item.admittedAt);
    if (receiptIds.has(item.id)) throw new Error("Duplicate preview command receipt.");
    receiptIds.add(item.id);
  }
  const sessions = root.sessions;
  if (
    !sessions ||
    typeof sessions !== "object" ||
    Array.isArray(sessions) ||
    Object.keys(sessions).length > 128
  )
    throw new Error("Preview pool session bound exceeded.");
  for (const [id, value] of Object.entries(sessions)) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid preview identity key.");
    const entry = object(
      value,
      ["session", "plan", "reservedCents", "hourlyCents", "operations", "effectSequence"],
      ["readyObservedAt", "completedAt", "ownershipOverflow"],
    );
    const session = decodeSession(entry.session);
    const plan = decodePlan(entry.plan);
    integer(entry.reservedCents);
    integer(entry.effectSequence);
    if (entry.ownershipOverflow !== undefined && entry.ownershipOverflow !== true)
      throw new Error("Invalid ownership overflow marker.");
    integer(entry.hourlyCents, 1);
    if (entry.readyObservedAt !== undefined) integer(entry.readyObservedAt);
    if (entry.completedAt !== undefined) {
      integer(entry.completedAt);
      if (session.reservationHeld) throw new Error("Active preview has a completion time.");
    }
    if (
      session.desiredRevision !== plan.source?.head ||
      JSON.stringify(session.desiredAliases) !== JSON.stringify(plan.aliases)
    )
      throw new Error("Preview plan differs from desired identity.");
    if (
      !entry.operations ||
      typeof entry.operations !== "object" ||
      Array.isArray(entry.operations) ||
      Object.keys(entry.operations).length > 1024
    )
      throw new Error("Invalid preview operation registry.");
    for (const [operationId, raw] of Object.entries(entry.operations)) {
      const effect = object(
        raw,
        [
          "id",
          "kind",
          "generation",
          "operationVersion",
          "deadlineVersion",
          "ownershipVersion",
          "phase",
          "leaseOwner",
          "leaseExpiresAt",
          "resources",
        ],
        ["target", "ready", "confirmedDeadline", "outcome", "steps"],
      );
      text(effect.id);
      text(effect.generation);
      text(effect.leaseOwner);
      if (effect.id !== operationId || effect.generation !== session.generation)
        throw new Error("Foreign preview effect.");
      oneOf(effect.kind, ["deploy", "deadline", "cancel", "destroy"]);
      oneOf(effect.phase, ["prepared", "submitted", "terminal"]);
      integer(effect.operationVersion, 1);
      integer(effect.deadlineVersion, 1);
      integer(effect.ownershipVersion, 1);
      integer(effect.leaseExpiresAt);
      strings(effect.resources, 64, 128);
      if (effect.outcome !== undefined) oneOf(effect.outcome, ["succeeded", "failed", "cancelled"]);
      if (effect.target !== undefined) integer(effect.target);
      if (effect.confirmedDeadline !== undefined) integer(effect.confirmedDeadline);
      if (effect.ready !== undefined && typeof effect.ready !== "boolean")
        throw new Error("Invalid readiness receipt.");
      if (effect.steps !== undefined) {
        if (!Array.isArray(effect.steps) || effect.steps.length > 144)
          throw new Error("Preview provider step journal exceeds its bound.");
        const names = new Set<string>();
        for (const rawStep of effect.steps) {
          const step = object(rawStep, ["name", "mode", "state", "at"], ["ref", "fingerprint"]);
          text(step.name, 64);
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.name) || names.has(step.name))
            throw new Error("Invalid preview provider step identity.");
          names.add(step.name);
          oneOf(step.mode, ["once", "convergent"]);
          oneOf(step.state, ["intent", "accepted", "uncertain"]);
          integer(step.at);
          if (step.ref !== undefined) text(step.ref, 128);
          if (
            step.fingerprint !== undefined &&
            (typeof step.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(step.fingerprint))
          )
            throw new Error("Invalid non-secret provider step fingerprint.");
        }
      }
      const outstanding = session.outstandingOperations.includes(operationId);
      if (
        (effect.kind === "deploy" || effect.kind === "deadline") &&
        outstanding !== (effect.phase !== "terminal")
      )
        throw new Error("Preview operation tracking differs from its receipt.");
    }
    if (
      session.outstandingOperations.some(
        (operationId) => !Object.hasOwn(entry.operations as object, operationId),
      )
    )
      throw new Error("Preview effect receipt is missing.");
    if (!session.reservationHeld && entry.reservedCents !== 0)
      throw new Error("Terminal preview retains reserved cost.");
  }
  return structuredClone(root) as unknown as PreviewPool;
}

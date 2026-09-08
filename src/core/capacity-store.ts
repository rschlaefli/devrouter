import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import {
  type CapacityCharge,
  type CapacityDomainBudget,
  type CapacityDomainSample,
  evaluateCapacity,
} from "./capacity-accounting";
import { withFileLockSync } from "./file-lock";

export type CapacityReservation = CapacityCharge & {
  operationId: string;
  reservationId: string;
  policyRevision: number;
};
export type CapacityPoolReservation = {
  daemonId: string;
  runtimeDomain: string;
  hostDomain: string;
  hostChargeCeilingBytes: number;
};
type Snapshot = {
  version: 1;
  revision: number;
  reservations: CapacityReservation[];
  pools?: CapacityPoolReservation[];
};
const MAX_BYTES = 1_048_576;

export class CapacitySnapshotChangedError extends Error {
  constructor() {
    super("Capacity snapshot changed.");
    this.name = "CapacitySnapshotChangedError";
  }
}

function assertPrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(directoryPath);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error("Capacity reservation directory is not private.");
}

function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error("Invalid capacity reservation fields.");
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function validatePools(value: unknown): asserts value is CapacityPoolReservation[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid capacity pools.");
  const daemons = new Set<string>();
  const runtimes = new Set<string>();
  for (const pool of value) {
    object(pool, ["daemonId", "runtimeDomain", "hostDomain", "hostChargeCeilingBytes"]);
    if (
      typeof pool.daemonId !== "string" ||
      pool.daemonId.length === 0 ||
      pool.daemonId.length > 256 ||
      pool.daemonId !== pool.daemonId.trim() ||
      [...pool.daemonId].some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      ) ||
      !id(pool.runtimeDomain) ||
      !id(pool.hostDomain) ||
      pool.runtimeDomain === pool.hostDomain ||
      !Number.isSafeInteger(pool.hostChargeCeilingBytes) ||
      Number(pool.hostChargeCeilingBytes) <= 0 ||
      daemons.has(pool.daemonId) ||
      runtimes.has(pool.runtimeDomain)
    )
      throw new Error("Invalid capacity pool identity or ceiling.");
    daemons.add(pool.daemonId);
    runtimes.add(pool.runtimeDomain);
  }
}
function validate(value: unknown): asserts value is Snapshot {
  const hasPools = !!value && typeof value === "object" && Object.hasOwn(value, "pools");
  object(value, ["version", "revision", "reservations", ...(hasPools ? ["pools"] : [])]);
  if (hasPools) validatePools(value.pools);
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Array.isArray(value.reservations) ||
    value.reservations.length > 256
  )
    throw new Error("Invalid capacity reservation snapshot.");
  const environments = new Set<string>();
  const operations = new Set<string>();
  const reservations = new Set<string>();
  for (const reservation of value.reservations) {
    object(reservation, [
      "environmentId",
      "operationId",
      "reservationId",
      "policyRevision",
      "totals",
      "startup",
      "heavy",
    ]);
    if (
      !id(reservation.environmentId) ||
      !id(reservation.operationId) ||
      !id(reservation.reservationId) ||
      !Number.isSafeInteger(reservation.policyRevision) ||
      Number(reservation.policyRevision) < 1 ||
      typeof reservation.startup !== "boolean" ||
      typeof reservation.heavy !== "boolean" ||
      environments.has(reservation.environmentId) ||
      operations.has(reservation.operationId) ||
      reservations.has(reservation.reservationId)
    )
      throw new Error("Invalid capacity reservation identity.");
    environments.add(reservation.environmentId);
    operations.add(reservation.operationId);
    reservations.add(reservation.reservationId);
    const totals = reservation.totals;
    if (
      !totals ||
      typeof totals !== "object" ||
      Array.isArray(totals) ||
      Object.keys(totals).length < 1 ||
      Object.keys(totals).length > 256 ||
      Object.entries(totals).some(
        ([key, bytes]) => !id(key) || !Number.isSafeInteger(bytes) || Number(bytes) < 0,
      )
    )
      throw new Error("Invalid capacity reservation totals.");
  }
}

function mergePools(
  pools: CapacityPoolReservation[],
  incoming: CapacityPoolReservation[],
): boolean {
  let changed = false;
  for (const requested of incoming) {
    const retained = pools.find((pool) => pool.daemonId === requested.daemonId);
    if (retained) {
      if (
        retained.hostDomain !== requested.hostDomain ||
        retained.runtimeDomain !== requested.runtimeDomain
      )
        throw new Error("Capacity pool binding changed.");
      if (requested.hostChargeCeilingBytes > retained.hostChargeCeilingBytes) {
        retained.hostChargeCeilingBytes = requested.hostChargeCeilingBytes;
        changed = true;
      }
    } else {
      pools.push(structuredClone(requested));
      changed = true;
    }
  }
  validatePools(pools);
  return changed;
}

function serializeSnapshot(snapshot: Snapshot): string {
  const contents = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(contents) > MAX_BYTES)
    throw new Error("Capacity reservation snapshot exceeds byte limit.");
  return contents;
}

/** One short all-domain transaction; lifecycle and provider locks stay outside it. */
export class CapacityStore {
  private file: string;
  constructor(private directory: string) {
    this.file = path.join(directory, "capacity-reservations.json");
  }

  read(): Snapshot {
    let descriptor: number;
    try {
      descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, revision: 0, reservations: [] };
      throw error;
    }
    try {
      const stat = fs.fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_BYTES
      )
        throw new Error("Unsafe capacity reservation snapshot.");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (count > MAX_BYTES) throw new Error("Capacity reservation snapshot exceeds byte limit.");
      const value: unknown = JSON.parse(buffer.subarray(0, count).toString("utf8"));
      validate(value);
      return value;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  /**
   * Caller must revoke journal authority and prove exact physical cessation first.
   * An absent reservation still advances the revision to fence that proof.
   */
  settleEnvironmentAfterStop(
    environmentId: string,
    expectedRevision: number,
  ): { settled: boolean; revision: number } {
    if (!id(environmentId)) throw new Error("Invalid capacity environment ID.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Invalid capacity settlement revision.");
    assertPrivateDirectory(this.directory);
    return withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity settlement", waitMs: 100 },
      () => {
        const snapshot = this.read();
        if (snapshot.revision !== expectedRevision) throw new CapacitySnapshotChangedError();
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        const index = snapshot.reservations.findIndex(
          (entry) => entry.environmentId === environmentId,
        );
        if (index >= 0) snapshot.reservations.splice(index, 1);
        snapshot.revision++;
        validate(snapshot);
        writeFileAtomically(this.file, serializeSnapshot(snapshot));
        return { settled: index >= 0, revision: snapshot.revision };
      },
    );
  }

  /** Retain positively observed pools even when their charge already exceeds admission budgets. */
  mergeObservedPools(
    pools: CapacityPoolReservation[],
    expectedRevision: number,
  ): { changed: boolean; revision: number } {
    validatePools(pools);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Invalid capacity expected revision.");
    assertPrivateDirectory(this.directory);
    return withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity pool observation", waitMs: 100 },
      () => {
        const snapshot = this.read();
        if (snapshot.revision !== expectedRevision) throw new CapacitySnapshotChangedError();
        const merged = structuredClone(snapshot.pools ?? []);
        if (!mergePools(merged, pools)) return { changed: false, revision: snapshot.revision };
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        snapshot.pools = merged;
        snapshot.revision++;
        validate(snapshot);
        writeFileAtomically(this.file, serializeSnapshot(snapshot));
        return { changed: true, revision: snapshot.revision };
      },
    );
  }

  /**
   * Caller must revoke pool launch authority and prove exact VM cessation first.
   * Container or environment cessation alone never permits releasing this ceiling.
   */
  settlePoolAfterCessation(
    identity: Pick<CapacityPoolReservation, "daemonId" | "runtimeDomain" | "hostDomain">,
    expectedRevision: number,
  ): { settled: boolean; revision: number } {
    object(identity, ["daemonId", "runtimeDomain", "hostDomain"]);
    validatePools([{ ...identity, hostChargeCeilingBytes: 1 }]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Invalid capacity settlement revision.");
    assertPrivateDirectory(this.directory);
    return withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity pool settlement", waitMs: 100 },
      () => {
        const snapshot = this.read();
        if (snapshot.revision !== expectedRevision) throw new CapacitySnapshotChangedError();
        const pools = snapshot.pools ?? [];
        const index = pools.findIndex((pool) => pool.daemonId === identity.daemonId);
        const pool = pools[index];
        if (
          (pool &&
            (pool.hostDomain !== identity.hostDomain ||
              pool.runtimeDomain !== identity.runtimeDomain)) ||
          pools.some(
            (entry) =>
              entry.runtimeDomain === identity.runtimeDomain &&
              entry.daemonId !== identity.daemonId,
          ) ||
          snapshot.reservations.some((entry) => Object.hasOwn(entry.totals, identity.runtimeDomain))
        )
          throw new Error("Capacity pool cessation identity remains bound.");
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        if (pool) pools.splice(index, 1);
        snapshot.revision++;
        validate(snapshot);
        writeFileAtomically(this.file, serializeSnapshot(snapshot));
        return { settled: !!pool, revision: snapshot.revision };
      },
    );
  }

  /** Caller persists phase proof and revokes authority before reducing this exact row. */
  reduceAfterPhase(target: CapacityReservation, expectedRevision: number): void {
    validate({ version: 1, revision: 0, reservations: [target] });
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Invalid capacity settlement revision.");
    assertPrivateDirectory(this.directory);
    withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity phase settlement", waitMs: 100 },
      () => {
        const snapshot = this.read();
        if (snapshot.revision !== expectedRevision) throw new CapacitySnapshotChangedError();
        const index = snapshot.reservations.findIndex(
          (entry) => entry.environmentId === target.environmentId,
        );
        const current = snapshot.reservations[index];
        if (
          !current ||
          current.reservationId !== target.reservationId ||
          current.operationId !== target.operationId ||
          current.policyRevision !== target.policyRevision
        )
          throw new Error("Capacity phase settlement predecessor changed.");
        if (
          Object.keys(current.totals).length !== Object.keys(target.totals).length ||
          Object.entries(target.totals).some(
            ([domain, bytes]) =>
              !Object.hasOwn(current.totals, domain) || bytes > current.totals[domain],
          ) ||
          (target.startup && !current.startup) ||
          (target.heavy && !current.heavy)
        )
          throw new Error("Capacity phase settlement cannot acquire resources.");
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        snapshot.reservations[index] = structuredClone(target);
        snapshot.revision++;
        validate(snapshot);
        writeFileAtomically(this.file, serializeSnapshot(snapshot));
      },
    );
  }

  reserve(
    request: CapacityReservation,
    budgets: Record<string, CapacityDomainBudget>,
    samples: Record<string, CapacityDomainSample>,
    nowMs: number,
    maxSampleAgeMs: number,
    // Replacement requires prior journal revocation and positive worker drainage.
    // The snapshot revision fences changes made since that proof was collected.
    previous: { revision: number; reservationId: string; operationId: string } | undefined,
    expectedRevision: number,
    requestedPool?: CapacityPoolReservation,
  ) {
    validate({ version: 1, revision: 0, reservations: [request] });
    if (requestedPool !== undefined) {
      validatePools([requestedPool]);
      if (
        !Object.hasOwn(request.totals, requestedPool.hostDomain) ||
        !Object.hasOwn(request.totals, requestedPool.runtimeDomain)
      )
        throw new Error("Capacity pool request lacks its bound domains.");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("Invalid capacity expected revision.");
    assertPrivateDirectory(this.directory);
    return withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity reservation", waitMs: 100 },
      () => {
        const snapshot = this.read();
        if (snapshot.revision !== expectedRevision) throw new CapacitySnapshotChangedError();
        const pools = structuredClone(snapshot.pools ?? []);
        const poolChanged = mergePools(pools, requestedPool === undefined ? [] : [requestedPool]);
        const existing = snapshot.reservations.find(
          (entry) => entry.environmentId === request.environmentId,
        );
        if (previous) {
          if (
            snapshot.revision !== previous.revision ||
            !existing ||
            existing.reservationId !== previous.reservationId ||
            existing.operationId !== previous.operationId ||
            existing.policyRevision !== request.policyRevision
          )
            throw new Error("Capacity expansion predecessor changed.");
          // Rebinding does not establish cessation of retained runtime resources.
          // Keep every domain and slot until a separate settlement proves release.
          const totals = { ...existing.totals };
          for (const [domain, bytes] of Object.entries(request.totals))
            totals[domain] = Math.max(totals[domain] ?? 0, bytes);
          request = {
            ...request,
            totals,
            startup: existing.startup || request.startup,
            heavy: existing.heavy || request.heavy,
          };
        } else if (existing) {
          if (
            existing.reservationId !== request.reservationId ||
            existing.operationId !== request.operationId ||
            existing.policyRevision !== request.policyRevision ||
            existing.startup !== request.startup ||
            existing.heavy !== request.heavy ||
            Object.keys(existing.totals).length !== Object.keys(request.totals).length ||
            Object.entries(existing.totals).some(
              ([domain, bytes]) => request.totals[domain] !== bytes,
            )
          )
            throw new Error("Environment retains an earlier capacity reservation.");
        }
        const decision = evaluateCapacity(
          budgets,
          samples,
          snapshot.reservations,
          request,
          nowMs,
          maxSampleAgeMs,
          pools,
        );
        if (!decision.admitted) return decision;
        if (!previous && existing && !poolChanged)
          return { admitted: true as const, revision: snapshot.revision, joined: true };
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        snapshot.revision++;
        if (poolChanged) snapshot.pools = pools;
        if (existing)
          snapshot.reservations[snapshot.reservations.indexOf(existing)] = structuredClone(request);
        else snapshot.reservations.push(structuredClone(request));
        validate(snapshot);
        writeFileAtomically(this.file, serializeSnapshot(snapshot));
        return { admitted: true as const, revision: snapshot.revision, joined: false };
      },
    );
  }
}

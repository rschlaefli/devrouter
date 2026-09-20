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
export type CapacityLedgerSnapshot = {
  version: 1;
  revision: number;
  reservations: CapacityReservation[];
  pools?: CapacityPoolReservation[];
};
type Snapshot = CapacityLedgerSnapshot;

/**
 * Durable ledger classification. `absent` is a positive physical-absence proof
 * that recorded history existed; `pristine` is a store that never held history;
 * `stale` is a snapshot the surviving journal evidence has outrun. Only absence
 * can be reconciled, and every other state refuses exactly as `read()` does.
 */
export type CapacityLedgerState =
  | { kind: "pristine" }
  | { kind: "absent" }
  | { kind: "stale"; revision: number }
  | { kind: "intact"; revision: number; snapshot: CapacityLedgerSnapshot };
const MAX_BYTES = 1_048_576;

/**
 * Bounded, values-free reason a capacity read could not prove its history. A
 * code and, at most, one journal entry name reach the operator; record contents
 * never do.
 */
export type CapacityHistoryCause =
  | "journal-directory-unreadable"
  | "journal-directory-unsafe"
  | "journal-entry-unsupported"
  | "journal-enumeration-limit"
  | "journal-enumeration-timeout"
  | "journal-unreadable"
  | "journal-entry-unsafe"
  | "journal-invalid"
  | "journal-identity-mismatch"
  | "journal-unstable"
  | "journal-enumeration-failed";

export class CapacityHistoryError extends Error {
  constructor(
    readonly code: "capacity-ledger-lost" | "capacity-history-unprovable",
    readonly cause: CapacityHistoryCause | null = null,
    readonly location: string | null = null,
  ) {
    super(
      code === "capacity-ledger-lost"
        ? "Capacity ledger history is lost; restore verified capacity-reservations.json."
        : "Capacity history cannot be proven; inspect the private lifecycle journals.",
    );
    this.name = "CapacityHistoryError";
  }
}

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
  private establishedFile: string;
  private observedLedger = false;
  /** Identity of the snapshot file read last, so a replacement cannot reuse its revision. */
  private ledgerGeneration?: string;
  constructor(
    private directory: string,
    private write = writeFileAtomically,
    private minimumRevision: () => number = () => 0,
  ) {
    this.file = path.join(directory, "capacity-reservations.json");
    this.establishedFile = path.join(directory, "capacity-ledger.established");
  }

  private readEstablished(): boolean {
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        this.establishedFile,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const stat = fs.fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 4096
      )
        throw new Error("Unsafe capacity ledger marker.");
      const bytes = Buffer.alloc(4097);
      const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count > 4096) throw new Error("Capacity ledger marker exceeds byte limit.");
      const marker: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
      object(marker, ["version"]);
      if (marker.version !== 1) throw new Error("Invalid capacity ledger marker.");
      return true;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  inspect(): CapacityLedgerState {
    // Read journal evidence first: a concurrent admission publishes its ledger
    // before its journal, so the later ledger cannot legitimately trail this floor.
    const minimumRevision = this.minimumRevision();
    const established = this.readEstablished();
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        this.file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.ledgerGeneration = undefined;
        if (established || this.observedLedger || minimumRevision > 0) return { kind: "absent" };
        return { kind: "pristine" };
      }
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
      this.ledgerGeneration = `${stat.dev}:${stat.ino}`;
      if (value.revision < minimumRevision) return { kind: "stale", revision: value.revision };
      this.observedLedger = true;
      return { kind: "intact", revision: value.revision, snapshot: value };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  read(): Snapshot {
    const state = this.inspect();
    if (state.kind === "intact") return state.snapshot;
    if (state.kind === "pristine") return { version: 1, revision: 0, reservations: [] };
    throw new CapacityHistoryError("capacity-ledger-lost");
  }

  private establish(): void {
    if (!this.readEstablished()) this.write(this.establishedFile, '{"version":1}\n');
    this.syncDurability([this.file, this.establishedFile, this.directory]);
  }

  /**
   * Witness for a ledger that is positively absent. The marker records that
   * history existed here, so no later process can read the store as a fresh
   * install and start admitting; the snapshot stays absent until reconciliation.
   * The caller holds the capacity lock and has proven environment cessation.
   */
  private establishMarkerOnly(): void {
    if (!this.readEstablished()) this.write(this.establishedFile, '{"version":1}\n');
    this.syncDurability([this.establishedFile, this.directory]);
  }

  private syncDurability(files: string[]): void {
    // A visible marker can survive a failed directory sync. No-op retries must
    // complete durability too, including when a new process handles the retry.
    for (const file of files) {
      const descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const stat = fs.fstatSync(descriptor);
        if (
          (file === this.directory ? !stat.isDirectory() : !stat.isFile()) ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error("Unsafe capacity ledger durability artifact.");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }

  private readForMutation(): Snapshot {
    // The identity read before this mutation is the caller's evidence.
    const expectedGeneration = this.ledgerGeneration;
    const snapshot = this.read();
    // Reconciliation publishes a fresh baseline, so the revision number alone
    // cannot fence a caller that read the lost ledger before it was replaced.
    if (expectedGeneration !== undefined && expectedGeneration !== this.ledgerGeneration)
      throw new CapacitySnapshotChangedError();
    if (this.observedLedger) this.establish();
    return snapshot;
  }

  private commit(snapshot: Snapshot): void {
    this.write(this.file, serializeSnapshot(snapshot));
    this.observedLedger = true;
    this.rememberGeneration();
    this.establish();
  }

  /** Remember the published snapshot identity for the next generation fence. */
  private rememberGeneration(): void {
    try {
      const stat = fs.statSync(this.file);
      this.ledgerGeneration = stat.isFile() ? `${stat.dev}:${stat.ino}` : undefined;
    } catch {
      this.ledgerGeneration = undefined;
    }
  }

  /**
   * Durable evidence that recorded history is gone, for a stop whose physical
   * cessation is already proven. The caller holds that proof; this writes no
   * row and asserts nothing about any other environment's charge.
   */
  recordLedgerLoss(): void {
    assertPrivateDirectory(this.directory);
    withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity loss witness", waitMs: 100 },
      () => {
        if (this.inspect().kind !== "absent")
          throw new CapacityHistoryError("capacity-ledger-lost");
        this.establishMarkerOnly();
      },
    );
  }

  /**
   * Replace a provably absent ledger with a fresh baseline under the capacity
   * lock. `plan` runs inside the lock with the authoritative classification and
   * re-verifies the caller's evidence, returning the baseline to write or
   * undefined to refuse without mutation. `confirm` runs in the same lock after
   * the write; returning false withdraws the fresh snapshot, so the store reads
   * as lost again instead of publishing a baseline the caller cannot stand behind.
   */
  reconcileLostHistory(
    plan: (
      state: CapacityLedgerState,
    ) => { revision: number; pools?: CapacityPoolReservation[] } | undefined,
    confirm: () => boolean,
  ): { reconciled: boolean; revision?: number } {
    assertPrivateDirectory(this.directory);
    return withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity reconciliation", waitMs: 100 },
      () => {
        const baseline = plan(this.inspect());
        if (!baseline) return { reconciled: false };
        if (!Number.isSafeInteger(baseline.revision) || baseline.revision < 1)
          throw new Error("Invalid capacity reconciliation revision.");
        const pools = structuredClone(baseline.pools ?? []);
        validatePools(pools);
        const snapshot: Snapshot =
          pools.length === 0
            ? { version: 1, revision: baseline.revision, reservations: [] }
            : { version: 1, revision: baseline.revision, reservations: [], pools };
        validate(snapshot);
        this.commit(snapshot);
        if (confirm()) return { reconciled: true, revision: snapshot.revision };
        this.withdrawSnapshot();
        return { reconciled: false };
      },
    );
  }

  /** Remove a snapshot this store just wrote, keeping the loss witness durable. */
  private withdrawSnapshot(): void {
    try {
      fs.unlinkSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.observedLedger = false;
    this.ledgerGeneration = undefined;
    const directory = fs.openSync(this.directory, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
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
        const snapshot = this.readForMutation();
        if (snapshot.revision !== expectedRevision) throw new CapacitySnapshotChangedError();
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        const index = snapshot.reservations.findIndex(
          (entry) => entry.environmentId === environmentId,
        );
        if (index >= 0) snapshot.reservations.splice(index, 1);
        snapshot.revision++;
        validate(snapshot);
        this.commit(snapshot);
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
        const snapshot = this.readForMutation();
        if (snapshot.revision !== expectedRevision) throw new CapacitySnapshotChangedError();
        const merged = structuredClone(snapshot.pools ?? []);
        if (!mergePools(merged, pools)) {
          if (!this.observedLedger) this.commit(snapshot);
          return { changed: false, revision: snapshot.revision };
        }
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        snapshot.pools = merged;
        snapshot.revision++;
        validate(snapshot);
        this.commit(snapshot);
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
        const snapshot = this.readForMutation();
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
        this.commit(snapshot);
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
        const snapshot = this.readForMutation();
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
        this.commit(snapshot);
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
        const snapshot = this.readForMutation();
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
        this.commit(snapshot);
        return { admitted: true as const, revision: snapshot.revision, joined: false };
      },
    );
  }
}

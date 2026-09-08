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
type Snapshot = { version: 1; revision: number; reservations: CapacityReservation[] };
const MAX_BYTES = 1_048_576;

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
function validate(value: unknown): asserts value is Snapshot {
  object(value, ["version", "revision", "reservations"]);
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

  /** Caller must durably revoke effects and establish full stop proof first. */
  releaseAfterStop(
    expected: Pick<
      CapacityReservation,
      "environmentId" | "operationId" | "reservationId" | "policyRevision"
    >,
  ): boolean {
    return withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity settlement", waitMs: 100 },
      () => {
        const snapshot = this.read();
        const index = snapshot.reservations.findIndex(
          (entry) => entry.reservationId === expected.reservationId,
        );
        if (index < 0) return false;
        const reservation = snapshot.reservations[index];
        if (
          reservation.environmentId !== expected.environmentId ||
          reservation.operationId !== expected.operationId ||
          reservation.policyRevision !== expected.policyRevision
        )
          throw new Error("Capacity settlement identity changed.");
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        snapshot.reservations.splice(index, 1);
        snapshot.revision++;
        writeFileAtomically(this.file, `${JSON.stringify(snapshot)}\n`);
        return true;
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
    previous?: { revision: number; reservationId: string; operationId: string },
  ) {
    validate({ version: 1, revision: 0, reservations: [request] });
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(this.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error("Capacity reservation directory is not private.");
    return withFileLockSync(
      `${this.file}.lock`,
      { activity: "capacity reservation", waitMs: 100 },
      () => {
        const snapshot = this.read();
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
          const decision = evaluateCapacity(
            budgets,
            samples,
            snapshot.reservations,
            request,
            nowMs,
            maxSampleAgeMs,
          );
          if (!decision.admitted) return decision;
          return { admitted: true as const, revision: snapshot.revision, joined: true };
        }
        const decision = evaluateCapacity(
          budgets,
          samples,
          snapshot.reservations,
          request,
          nowMs,
          maxSampleAgeMs,
        );
        if (!decision.admitted) return decision;
        if (snapshot.revision === Number.MAX_SAFE_INTEGER)
          throw new Error("Capacity reservation revision exhausted.");
        snapshot.revision++;
        if (existing)
          snapshot.reservations[snapshot.reservations.indexOf(existing)] = structuredClone(request);
        else snapshot.reservations.push(structuredClone(request));
        validate(snapshot);
        const contents = `${JSON.stringify(snapshot)}\n`;
        if (Buffer.byteLength(contents) > MAX_BYTES)
          throw new Error("Capacity reservation snapshot exceeds byte limit.");
        writeFileAtomically(this.file, contents);
        return { admitted: true as const, revision: snapshot.revision, joined: false };
      },
    );
  }
}

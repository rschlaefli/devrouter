import type { PreviewWriteGate } from "../engine";
import { object, PreviewStateConflict, type PreviewStateStore, updatePreviewState } from "../state";

const resourceKinds = ["services", "jobs", "addons", "volumes", "secrets", "domains"] as const;

export type NorthflankOwnedResource = {
  reference: string;
  kind: (typeof resourceKinds)[number];
  uid?: string;
  id: string;
  name: string;
};

export type NorthflankOwnership = {
  schemaVersion: 1;
  generation: string;
  policyDigest: string;
  blueprintId?: string;
  previewId?: string;
  resources: NorthflankOwnedResource[];
  absent: boolean;
};

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value))
    throw new Error("Invalid Northflank ownership identifier.");
}

export function decodeNorthflankOwnership(value: unknown): NorthflankOwnership {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 128 * 1024)
    throw new Error("Northflank ownership exceeds its bound.");
  const row = object(
    value,
    ["schemaVersion", "generation", "policyDigest", "resources", "absent"],
    ["blueprintId", "previewId"],
  );
  if (
    row.schemaVersion !== 1 ||
    typeof row.generation !== "string" ||
    !/^[a-f0-9]{24}$/.test(row.generation) ||
    typeof row.policyDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.policyDigest) ||
    typeof row.absent !== "boolean"
  )
    throw new Error("Invalid Northflank ownership identity.");
  for (const key of ["blueprintId", "previewId"]) if (row[key] !== undefined) identifier(row[key]);
  if (!Array.isArray(row.resources) || row.resources.length > 256)
    throw new Error("Invalid Northflank ownership resource list.");
  const references = new Set<string>();
  const ids = new Set<string>();
  for (const raw of row.resources) {
    const resource = object(raw, ["reference", "kind", "id", "name"], ["uid"]);
    identifier(resource.id);
    identifier(resource.reference);
    identifier(resource.name);
    if (
      !resourceKinds.includes(resource.kind as NorthflankOwnedResource["kind"]) ||
      references.has(resource.reference) ||
      ids.has(`${resource.kind}:${resource.id}`)
    )
      throw new Error("Ambiguous Northflank resource ownership.");
    if (
      (resource.kind !== "secrets" && resource.kind !== "domains") ||
      resource.uid !== undefined
    ) {
      if (typeof resource.uid !== "string" || !/^[a-f0-9]{24}$/.test(resource.uid))
        throw new Error("Northflank allocation ownership requires its immutable UID.");
    }
    references.add(resource.reference);
    ids.add(`${resource.kind}:${resource.id}`);
  }
  if (
    row.absent &&
    (row.resources.length || row.blueprintId !== undefined || row.previewId !== undefined)
  )
    throw new Error("Absent Northflank generation still owns resources.");
  return structuredClone(row) as unknown as NorthflankOwnership;
}

/** Private metadata only. Native configuration and runtime secret values never enter this store. */
export class NorthflankOwnershipStore {
  private readonly key: string;
  private readonly initial: NorthflankOwnership;
  constructor(
    private readonly options: {
      store: PreviewStateStore;
      installationId: string;
      generation: string;
      policyDigest: string;
    },
  ) {
    if (!/^[a-z0-9-]{1,63}$/.test(options.installationId))
      throw new Error("Invalid Northflank installation namespace.");
    this.initial = decodeNorthflankOwnership({
      schemaVersion: 1,
      generation: options.generation,
      policyDigest: options.policyDigest,
      resources: [],
      absent: false,
    });
    this.key = `installations/${options.installationId}/northflank/${options.generation}`;
  }
  private validate = (value: unknown): NorthflankOwnership => {
    const owned = decodeNorthflankOwnership(value);
    if (
      owned.generation !== this.initial.generation ||
      owned.policyDigest !== this.initial.policyDigest
    )
      throw new Error("Northflank ownership belongs to another generation or policy.");
    return owned;
  };
  async read(): Promise<NorthflankOwnership | null> {
    return (await this.options.store.read(this.key, this.validate))?.value ?? null;
  }
  async initialize(gate: PreviewWriteGate, established = false): Promise<NorthflankOwnership> {
    const previous = await this.read();
    const steps = await gate.read();
    const intent = steps.find((step) => step.name === "ownership");
    if (previous) {
      if (!intent && !established)
        throw new Error("Northflank ownership has no admitted creation intent.");
      return previous;
    }
    if (intent || established)
      throw new Error("Established Northflank ownership state is missing; recovery is required.");
    if ((await gate.begin("ownership", "once")) !== "write")
      throw new Error("Northflank ownership initialization is fenced.");
    const value = structuredClone(this.initial);
    try {
      await this.options.store.compareAndSwap(this.key, null, value);
    } catch (error) {
      if (!(error instanceof PreviewStateConflict)) throw error;
      const observed = await this.read();
      if (!observed) throw new Error("Northflank ownership initialization outcome is uncertain.");
      return observed;
    }
    await gate.record("ownership", "accepted");
    return value;
  }
  async update(
    change: (value: NorthflankOwnership) => NorthflankOwnership,
  ): Promise<NorthflankOwnership> {
    const record = await updatePreviewState({
      store: this.options.store,
      key: this.key,
      validate: this.validate,
      update: (current) => {
        const next = change(structuredClone(current));
        if (current.absent && !next.absent)
          throw new Error("Northflank ownership cannot revive after verified absence.");
        if (!next.absent) {
          for (const key of ["blueprintId", "previewId"] as const)
            if (current[key] !== undefined && next[key] !== current[key])
              throw new Error(
                "Northflank native container identity cannot change within a generation.",
              );
          for (const resource of current.resources) {
            const observed = next.resources.find((item) => item.reference === resource.reference);
            if (
              !observed ||
              observed.kind !== resource.kind ||
              observed.id !== resource.id ||
              observed.uid !== resource.uid ||
              observed.name !== resource.name
            )
              throw new Error("Northflank resource ownership cannot be dropped or rebound.");
          }
        }
        return next;
      },
    });
    return record.value;
  }
}

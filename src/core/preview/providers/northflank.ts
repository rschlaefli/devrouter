import type { PreviewWriteGate } from "../engine";
import { PreviewStateConflict, type PreviewStateStore, updatePreviewState } from "../state";

export type NorthflankOwnedResource = {
  reference: string;
  kind: "services" | "jobs" | "addons" | "volumes" | "secrets" | "domains";
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

function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Northflank ownership record.");
  const row = value as Record<string, unknown>;
  if (
    keys.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => ![...keys, ...optional].includes(key))
  )
    throw new Error("Invalid Northflank ownership fields.");
  return row;
}
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
    const resource = object(raw, ["reference", "kind", "id", "name"]);
    identifier(resource.id);
    identifier(resource.reference);
    identifier(resource.name);
    if (
      !["services", "jobs", "addons", "volumes", "secrets", "domains"].includes(
        resource.kind as string,
      ) ||
      references.has(resource.reference) ||
      ids.has(`${resource.kind}:${resource.id}`)
    )
      throw new Error("Ambiguous Northflank resource ownership.");
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
    decodeNorthflankOwnership({
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
      owned.generation !== this.options.generation ||
      owned.policyDigest !== this.options.policyDigest
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
    const value = this.validate({
      schemaVersion: 1,
      generation: this.options.generation,
      policyDigest: this.options.policyDigest,
      resources: [],
      absent: false,
    });
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
        if (
          (current.blueprintId && next.blueprintId && current.blueprintId !== next.blueprintId) ||
          (current.previewId && next.previewId && current.previewId !== next.previewId)
        )
          throw new Error(
            "Northflank native container identity cannot change within a generation.",
          );
        return next;
      },
    });
    return record.value;
  }
}

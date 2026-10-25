import { createHash } from "node:crypto";
import type { PreviewEffectReceipt, PreviewProvider, PreviewWriteGate } from "../engine";
import type { PreviewEffect, PreviewPoolEntry } from "../state";
import { object, PreviewStateConflict, type PreviewStateStore, updatePreviewState } from "../state";
import type { PreviewPlanReport } from "../types";
import { NorthflankOutcomeUncertain, type NorthflankPreviewAPI } from "./northflank-api";
import { compileNorthflankGraph, type NorthflankGraphPolicy } from "./northflank-graph";

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

export type NorthflankQualification = {
  fixedDeadline: boolean;
  sameEnvironment: boolean;
  deletionFence: boolean;
  scopedRuntimeSecrets: boolean;
  restrictedIngress: boolean;
};

/** Installation-owned policy. Qualification is false until the producing live trial proves it. */
export class NorthflankPreviewProvider implements PreviewProvider {
  private readonly policyDigest: string;
  constructor(
    private readonly options: {
      api: NorthflankPreviewAPI;
      store: PreviewStateStore;
      installationId: string;
      graph: NorthflankGraphPolicy;
      qualification: NorthflankQualification;
      now: () => number;
      runtimeSecret: (reference: string) => Promise<string>;
      accept: (entry: PreviewPoolEntry, urls: Record<string, string>) => Promise<boolean>;
    },
  ) {
    this.policyDigest = digest({ project: options.api.projectId, graph: options.graph });
    if (options.api.domain !== options.graph.baseDomain)
      throw new Error("Northflank domain scope must match the trusted graph policy.");
  }
  validatePlan(plan: PreviewPlanReport): void {
    if (
      ![
        "fixedDeadline",
        "sameEnvironment",
        "deletionFence",
        "scopedRuntimeSecrets",
        "restrictedIngress",
      ].every((key) => this.options.qualification[key as keyof NorthflankQualification] === true)
    )
      throw new Error(
        "Northflank preview qualification is incomplete; live admission is disabled.",
      );
    const graph = compileNorthflankGraph(
      {
        plan,
        session: { generation: "0".repeat(24), desiredRevision: plan.source?.head },
      } as PreviewPoolEntry,
      this.options.graph,
      "prepare",
    );
    if (graph.runtimeSecrets.length > 16)
      throw new Error("Northflank runtime bindings exceed the journal bound.");
  }
  private ownership(entry: PreviewPoolEntry) {
    return new NorthflankOwnershipStore({
      store: this.options.store,
      installationId: this.options.installationId,
      generation: entry.session.generation,
      policyDigest: this.policyDigest,
    });
  }
  private name(entry: PreviewPoolEntry): string {
    return `dr-${this.options.graph.namespace}-${entry.session.generation}`;
  }
  private receipt(owned: NorthflankOwnership, terminal = false): PreviewEffectReceipt {
    return {
      phase: terminal ? "terminal" : "pending",
      resources: [
        ...(owned.blueprintId ? [`nf-bp-${owned.blueprintId}`] : []),
        ...(owned.previewId ? [`nf-pv-${owned.previewId}`] : []),
      ],
    };
  }
  async submit(effect: PreviewEffect, entry: PreviewPoolEntry, gate: PreviewWriteGate) {
    return this.observe(effect, entry, gate);
  }
  async observe(
    effect: PreviewEffect,
    entry: PreviewPoolEntry,
    gate: PreviewWriteGate,
  ): Promise<PreviewEffectReceipt> {
    const store = this.ownership(entry);
    let owned = await store.initialize(gate, entry.session.ownedResources.length > 0);
    if (owned.absent) return this.receipt(owned, true);
    if (effect.kind === "cancel" || effect.kind === "destroy")
      return this.teardown(effect, entry, gate, owned, store);
    const context = await gate.context();
    if (context.stopping || context.superseded)
      return { ...this.receipt(owned, true), outcome: "cancelled" };
    try {
      if (!owned.blueprintId) {
        const name = this.name(entry);
        const previous = (await gate.read()).find((step) => step.name === "blueprint");
        if (!previous) {
          const matches = (await this.options.api.list(["preview-blueprints"], "workflows")).filter(
            (row) => row.name === name || row.id === name,
          );
          if (matches.length) throw new Error("Northflank generation name is already occupied.");
        }
        if ((await gate.begin("blueprint", "once")) === "write") {
          try {
            owned = await store.update((current) => ({ ...current, blueprintId: name }));
            await this.options.api.request("POST", ["preview-blueprints"], {
              name,
              apiVersion: "v1.2",
              spec: emptySpec,
              triggers: [],
              options: this.blueprintOptions(entry, effect.target ?? entry.session.expiresAt),
            });
            await gate.record("blueprint", "accepted");
          } catch (error) {
            if (!(error instanceof NorthflankOutcomeUncertain)) throw error;
            await gate.record("blueprint", "uncertain");
          }
        }
        const matches = (await this.options.api.list(["preview-blueprints"], "workflows")).filter(
          (row) => row.name === name || row.id === name,
        );
        if (matches.length > 1) throw new Error("Ambiguous Northflank blueprint outcome.");
        if (!matches.length) return this.receipt(owned);
        if (matches[0].id !== name)
          throw new Error("Northflank blueprint slug differs from its admitted identity.");
        const blueprintId = nativeIdentifier(matches[0].id);
        owned = await store.update((current) => ({ ...current, blueprintId }));
      }
      if (effect.kind === "deadline") {
        if (!owned.previewId) {
          const run = await this.run(entry, effect, gate, owned, "bootstrap", emptySpec);
          if (!run) return this.receipt(owned);
          if (!run.concluded) return this.receipt(owned);
          if (run.status !== "success") throw new Error("Northflank bootstrap failed.");
          const previews = await this.options.api.list(
            ["preview-blueprints", nativeIdentifier(owned.blueprintId), "previews"],
            "previewEnvironments",
          );
          if (previews.length !== 1)
            throw new Error("Northflank requires exactly one generation environment.");
          const previewId = nativeIdentifier(previews[0].id);
          owned = await store.update((current) => ({ ...current, previewId }));
        }
        const step = (await gate.read()).find((item) => item.name === "deadline");
        if (step?.state === "accepted" && step.ref)
          return { ...this.receipt(owned, true), confirmedDeadline: Number(step.ref) };
        if (step) throw new Error("Northflank expiry confirmation was lost.");
        if ((await gate.begin("deadline", "once")) !== "write")
          return { ...this.receipt(owned, true), outcome: "cancelled" };
        const confirmed = await this.options.api.resetDeadline(
          nativeIdentifier(owned.blueprintId),
          nativeIdentifier(owned.previewId),
          effect.target ?? entry.session.expiresAt,
          this.options.now(),
        );
        await gate.record("deadline", "accepted", String(confirmed));
        return { ...this.receipt(owned, true), confirmedDeadline: confirmed };
      }
      if (!owned.previewId) throw new Error("Northflank deadline must precede paid allocations.");
      const selected = new Set(
        entry.plan.resources.map((item) => `r_${item.id.replaceAll("-", "_")}`),
      );
      for (const resource of owned.resources.filter(
        (item) =>
          item.kind === "services" &&
          item.reference.startsWith("r_") &&
          !selected.has(item.reference),
      )) {
        const step = `pause-${digest(resource.id).slice(0, 12)}`;
        if ((await gate.begin(step, "once")) === "write") {
          await this.options.api.request("PATCH", ["services", resource.id], {
            deployment: { instances: 0 },
          });
          await gate.record(step, "accepted");
        } else if (
          !(await gate.read()).some((item) => item.name === step && item.state === "accepted")
        )
          throw new Error("Northflank deselection is uncertain.");
      }
      const prepared = compileNorthflankGraph(
        entry,
        this.options.graph,
        "prepare",
        bindings(owned),
      );
      const prepare = await this.run(entry, effect, gate, owned, "prepare", prepared.spec);
      if (!prepare?.concluded) return this.receipt(owned);
      owned = await this.capture(prepare, owned, store);
      if (prepare.status !== "success") throw new Error("Northflank preparation failed.");
      for (const [index, group] of prepared.runtimeSecrets.entries()) {
        const step = `secrets-${index}`;
        const current = (await gate.read()).find((item) => item.name === step);
        if (current?.state === "accepted") continue;
        if (current) throw new Error("Northflank secret delivery outcome is uncertain.");
        const target = owned.resources.find((resource) => resource.reference === group.groupRef);
        if (target?.kind !== "secrets") throw new Error("Northflank runtime recipient is unowned.");
        const definition = prepared.spec.spec.steps.find((node) => node.ref === group.groupRef);
        const configured = data({ data: data({ data: definition?.spec.secrets }).variables });
        const variables: Record<string, unknown> = { ...configured };
        for (const [key, reference] of Object.entries(group.variables)) {
          const value = await this.options.runtimeSecret(reference);
          if (!value) throw new Error("Northflank runtime secret is unavailable.");
          variables[key] = value;
        }
        if ((await gate.begin(step, "once")) !== "write")
          return { ...this.receipt(owned, true), outcome: "cancelled" };
        await this.options.api.request("PATCH", ["secrets", target.id], { secrets: { variables } });
        await gate.record(step, "accepted");
      }
      const active = compileNorthflankGraph(entry, this.options.graph, "activate", bindings(owned));
      const run = await this.run(entry, effect, gate, owned, "activate", active.spec);
      if (!run?.concluded) return this.receipt(owned);
      owned = await this.capture(run, owned, store);
      if (run.status !== "success") throw new Error("Northflank activation failed.");
      if (!(await this.options.accept(entry, active.urls))) return this.receipt(owned);
      return { ...this.receipt(owned, true), ready: true };
    } catch (error) {
      // Native details and injected values never become controller errors or status text.
      if (!(error instanceof Error)) throw error;
      return {
        ...this.receipt((await store.read()) ?? owned, true),
        outcome: "failed",
        cleanupRequired: true,
      };
    }
  }
  private blueprintOptions(entry: PreviewPoolEntry, target: number) {
    return {
      autorun: false,
      useBranchContents: false,
      concurrencyPolicy: "forbid",
      nameFormat: this.name(entry),
      prefixName: false,
      expiry: {
        previewLifetime: this.options.api.deadlineLifetime(target, this.options.now()),
        resetOnUpdate: false,
      },
    };
  }
  private async run(
    entry: PreviewPoolEntry,
    effect: PreviewEffect,
    gate: PreviewWriteGate,
    owned: NorthflankOwnership,
    stage: string,
    spec: unknown,
  ): Promise<Record<string, unknown> | null> {
    const api = this.options.api;
    const path = ["preview-blueprints", nativeIdentifier(owned.blueprintId)];
    let fingerprint = digest(spec);
    const runName = `${stage}-${digest(effect.id).slice(0, 20)}`;
    const recorded = (await gate.read()).find((step) => step.name === `${stage}-run`);
    if (!recorded) {
      if ((await gate.begin(`${stage}-spec`, "once", fingerprint)) === "write") {
        await api.request("POST", path, {
          name: this.name(entry),
          apiVersion: "v1.2",
          spec,
          triggers: [],
          options: this.blueprintOptions(entry, entry.session.expiresAt),
        });
        await gate.record(`${stage}-spec`, "accepted");
      }
      const detail = data(await api.request("GET", path));
      if (digest(detail.spec) !== fingerprint)
        throw new Error("Northflank blueprint specification drifted.");
      if ((await gate.begin(`${stage}-run`, "once", fingerprint)) === "write") {
        try {
          const run = data(await api.request("POST", [...path, "runs"], { name: runName }));
          if (owned.previewId && run.environmentId !== owned.previewId)
            throw new Error("Northflank run created another environment.");
          await gate.record(`${stage}-run`, "accepted", nativeIdentifier(run.id));
        } catch (error) {
          if (!(error instanceof NorthflankOutcomeUncertain)) throw error;
          await gate.record(`${stage}-run`, "uncertain");
        }
      }
    } else {
      if (!recorded.fingerprint) throw new Error("Northflank run has no admitted specification.");
      fingerprint = recorded.fingerprint;
    }
    const step = (await gate.read()).find((item) => item.name === `${stage}-run`);
    if (!step) return null;
    let id = step.ref;
    if (!id) {
      const matches = (await api.list([...path, "runs"], "runs")).filter(
        (row) => row.name === runName,
      );
      if (matches.length > 1) throw new Error("Ambiguous Northflank run outcome.");
      if (!matches.length) return null;
      id = nativeIdentifier(matches[0].id);
      await gate.record(`${stage}-run`, "accepted", id);
    }
    const run = data(await api.request("GET", [...path, "runs", id]));
    if (digest(run.spec) !== fingerprint)
      throw new Error("Northflank executed an unexpected specification.");
    return run;
  }
  private async capture(
    run: Record<string, unknown>,
    owned: NorthflankOwnership,
    store: NorthflankOwnershipStore,
  ) {
    const refs = data({ data: run.refs });
    const steps = data({ data: data({ data: run.spec }).spec }).steps;
    if (!Array.isArray(steps)) throw new Error("Northflank executed graph is unavailable.");
    const additions: NorthflankOwnedResource[] = [];
    const kinds: Record<string, NorthflankOwnedResource["kind"]> = {
      Addon: "addons",
      BuildService: "services",
      DeploymentService: "services",
      Job: "jobs",
      Volume: "volumes",
      SecretGroup: "secrets",
      Subdomain: "domains",
    };
    for (const raw of steps) {
      const node = data({ data: raw });
      if (typeof node.ref !== "string" || typeof node.kind !== "string" || !kinds[node.kind])
        continue;
      if (!/^(r|b|e|d)_/.test(node.ref)) continue;
      const previous = owned.resources.find((item) => item.reference === node.ref);
      if (previous) continue;
      const output = refs[node.ref];
      if (!output) continue;
      const kind = kinds[node.kind];
      if (kind === "domains") {
        const spec = data({ data: node.spec });
        const id = nativeIdentifier(spec.name);
        const observed = data(await this.options.api.subdomain("GET", id));
        if (observed.fullName !== `${id}.${this.options.graph.baseDomain}`)
          throw new Error("Northflank domain identity differs.");
        additions.push({ reference: node.ref, kind, id, name: observed.fullName as string });
        continue;
      }
      const id = nativeIdentifier(data({ data: output }).id);
      const observed = data(await this.options.api.request("GET", [kind, id]));
      const name = nativeIdentifier(observed.name);
      if (name !== data({ data: node.spec }).name)
        throw new Error("Northflank allocation identity differs from its executed graph.");
      additions.push({
        reference: node.ref,
        kind,
        id,
        name,
        ...(observed.uid ? { uid: nativeIdentifier(observed.uid) } : {}),
      });
    }
    return store.update((current) => ({
      ...current,
      resources: [...current.resources, ...additions],
    }));
  }
  private async teardown(
    effect: PreviewEffect,
    entry: PreviewPoolEntry,
    gate: PreviewWriteGate,
    owned: NorthflankOwnership,
    store: NorthflankOwnershipStore,
  ): Promise<PreviewEffectReceipt> {
    if (!owned.blueprintId) {
      const candidates = (await this.options.api.list(["preview-blueprints"], "workflows")).filter(
        (row) => row.name === this.name(entry) || row.id === this.name(entry),
      );
      // An uncertain create is never forgotten or adopted by name alone.
      if (candidates.length) return this.receipt(owned);
      return this.receipt(owned, true);
    }
    const path = ["preview-blueprints", owned.blueprintId];
    const blueprint = await this.options.api.request("GET", path);
    if (blueprint) {
      const runs = await this.options.api.list([...path, "runs"], "runs");
      for (const run of runs.filter((row) => row.concluded !== true)) {
        const id = nativeIdentifier(run.id);
        if ((await gate.begin(`abort-${digest(id).slice(0, 12)}`, "convergent")) === "write") {
          await this.options.api.request("POST", [...path, "runs", id, "abort"]);
          await gate.record(`abort-${digest(id).slice(0, 12)}`, "accepted", id);
        }
      }
      if (effect.kind === "cancel") return this.receipt(owned, true);
      const previews = await this.options.api.list([...path, "previews"], "previewEnvironments");
      for (const preview of previews) {
        const id = nativeIdentifier(preview.id);
        const step = `delete-${digest(id).slice(0, 12)}`;
        if ((await gate.begin(step, "convergent")) === "write") {
          await this.options.api.request("DELETE", [...path, "previews", id]);
          await gate.record(step, "accepted", id);
        }
      }
      if ((await this.options.api.list([...path, "previews"], "previewEnvironments")).length)
        return this.receipt(owned);
      for (const resource of owned.resources.filter((item) => item.kind === "domains")) {
        if (!(await this.options.api.subdomain("GET", resource.id))) continue;
        const step = `domain-${digest(resource.id).slice(0, 12)}`;
        if ((await gate.begin(step, "convergent")) === "write") {
          await this.options.api.subdomain("DELETE", resource.id);
          await gate.record(step, "accepted");
        }
      }
      if ((await gate.begin("delete-blueprint", "convergent")) === "write") {
        await this.options.api.request("DELETE", path);
        await gate.record("delete-blueprint", "accepted");
      }
    }
    if (!(await this.absent(entry))) return this.receipt(owned);
    await store.update((current) => ({
      ...current,
      blueprintId: undefined,
      previewId: undefined,
      resources: [],
      absent: true,
    }));
    return this.receipt(owned, true);
  }
  async absent(entry: PreviewPoolEntry): Promise<boolean> {
    const owned = await this.ownership(entry).read();
    if (!owned)
      return (
        entry.session.ownedResources.length === 0 && Object.keys(entry.operations).length === 0
      );
    if (owned.absent) return true;
    const api = this.options.api;
    if (owned.blueprintId && (await api.request("GET", ["preview-blueprints", owned.blueprintId])))
      return false;
    if (
      (await api.list(["preview-blueprints"], "workflows")).some(
        (row) => row.name === this.name(entry) || row.id === this.name(entry),
      )
    )
      return false;
    const prefix = `${this.options.graph.namespace.slice(0, 6)}-${entry.session.generation.slice(0, 12)}-`;
    for (const kind of ["services", "jobs", "addons", "volumes", "secrets"] as const) {
      const rows = await api.list([kind], kind === "volumes" ? undefined : kind);
      if (rows.some((row) => typeof row.name === "string" && row.name.startsWith(prefix)))
        return false;
      for (const resource of owned.resources.filter((item) => item.kind === kind))
        if (
          rows.some((row) => row.id === resource.id && (!resource.uid || row.uid === resource.uid))
        )
          return false;
    }
    const graph = compileNorthflankGraph(entry, this.options.graph, "prepare", bindings(owned));
    const domains = new Set([
      ...owned.resources.filter((item) => item.kind === "domains").map((item) => item.id),
      ...Object.values(graph.urls).map((url) =>
        new URL(url).hostname.slice(0, -(this.options.graph.baseDomain.length + 1)),
      ),
    ]);
    for (const label of domains) {
      if (await api.subdomain("GET", label)) return false;
    }
    return true;
  }
}

const emptySpec = { kind: "Workflow", spec: { type: "sequential", steps: [] } };
function nativeIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value))
    throw new Error("Invalid Northflank native identity.");
  return value;
}
function data(value: Record<string, unknown> | null): Record<string, unknown> {
  if (!value?.data || typeof value.data !== "object" || Array.isArray(value.data))
    throw new Error("Invalid Northflank native observation.");
  return value.data as Record<string, unknown>;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function bindings(owned: NorthflankOwnership) {
  return {
    resources: Object.fromEntries(owned.resources.map((item) => [item.reference, item.id])),
    domains: owned.resources.filter((item) => item.kind === "domains").map((item) => item.name),
  };
}

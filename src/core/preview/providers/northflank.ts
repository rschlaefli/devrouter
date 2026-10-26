import { createHash, randomBytes } from "node:crypto";
import { PreviewAdmissionRefused } from "../command";
import type { PreviewEffectReceipt, PreviewProvider, PreviewWriteGate } from "../engine";
import type { PreviewEffect, PreviewPoolEntry } from "../state";
import { object, PreviewStateConflict, type PreviewStateStore, updatePreviewState } from "../state";
import type { PreviewPlanReport } from "../types";
import {
  NorthflankOutcomeUncertain,
  type NorthflankPreviewAPI,
  NorthflankRejected,
  northflankIdentifier as nativeIdentifier,
  northflankRecord as record,
} from "./northflank-api";
import {
  compileNorthflankGraph,
  type NorthflankGraphPolicy,
  northflankAllocationPrefix,
} from "./northflank-graph";

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
  blueprintObserved?: boolean;
  blueprintRejected?: boolean;
  previewId?: string;
  resources: NorthflankOwnedResource[];
  delivered?: string[];
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
    ["blueprintId", "previewId", "blueprintObserved", "blueprintRejected", "delivered"],
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
  if (row.blueprintRejected !== undefined && typeof row.blueprintRejected !== "boolean")
    throw new Error("Invalid Northflank rejection observation.");
  if (row.blueprintObserved !== undefined && typeof row.blueprintObserved !== "boolean")
    throw new Error("Invalid Northflank creation observation.");
  for (const key of ["blueprintId", "previewId"]) if (row[key] !== undefined) identifier(row[key]);
  if (
    row.delivered !== undefined &&
    (!Array.isArray(row.delivered) ||
      row.delivered.length > 128 ||
      row.delivered.some(
        (name, index, names) =>
          typeof name !== "string" ||
          !/^[go]:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
          name.length > 50 ||
          (index > 0 && names[index - 1] >= name),
      ))
  )
    throw new Error("Invalid Northflank delivered-name metadata.");
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
    (row.resources.length ||
      row.delivered?.length ||
      row.blueprintId !== undefined ||
      row.previewId !== undefined)
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
          if (current.delivered?.some((name) => !next.delivered?.includes(name)))
            throw new Error("Northflank delivered names cannot be forgotten.");
          if (current.blueprintObserved && !next.blueprintObserved)
            throw new Error("Northflank creation observation cannot be forgotten.");
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

export const northflankQualificationKeys = [
  "fixedDeadline",
  "sameEnvironment",
  "deletionFence",
  "scopedRuntimeSecrets",
  "restrictedIngress",
] as const;
export type NorthflankQualification = Record<
  (typeof northflankQualificationKeys)[number],
  boolean
> & { outputExec?: boolean };
class NorthflankFailure extends Error {}
class NorthflankFenced extends Error {
  constructor(readonly noWriteStep?: string) {
    super("Northflank operation was fenced.");
  }
}

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
      throw new NorthflankFailure("Northflank domain scope must match the trusted graph policy.");
  }
  validatePlan(plan: PreviewPlanReport): void {
    if (!northflankQualificationKeys.every((key) => this.options.qualification[key] === true))
      throw new PreviewAdmissionRefused(
        "provider-unqualified",
        "Northflank preview qualification is incomplete; live admission is disabled.",
      );
    let graph: ReturnType<typeof compileNorthflankGraph>;
    try {
      graph = compileNorthflankGraph(
        {
          plan,
          session: { generation: "0".repeat(24), desiredRevision: plan.source?.head },
        } as PreviewPoolEntry,
        this.options.graph,
        "prepare",
      );
    } catch {
      throw new PreviewAdmissionRefused(
        "provider-unsupported",
        "Northflank preview plan is unsupported by installed policy.",
      );
    }
    if (outputNames(graph).length > 0 && this.options.qualification.outputExec !== true)
      throw new PreviewAdmissionRefused(
        "provider-unqualified",
        "Northflank output command qualification is incomplete.",
      );
    if (
      graph.spec.spec.steps.filter((node) => resourceKinds.includes(nativeKinds[node.kind]))
        .length > 200
    )
      throw new PreviewAdmissionRefused(
        "provider-unsupported",
        "Northflank planned allocations exceed their ownership bound.",
      );
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
  private async namedBlueprints(entry: PreviewPoolEntry) {
    const name = this.name(entry);
    return (await this.options.api.list(["preview-blueprints"], "workflows")).filter(
      (row) => row.name === name || row.id === name,
    );
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
    const previousOwnership = await store.read();
    if (!["deadline", "cancel", "destroy"].includes(effect.kind)) {
      const graph = compileNorthflankGraph(
        entry,
        this.options.graph,
        "prepare",
        previousOwnership ? bindings(previousOwnership) : undefined,
      );
      const selected = new Set(
        entry.plan.resources.map((resource) => `r_${resource.id.replaceAll("-", "_")}`),
      );
      const deselected =
        previousOwnership?.resources.filter(
          (resource) =>
            resource.kind === "services" &&
            resource.reference.startsWith("r_") &&
            !selected.has(resource.reference),
        ).length ?? 0;
      const outputs = outputNames(graph);
      if (8 + graph.secretBindings.length * 2 + outputs.length + deselected > 144)
        return {
          ...(previousOwnership
            ? this.receipt(previousOwnership, true)
            : { phase: "terminal" as const, resources: [] }),
          outcome: "failed",
          cleanupRequired: true,
        };
    }
    let owned = await store.initialize(
      gate,
      entry.session.ownedResources.length > 0 ||
        Object.values(entry.operations).some((operation) =>
          operation.steps?.some((step) => step.name === "ownership"),
        ),
    );
    if (owned.absent) return this.receipt(owned, true);
    if (effect.kind === "cancel" || effect.kind === "destroy")
      return this.teardown(effect, entry, gate, owned, store);
    if (await gate.fenced()) return this.settleFenced(effect, entry, gate, owned, store);
    try {
      if (!owned.blueprintId) {
        const name = this.name(entry);
        const previous = (await gate.read()).find((step) => step.name === "blueprint");
        if (!previous) {
          const matches = await this.namedBlueprints(entry);
          if (matches.length)
            throw new NorthflankFailure("Northflank generation name is already occupied.");
        }
        const body = {
          name,
          apiVersion: "v1.2",
          spec: emptySpec,
          triggers: [],
          options: this.blueprintOptions(entry, effect.target ?? entry.session.expiresAt),
        };
        if ((await begin(gate, "blueprint", "once")) === "write") {
          try {
            owned = await store.update((current) => ({ ...current, blueprintId: name }));
            await this.options.api.request("POST", ["preview-blueprints"], body);
            await gate.record("blueprint", "accepted");
          } catch (error) {
            if (error instanceof NorthflankRejected) {
              owned = await store.update((current) => ({ ...current, blueprintRejected: true }));
              throw new NorthflankFailure("Northflank rejected generation creation.");
            }
            if (!(error instanceof NorthflankOutcomeUncertain)) throw error;
            await gate.record("blueprint", "uncertain");
          }
        }
        const matches = await this.namedBlueprints(entry);
        if (matches.length > 1)
          throw new NorthflankFailure("Ambiguous Northflank blueprint outcome.");
        if (!matches.length) return this.receipt(owned);
        if (matches[0].id !== name)
          throw new NorthflankFailure(
            "Northflank blueprint slug differs from its admitted identity.",
          );
        const blueprintId = nativeIdentifier(matches[0].id);
        owned = await store.update((current) => ({
          ...current,
          blueprintId,
          blueprintObserved: true,
        }));
        await gate.record("blueprint", "accepted");
      }
      if (effect.kind === "deadline") {
        if (!owned.previewId) {
          const run = await this.run(entry, effect, gate, owned, "bootstrap", emptySpec);
          if (!run?.concluded) return this.receipt(owned);
          if (run.status !== "success") throw new NorthflankFailure("Northflank bootstrap failed.");
          const previews = await this.options.api.list(
            ["preview-blueprints", nativeIdentifier(owned.blueprintId), "previews"],
            "previewEnvironments",
          );
          if (previews.length !== 1)
            throw new NorthflankFailure("Northflank requires exactly one generation environment.");
          const previewId = nativeIdentifier(previews[0].id);
          owned = await store.update((current) => ({ ...current, previewId }));
        }
        const step = (await gate.read()).find((item) => item.name === "deadline");
        if (step?.state === "accepted" && step.ref)
          return { ...this.receipt(owned, true), confirmedDeadline: Number(step.ref) };
        if (step) throw new NorthflankFailure("Northflank expiry confirmation was lost.");
        if ((await begin(gate, "deadline", "once")) !== "write")
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
      if (!owned.previewId)
        throw new NorthflankFailure("Northflank deadline must precede paid allocations.");
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
        if ((await begin(gate, step, "once")) === "write") {
          await this.options.api.request("POST", ["services", resource.id, "pause"]);
          await gate.record(step, "accepted");
        } else if (
          !(await gate.read()).some((item) => item.name === step && item.state === "accepted")
        )
          throw new NorthflankFailure("Northflank deselection is uncertain.");
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
      if (!["success", "skipped"].includes(String(prepare.status)))
        throw new NorthflankFailure("Northflank preparation failed.");
      const configured = compileNorthflankGraph(
        entry,
        this.options.graph,
        "prepare",
        bindings(owned),
      );
      owned = await this.deliver(gate, owned, store, configured, "pre");
      const outputs = outputNames(configured);
      if (outputs.length) {
        if (this.options.qualification.outputExec !== true)
          throw new NorthflankFailure("Northflank output command qualification is incomplete.");
        const source = compileNorthflankGraph(entry, this.options.graph, "source", bindings(owned));
        const started = await this.run(entry, effect, gate, owned, "source", source.spec);
        if (!started?.concluded) return this.receipt(owned);
        owned = await this.capture(started, owned, store);
        if (!["success", "skipped"].includes(String(started.status)))
          throw new NorthflankFailure("Northflank source startup failed.");
        for (const name of outputs) {
          const step = `secrets-output-${digest(name).slice(0, 20)}`;
          const previous = (await gate.read()).find((item) => item.name === step);
          if (previous?.state === "accepted") continue;
          if (previous) throw new NorthflankFailure("Northflank output delivery is uncertain.");
          const peers = await this.secretPeers(owned);
          const output = this.options.graph.outputs?.[name];
          if (!output) throw new NorthflankFailure("Northflank output is undeclared.");
          const target = owned.resources.find(
            (resource) => resource.reference === `r_${output.service.replaceAll("-", "_")}`,
          );
          if (target?.kind !== "services" || !source.sourceResources.includes(output.service))
            throw new NorthflankFailure("Northflank output source is unowned.");
          const observed = data(await this.options.api.request("GET", ["services", target.id]));
          const recipe = entry.plan.resources.find((resource) => resource.id === output.service);
          if (!recipe) throw new NorthflankFailure("Northflank output recipe is unselected.");
          const deployment = record(observed.deployment);
          if (
            observed.uid !== target.uid ||
            observed.name !== target.name ||
            (recipe.build
              ? record(deployment.internal).buildSHA !== entry.session.desiredRevision
              : record(deployment.external).imagePath !== recipe.image)
          )
            throw new NorthflankFailure("Northflank output source revision differs.");
          const recipient = configured.secretBindings.find((group) =>
            Object.values(group.variables).some(
              (binding) => "output" in binding && binding.output === name,
            ),
          );
          if (!recipient) throw new NorthflankFailure("Northflank output recipient is missing.");
          if (
            (await begin(
              gate,
              step,
              "convergent",
              digest({ output: name, group: recipient.groupRef }),
            )) !== "write"
          )
            throw new NorthflankFenced();
          let value: string;
          try {
            value = await this.options.api.execServiceCommand(target.id, output.command, {
              maxBytes: output.maxBytes + 1,
              timeoutMs: 10_000,
            });
          } catch {
            throw new NorthflankFailure("Northflank output command failed.");
          }
          if (await gate.fenced()) throw new NorthflankFenced(step);
          if (value.endsWith("\n")) value = value.slice(0, -1);
          if (Buffer.byteLength(value) > output.maxBytes || !new RegExp(output.pattern).test(value))
            throw new NorthflankFailure("Northflank output command returned an invalid value.");
          const previousValue = this.peerValue(peers, "output", name, owned);
          if (previousValue !== undefined && previousValue !== value)
            throw new NorthflankFailure("Northflank output differs from persisted recipients.");
          const peer = peers.find((peer) => peer.resource.reference === recipient.groupRef);
          if (!peer) throw new NorthflankFailure("Northflank output recipient is unowned.");
          const variables = { ...peer.variables };
          for (const [key, binding] of Object.entries(recipient.variables))
            if ("output" in binding && binding.output === name) variables[key] = value;
          await this.patchSecrets(gate, step, peer, variables, true);
          return this.receipt(owned);
        }
        owned = await this.deliver(gate, owned, store, configured, "post");
      }
      const active = compileNorthflankGraph(entry, this.options.graph, "activate", bindings(owned));
      const run = await this.run(entry, effect, gate, owned, "activate", active.spec);
      if (!run?.concluded) return this.receipt(owned);
      owned = await this.capture(run, owned, store);
      if (!["success", "skipped"].includes(String(run.status)))
        throw new NorthflankFailure("Northflank activation failed.");
      await this.verifySecrets(owned, active);
      if (!(await this.options.accept(entry, active.urls))) return this.receipt(owned);
      return { ...this.receipt(owned, true), ready: true };
    } catch (error) {
      // Native details and injected values never become controller errors or status text.
      if (error instanceof NorthflankFenced) {
        if (error.noWriteStep)
          await gate.record(error.noWriteStep, "accepted", "cancelled-before-write");
        return this.settleFenced(effect, entry, gate, owned, store);
      }
      if (
        !(error instanceof NorthflankFailure) &&
        !(error instanceof NorthflankOutcomeUncertain) &&
        !(error instanceof NorthflankRejected)
      )
        throw error;
      return {
        ...this.receipt((await store.read()) ?? owned, true),
        outcome: "failed",
        cleanupRequired: !(
          effect.kind === "deadline" && entry.session.pendingDeadline !== undefined
        ),
      };
    }
  }
  private async secretPeers(owned: NorthflankOwnership) {
    const peers: Array<{
      resource: NorthflankOwnedResource;
      variables: Record<string, string>;
      details: Record<string, unknown>;
      environment: NonNullable<NorthflankGraphPolicy["resources"][string]["environment"]>;
    }> = [];
    for (const resource of owned.resources.filter(
      (item) => item.kind === "secrets" && item.reference.startsWith("e_"),
    )) {
      const policy = Object.entries(this.options.graph.resources).find(
        ([id]) => `e_${id.replaceAll("-", "_")}` === resource.reference,
      );
      const target = owned.resources.find(
        (item) => item.reference === resource.reference.replace(/^e_/, "r_"),
      );
      if (!policy || !target || !["services", "jobs"].includes(target.kind))
        throw new NorthflankFailure("Northflank secret recipient is unowned.");
      const details = data(
        await this.options.api.request("GET", ["secrets", resource.id, "details"]),
      );
      const restrictions = record(details.restrictions);
      const objects = restrictions.nfObjects;
      if (
        details.name !== resource.name ||
        (resource.uid !== undefined && details.uid !== resource.uid) ||
        details.secretType !== "environment" ||
        details.priority !== 10 ||
        restrictions.restricted !== true ||
        Object.keys(restrictions).some(
          (key) =>
            !["restricted", "nfObjects", "tags", "tagMatchCondition", "stageIds"].includes(key),
        ) ||
        (restrictions.tagMatchCondition !== undefined &&
          (typeof restrictions.tagMatchCondition !== "string" ||
            !["and", "or"].includes(restrictions.tagMatchCondition))) ||
        !Array.isArray(objects) ||
        objects.length !== 1 ||
        record(objects[0]).id !== target.id ||
        record(objects[0]).type !== (target.kind === "services" ? "service" : "job") ||
        (restrictions.tags !== undefined &&
          (!Array.isArray(restrictions.tags) || restrictions.tags.length > 0)) ||
        (restrictions.stageIds !== undefined &&
          (!Array.isArray(restrictions.stageIds) || restrictions.stageIds.length > 0))
      )
        throw new NorthflankFailure("Northflank secret recipient restrictions differ.");
      const variables = record(record(details.secrets).variables) as Record<string, string>;
      const configured = policy[1].environment ?? {};
      if (
        Object.entries(variables).some(
          ([key, value]) =>
            typeof value !== "string" ||
            !Object.hasOwn(configured, key) ||
            "addon" in configured[key],
        )
      )
        throw new NorthflankFailure("Northflank secret group contains undeclared variables.");
      peers.push({ resource, variables, details, environment: configured });
    }
    return peers;
  }
  private peerValue(
    peers: Awaited<ReturnType<NorthflankPreviewProvider["secretPeers"]>>,
    kind: "generated" | "output",
    name: string,
    owned: NorthflankOwnership,
  ): string | undefined {
    const values = new Set<string>();
    for (const peer of peers) {
      for (const [key, binding] of Object.entries(peer.environment))
        if (
          (kind === "generated" && "generated" in binding && binding.generated === name) ||
          (kind === "output" && "output" in binding && binding.output === name)
        ) {
          const value = peer.variables[key];
          if (value !== undefined) {
            const generated = this.options.graph.generated?.[name];
            const output = this.options.graph.outputs?.[name];
            if (
              !value ||
              Buffer.byteLength(value) > 8192 ||
              (kind === "generated" &&
                (!generated ||
                  (generated.encoding === "hex"
                    ? !new RegExp(`^[a-f0-9]{${generated.bytes * 2}}$`).test(value)
                    : !/^[A-Za-z0-9_-]+$/.test(value) ||
                      Buffer.from(value, "base64url").length !== generated.bytes))) ||
              (kind === "output" &&
                (!output ||
                  Buffer.byteLength(value) > output.maxBytes ||
                  !new RegExp(output.pattern).test(value)))
            )
              throw new NorthflankFailure("Northflank persisted value is invalid.");
            values.add(value);
          }
        }
    }
    if (
      values.size > 1 ||
      (!values.size && owned.delivered?.includes(`${kind === "generated" ? "g" : "o"}:${name}`))
    )
      throw new NorthflankFailure("Northflank delivered value is missing or disagrees.");
    return values.values().next().value;
  }
  private async patchSecrets(
    gate: PreviewWriteGate,
    step: string,
    peer: Awaited<ReturnType<NorthflankPreviewProvider["secretPeers"]>>[number],
    variables: Record<string, string>,
    started = false,
    preservedOutputKeys: string[] = [],
  ) {
    const previous = (await gate.read()).find((item) => item.name === step);
    if (previous && previous.state !== "accepted" && !started)
      throw new NorthflankFailure("Northflank secret delivery outcome is uncertain.");
    const equal = (actual: Record<string, unknown>) =>
      Object.keys(actual).length === Object.keys(variables).length &&
      Object.entries(variables).every(([key, value]) => actual[key] === value);
    if (previous?.state === "accepted") {
      const expectedKeys = Object.keys(variables).filter(
        (key) => !preservedOutputKeys.includes(key),
      );
      const actualKeys = Object.keys(peer.variables).filter(
        (key) => !preservedOutputKeys.includes(key),
      );
      if (
        expectedKeys.length !== actualKeys.length ||
        expectedKeys.some((key) => peer.variables[key] !== variables[key])
      )
        throw new NorthflankFailure("Northflank accepted secret delivery was lost.");
      return;
    }
    if (
      !started &&
      (await begin(
        gate,
        step,
        "once",
        digest({ group: peer.resource.reference, keys: Object.keys(variables).sort() }),
      )) !== "write"
    )
      throw new NorthflankFenced();
    if (started && (await gate.begin(step, "convergent", previous?.fingerprint)) === "fenced")
      throw new NorthflankFenced(step);
    if (!equal(peer.variables)) {
      try {
        await this.options.api.request("PATCH", ["secrets", peer.resource.id], {
          secrets: { variables },
        });
      } catch {
        await gate.record(step, "uncertain");
        throw new NorthflankFailure("Northflank secret write is uncertain.");
      }
    }
    const observed = data(
      await this.options.api.request("GET", ["secrets", peer.resource.id, "details"]),
    );
    if (
      !equal(record(record(observed.secrets).variables)) ||
      JSON.stringify(observed.restrictions) !== JSON.stringify(peer.details.restrictions) ||
      observed.priority !== peer.details.priority ||
      observed.secretType !== peer.details.secretType ||
      JSON.stringify(record(observed.secrets).files) !==
        JSON.stringify(record(peer.details.secrets).files) ||
      addonIds(observed) !== addonIds(peer.details)
    )
      throw new NorthflankFailure("Northflank secret delivery readback differs.");
    await gate.record(step, "accepted");
  }
  private async verifyAddonBindings(
    peer: Awaited<ReturnType<NorthflankPreviewProvider["secretPeers"]>>[number],
    graph: ReturnType<typeof compileNorthflankGraph>,
  ) {
    const definition = graph.spec.spec.steps.find((node) => node.ref === peer.resource.reference);
    if (!definition) throw new NorthflankFailure("Northflank group definition is missing.");
    const expected = definition.spec.addonDependencies as Array<{
      addonId: string;
      keys: Array<{ keyName: string; aliases: string[] }>;
    }>;
    if (
      !Array.isArray(expected) ||
      addonIds(peer.details) !== JSON.stringify(expected.map((addon) => addon.addonId).sort())
    )
      throw new NorthflankFailure("Northflank addon bindings differ from reviewed policy.");
    const keys = (items: unknown) => {
      if (!Array.isArray(items))
        throw new NorthflankFailure("Northflank addon keys are unavailable.");
      return JSON.stringify(
        items
          .map((item) => {
            const key = record(item);
            if (
              typeof key.keyName !== "string" ||
              !Array.isArray(key.aliases) ||
              key.aliases.some((alias) => typeof alias !== "string")
            )
              throw new NorthflankFailure("Northflank addon keys are invalid.");
            return JSON.stringify([key.keyName, [...key.aliases].sort()]);
          })
          .sort(),
      );
    };
    for (const addon of expected) {
      const link = data(
        await this.options.api.request("GET", [
          "secrets",
          peer.resource.id,
          "addons",
          nativeIdentifier(addon.addonId),
        ]),
      );
      if (
        link.secretId !== peer.resource.id ||
        link.addonId !== addon.addonId ||
        link.linked !== true ||
        keys(link.linkedKeys) !== keys(addon.keys)
      )
        throw new NorthflankFailure("Northflank addon link differs from reviewed policy.");
    }
    return definition;
  }
  private async deliver(
    gate: PreviewWriteGate,
    owned: NorthflankOwnership,
    store: NorthflankOwnershipStore,
    graph: ReturnType<typeof compileNorthflankGraph>,
    phase: "pre" | "post",
  ) {
    const peers = await this.secretPeers(owned);
    const values = new Map<string, string>();
    const markers = new Set<string>();
    for (const group of graph.secretBindings) {
      const peer = peers.find((peer) => peer.resource.reference === group.groupRef);
      if (!peer) throw new NorthflankFailure("Northflank selected secret group is unowned.");
      const variables = { ...peer.variables };
      const definition = await this.verifyAddonBindings(peer, graph);
      Object.assign(variables, record(record(definition.spec.secrets).variables));
      for (const [key, binding] of Object.entries(group.variables)) {
        const kind =
          "runtimeSecret" in binding
            ? "runtimeSecret"
            : "generated" in binding
              ? "generated"
              : "output";
        if ((phase === "pre" && kind === "output") || (phase === "post" && kind !== "output"))
          continue;
        const name =
          "runtimeSecret" in binding
            ? binding.runtimeSecret
            : "generated" in binding
              ? binding.generated
              : binding.output;
        const identity = `${kind}:${name}`;
        let value = values.get(identity);
        if (value === undefined) {
          if (kind === "runtimeSecret") {
            try {
              value = await this.options.runtimeSecret(name);
            } catch {
              throw new NorthflankFailure("Northflank runtime secret is unavailable.");
            }
          } else {
            value = this.peerValue(peers, kind, name, owned);
            if (value === undefined && kind === "generated") {
              const settings = this.options.graph.generated?.[name];
              if (!settings)
                throw new NorthflankFailure("Northflank generated value is undeclared.");
              value = randomBytes(settings.bytes).toString(settings.encoding);
            }
            if (kind === "output" && value === undefined)
              throw new NorthflankFailure("Northflank output has no verified recipient.");
            markers.add(`${kind === "generated" ? "g" : "o"}:${name}`);
          }
          if (!value || Buffer.byteLength(value) > 64 * 1024)
            throw new NorthflankFailure("Northflank runtime value is unavailable or oversized.");
          values.set(identity, value);
        }
        variables[key] = value;
      }
      await this.patchSecrets(
        gate,
        `secrets-${phase}-${digest(group.groupRef).slice(0, 20)}`,
        peer,
        variables,
        false,
        phase === "pre"
          ? Object.entries(group.variables)
              .filter(([, binding]) => "output" in binding)
              .map(([key]) => key)
          : [],
      );
    }
    if (await gate.fenced()) throw new NorthflankFenced();
    return store.update((current) => ({
      ...current,
      delivered: [...new Set([...(current.delivered ?? []), ...markers])].sort(),
    }));
  }
  private async verifySecrets(
    owned: NorthflankOwnership,
    graph: ReturnType<typeof compileNorthflankGraph>,
  ) {
    const peers = await this.secretPeers(owned);
    for (const group of graph.secretBindings) {
      const peer = peers.find((peer) => peer.resource.reference === group.groupRef);
      if (!peer) throw new NorthflankFailure("Northflank selected recipient is missing.");
      const definition = await this.verifyAddonBindings(peer, graph);
      const plain = record(record(definition.spec.secrets).variables);
      if (Object.entries(plain).some(([key, value]) => peer.variables[key] !== value))
        throw new NorthflankFailure("Northflank configured variables were lost.");
      for (const [key, binding] of Object.entries(group.variables)) {
        const value =
          "generated" in binding
            ? this.peerValue(peers, "generated", binding.generated, owned)
            : "output" in binding
              ? this.peerValue(peers, "output", binding.output, owned)
              : undefined;
        if (!peer.variables[key] || (value !== undefined && peer.variables[key] !== value))
          throw new NorthflankFailure("Northflank delivered variables were lost.");
      }
    }
  }
  private async settleFenced(
    effect: PreviewEffect,
    entry: PreviewPoolEntry,
    gate: PreviewWriteGate,
    owned: NorthflankOwnership,
    store: NorthflankOwnershipStore,
  ): Promise<PreviewEffectReceipt> {
    const steps = await gate.read();
    if (steps.some((step) => step.name.startsWith("secrets-") && step.state !== "accepted"))
      return { ...this.receipt(owned, true), outcome: "failed", cleanupRequired: true };
    const cutoff =
      entry.session.firstReadyAt === undefined
        ? entry.session.setupDeadline
        : entry.session.expiresAt;
    if (
      ["stopping", "cleanup-pending"].includes(entry.session.status) ||
      this.options.now() >= cutoff
    )
      return { ...this.receipt(owned, true), outcome: "cancelled" };
    // A newer source waits for every older native write; only stop can use the container deletion fence.
    for (const step of steps.filter(
      (item) => item.name.endsWith("-spec") && item.state !== "accepted",
    )) {
      if (!owned.blueprintId || !step.fingerprint) return this.receipt(owned);
      const blueprint = await this.options.api.request("GET", [
        "preview-blueprints",
        owned.blueprintId,
      ]);
      if (!blueprint || specDigest(data(blueprint).spec) !== step.fingerprint)
        return this.receipt(owned);
      await gate.record(step.name, "accepted");
    }
    for (const step of steps.filter((item) => item.name.endsWith("-run"))) {
      if (!owned.blueprintId) return this.receipt(owned);
      const operation = `${step.name.slice(0, -4)}-${digest(effect.id).slice(0, 20)}`;
      const path = ["preview-blueprints", owned.blueprintId];
      const id = step.ref ?? (await this.findRun(path, operation));
      if (!id) return this.receipt(owned);
      const result = await this.options.api.request("GET", [...path, "runs", id]);
      if (!result) return this.receipt(owned);
      const run = data(result);
      if (
        !run.concluded ||
        specDigest(run.spec) !== step.fingerprint ||
        record(run.arguments).devrouterOperation !== operation ||
        run.environmentId !== (owned.previewId ?? `preview-${entry.session.generation}`)
      )
        return this.receipt(owned);
      if (!step.ref) await gate.record(step.name, "accepted", id);
      owned = await this.capture(run, owned, store);
    }
    return { ...this.receipt(owned, true), outcome: "cancelled" };
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
  private async findRun(path: string[], operation: string): Promise<string | undefined> {
    let match: string | undefined;
    for (const summary of await this.options.api.list([...path, "runs"], "runs")) {
      const id = nativeIdentifier(summary.id);
      const candidate = data(await this.options.api.request("GET", [...path, "runs", id]));
      if (record(candidate.arguments ?? {}).devrouterOperation !== operation) continue;
      if (match) throw new NorthflankFailure("Ambiguous Northflank run outcome.");
      match = id;
    }
    return match;
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
    let fingerprint = specDigest(spec);
    const operation = `${stage}-${digest(effect.id).slice(0, 20)}`;
    const recorded = (await gate.read()).find((step) => step.name === `${stage}-run`);
    if (!recorded) {
      if ((await begin(gate, `${stage}-spec`, "once", fingerprint)) === "write") {
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
      if (specDigest(detail.spec) !== fingerprint)
        throw new NorthflankFailure("Northflank blueprint specification drifted.");
      await gate.record(`${stage}-spec`, "accepted");
      if ((await begin(gate, `${stage}-run`, "once", fingerprint)) === "write") {
        try {
          const run = data(
            await api.request("POST", [...path, "runs"], {
              name: owned.previewId ?? `preview-${entry.session.generation}`,
              arguments: { devrouterOperation: operation },
            }),
          );
          await gate.record(`${stage}-run`, "accepted", nativeIdentifier(run.id));
        } catch (error) {
          if (!(error instanceof NorthflankOutcomeUncertain)) throw error;
          await gate.record(`${stage}-run`, "uncertain");
        }
      }
    } else {
      if (!recorded.fingerprint)
        throw new NorthflankFailure("Northflank run has no admitted specification.");
      fingerprint = recorded.fingerprint;
    }
    const step = (await gate.read()).find((item) => item.name === `${stage}-run`);
    if (!step) return null;
    let id = step.ref;
    if (!id) {
      id = await this.findRun(path, operation);
      if (!id) return null;
      await gate.record(`${stage}-run`, "accepted", id);
    }
    const run = data(await api.request("GET", [...path, "runs", id]));
    if (
      specDigest(run.spec) !== fingerprint ||
      record(run.arguments).devrouterOperation !== operation ||
      run.environmentId !== (owned.previewId ?? `preview-${entry.session.generation}`)
    )
      throw new NorthflankFailure("Northflank executed an unexpected specification or operation.");
    if (owned.previewId) {
      const previews = await api.list([...path, "previews"], "previewEnvironments");
      if (previews.length !== 1 || previews[0].id !== owned.previewId)
        throw new NorthflankFailure("Northflank run changed the generation environment.");
    }
    return run;
  }
  private async capture(
    run: Record<string, unknown>,
    owned: NorthflankOwnership,
    store: NorthflankOwnershipStore,
  ) {
    const refs = record(run.refs);
    const steps = record(record(run.spec).spec).steps;
    if (!Array.isArray(steps))
      throw new NorthflankFailure("Northflank executed graph is unavailable.");
    const additions: NorthflankOwnedResource[] = [];
    const kinds = nativeKinds;
    for (const raw of steps) {
      const node = record(raw);
      if (typeof node.ref !== "string" || typeof node.kind !== "string" || !kinds[node.kind])
        continue;
      if (!/^(r|b|e|d)_/.test(node.ref)) continue;
      const previous = owned.resources.find((item) => item.reference === node.ref);
      if (previous) continue;
      const output = refs[node.ref];
      if (!output) continue;
      const kind = kinds[node.kind];
      if (kind === "domains") {
        const spec = record(node.spec);
        const id = nativeIdentifier(spec.name);
        const result = await this.options.api.subdomain("GET", id);
        if (!result) continue;
        const observed = data(result);
        if (observed.fullName !== `${id}.${this.options.graph.baseDomain}`)
          throw new NorthflankFailure("Northflank domain identity differs.");
        additions.push({ reference: node.ref, kind, id, name: observed.fullName as string });
        continue;
      }
      const response = record(output);
      if (
        response.status !== "success" ||
        !response.data ||
        typeof response.data !== "object" ||
        Array.isArray(response.data)
      )
        continue;
      const captured = response.data as Record<string, unknown>;
      const id = nativeIdentifier(captured.id);
      const observed = data(await this.options.api.request("GET", [kind, id]));
      const name = nativeIdentifier(observed.name);
      if (name !== record(node.spec).name)
        throw new NorthflankFailure(
          "Northflank allocation identity differs from its executed graph.",
        );
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
      const candidates = await this.namedBlueprints(entry);
      // An uncertain create is never forgotten or adopted by name alone.
      return this.receipt(owned, candidates.length === 0);
    }
    const path = ["preview-blueprints", owned.blueprintId];
    const blueprint = await this.options.api.request("GET", path);
    if (!blueprint && !owned.blueprintObserved && !owned.blueprintRejected)
      return this.receipt(owned);
    if (blueprint) {
      if (!owned.blueprintObserved)
        owned = await store.update((current) => ({ ...current, blueprintObserved: true }));
      const runs = await this.options.api.list([...path, "runs"], "runs");
      for (const run of runs.filter((row) => row.concluded !== true)) {
        const id = nativeIdentifier(run.id);
        const step = `abort-${digest(id).slice(0, 12)}`;
        if ((await begin(gate, step, "convergent")) === "write") {
          await this.options.api.request("POST", [...path, "runs", id, "abort"]);
          await gate.record(step, "accepted", id);
        }
      }
      if (effect.kind === "cancel") return this.receipt(owned, true);
      const previews = await this.options.api.list([...path, "previews"], "previewEnvironments");
      for (const preview of previews) {
        const id = nativeIdentifier(preview.id);
        const step = `delete-${digest(id).slice(0, 12)}`;
        if ((await begin(gate, step, "convergent")) === "write") {
          await this.options.api.request("DELETE", [...path, "previews", id]);
          await gate.record(step, "accepted", id);
        }
      }
      if ((await this.options.api.list([...path, "previews"], "previewEnvironments")).length)
        return this.receipt(owned);
      let cleanedDomains = 0;
      for (const resource of owned.resources.filter((item) => item.kind === "domains")) {
        if (!(await this.options.api.subdomain("GET", resource.id))) continue;
        if (++cleanedDomains > 120) return { ...this.receipt(owned, true), outcome: "failed" };
        const step = `domain-${digest(resource.id).slice(0, 12)}`;
        if ((await begin(gate, step, "convergent")) === "write") {
          await this.options.api.subdomain("DELETE", resource.id);
          await gate.record(step, "accepted");
        }
      }
      if ((await begin(gate, "delete-blueprint", "convergent")) === "write") {
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
      delivered: [],
      absent: true,
    }));
    return this.receipt(owned, true);
  }
  async absent(entry: PreviewPoolEntry): Promise<boolean> {
    const owned = await this.ownership(entry).read();
    if (!owned)
      return (
        entry.session.ownedResources.length === 0 &&
        Object.values(entry.operations).every(
          (operation) =>
            operation.phase === "terminal" &&
            !operation.steps?.length &&
            operation.resources.length === 0,
        )
      );
    if (owned.absent) return true;
    if (owned.blueprintId && !owned.blueprintObserved && !owned.blueprintRejected) return false;
    const api = this.options.api;
    if (owned.blueprintId && (await api.request("GET", ["preview-blueprints", owned.blueprintId])))
      return false;
    if ((await this.namedBlueprints(entry)).length > 0) return false;
    const prefix = northflankAllocationPrefix(this.options.graph, entry.session.generation);
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

const nativeKinds: Record<string, NorthflankOwnedResource["kind"]> = {
  Addon: "addons",
  BuildService: "services",
  DeploymentService: "services",
  Job: "jobs",
  Volume: "volumes",
  SecretGroup: "secrets",
  Subdomain: "domains",
};
const emptySpec = { kind: "Workflow", spec: { type: "sequential", steps: [] } };
function data(value: Record<string, unknown> | null): Record<string, unknown> {
  if (!value?.data || typeof value.data !== "object" || Array.isArray(value.data))
    throw new NorthflankFailure("Invalid Northflank native observation.");
  return value.data as Record<string, unknown>;
}
function addonIds(details: Record<string, unknown>): string {
  if (!Array.isArray(details.addonSecrets))
    throw new NorthflankFailure("Northflank addon bindings are unavailable.");
  return JSON.stringify(details.addonSecrets.map((item) => record(item).id).sort());
}
function specDigest(value: unknown): string {
  const definition = (node: unknown): Record<string, unknown> => {
    const { response: _response, ...fields } = record(node);
    if (fields.kind === "Workflow") {
      const workflow = record(fields.spec);
      if (!Array.isArray(workflow.steps))
        throw new NorthflankFailure("Northflank workflow steps are unavailable.");
      fields.spec = { ...workflow, steps: workflow.steps.map(definition) };
    }
    return fields;
  };
  return digest(definition(value));
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

async function begin(
  gate: PreviewWriteGate,
  name: string,
  mode: "once" | "convergent",
  fingerprint?: string,
) {
  const result = await gate.begin(name, mode, fingerprint);
  if (result === "fenced") throw new NorthflankFenced();
  return result;
}

function outputNames(graph: ReturnType<typeof compileNorthflankGraph>): string[] {
  return [
    ...new Set(
      graph.secretBindings.flatMap((group) =>
        Object.values(group.variables).flatMap((binding) =>
          "output" in binding ? [binding.output] : [],
        ),
      ),
    ),
  ].sort();
}

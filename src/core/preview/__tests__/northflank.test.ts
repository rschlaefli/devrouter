import { describe, expect, it } from "vitest";
import { PreviewEngine, type PreviewWriteGate } from "../engine";
import { createPreviewSession } from "../lifecycle";
import { NorthflankOwnershipStore, NorthflankPreviewProvider } from "../providers/northflank";
import { NorthflankOutcomeUncertain, NorthflankPreviewAPI } from "../providers/northflank-api";
import { compileNorthflankGraph, type NorthflankGraphPolicy } from "../providers/northflank-graph";
import type { PreviewPoolEntry } from "../state";
import {
  createPreviewPool,
  type PreviewEffectStep,
  PreviewStateConflict,
  type PreviewStateStore,
} from "../state";

const page = (rows: unknown[], next = false, cursor?: string) =>
  new Response(
    JSON.stringify({
      data: { runs: rows },
      pagination: { hasNextPage: next, count: rows.length, cursor },
    }),
  );

describe("Northflank preview transport", () => {
  it("scopes credentials to the configured project and refuses redirects/path traversal", async () => {
    let calls = 0;
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async (url, init) => {
        calls += 1;
        expect(String(url)).toBe(
          "https://api.northflank.com/v1/projects/isolated/preview-blueprints/owned/runs?per_page=100",
        );
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic" });
        return page([]);
      },
    });
    expect(await api.list(["preview-blueprints", "owned", "runs"], "runs")).toEqual([]);
    await expect(api.request("GET", ["preview-blueprints", "../other"])).rejects.toThrow();
    await expect(api.request("GET", ["teams"])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("detects repeated pagination cursors rather than proving partial absence", async () => {
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async () => page([], true, "a".repeat(24)),
    });
    await expect(api.list(["preview-blueprints", "owned", "runs"], "runs")).rejects.toThrow(
      "cursor",
    );
  });

  it("keeps uncertain mutation outcomes without retrying or returning secret response text", async () => {
    let calls = 0;
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async () => {
        calls += 1;
        throw new Error("private-response");
      },
    });
    await expect(api.request("POST", ["preview-blueprints", "owned", "runs"], {})).rejects.toThrow(
      "uncertain",
    );
    expect(calls).toBe(1);
  });

  it("suppresses malformed response content and marks all uncertain writes", async () => {
    for (const status of [200, 504]) {
      const api = new NorthflankPreviewAPI({
        projectId: "isolated",
        accessToken: async () => "synthetic",
        fetch: async () => new Response("private-response-sentinel", { status }),
      });
      try {
        await api.request("POST", ["preview-blueprints", "owned", "runs"], {});
        throw new Error("Expected uncertainty");
      } catch (error) {
        expect(error).toBeInstanceOf(NorthflankOutcomeUncertain);
        expect((error as Error).message).not.toContain("private-response-sentinel");
      }
    }
  });

  it("bounds chunked responses without trusting Content-Length", async () => {
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async () => new Response(JSON.stringify({ data: "a".repeat(1024 * 1024 + 1) })),
    });
    await expect(api.request("GET", ["preview-blueprints", "owned"])).rejects.toThrow();
  });

  it("keeps successful but unreadable expiry changes uncertain", async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      new Response("{}"),
      new Response('{"data":[]}'),
    ]) {
      const api = new NorthflankPreviewAPI({
        projectId: "isolated",
        accessToken: async () => "synthetic",
        fetch: async () => response,
      });
      await expect(
        api.resetDeadline("owned", "preview", 1_700_000_000_000, 1_699_996_326_000),
      ).rejects.toBeInstanceOf(NorthflankOutcomeUncertain);
    }
  });

  it("confirms the complete early expiry window reserved for rounding and delay", async () => {
    const target = 1_700_000_000_000;
    const now = target - 3_674_000;
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async (_url, init) =>
        new Response(
          JSON.stringify({
            data: {
              expiryTime: new Date(
                now + JSON.parse(init!.body as string).lifetime * 60_000,
              ).toISOString(),
            },
          }),
        ),
    });
    expect(await api.resetDeadline("owned", "preview", target, now)).toBe(target - 74_000);
  });

  it("derives remaining minutes from a fixed target and refuses a later provider expiry", async () => {
    const target = 1_700_000_000_000;
    let returned = target - 10_000;
    const lifetimes: number[] = [];
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async (_url, init) => {
        lifetimes.push(JSON.parse(init!.body as string).lifetime);
        return new Response(
          JSON.stringify({ data: { expiryTime: new Date(returned).toISOString() } }),
        );
      },
    });
    expect(await api.resetDeadline("owned", "preview", target, target - 3_630_000)).toBe(returned);
    returned = target + 1;
    await expect(
      api.resetDeadline("owned", "preview", target, target - 3_570_000),
    ).rejects.toBeInstanceOf(NorthflankOutcomeUncertain);
    expect(lifetimes).toEqual([60, 59]);
  });
});

function graphFixture(): { entry: PreviewPoolEntry; policy: NorthflankGraphPolicy } {
  const head = "a".repeat(40);
  return {
    entry: {
      session: createPreviewSession({
        generation: "1".repeat(24),
        now: 1_700_000_000_000,
        revision: head,
        aliases: ["web"],
        commandId: "fixture",
      }),
      effectSequence: 0,
      reservedCents: 1,
      hourlyCents: 1,
      operations: {},
      plan: {
        schemaVersion: 1,
        status: "planned",
        aliases: ["web"],
        manifestDigest: "d".repeat(64),
        localConfigDigest: "e".repeat(64),
        omissions: [],
        reasons: [],
        source: {
          head,
          target: "b".repeat(40),
          mergeBase: "c".repeat(40),
          complete: true,
          changes: [],
        },
        resources: [
          { id: "db", kind: "postgres" },
          {
            id: "seed",
            kind: "job",
            dependsOn: ["db"],
            image: `example/seed@sha256:${"0".repeat(64)}`,
          },
          {
            id: "web",
            kind: "service",
            dependsOn: ["seed"],
            image: `example/web@sha256:${"0".repeat(64)}`,
            ports: [{ name: "http", port: 8080, public: true }],
          },
        ],
      },
    },
    policy: {
      namespace: "fixture",
      baseDomain: "preview.example.org",
      allowedNetworks: ["192.0.2.0/24"],
      resources: {
        db: { deploymentPlan: "nf-compute-10", addonVersion: "16", storageMiB: 1024 },
        seed: { deploymentPlan: "nf-compute-10" },
        web: {
          deploymentPlan: "nf-compute-10",
          readiness: { port: "http", path: "/health" },
          environment: {
            DATABASE_URL: { addon: "db", key: "POSTGRES_URI" },
            API_KEY: { runtimeSecret: "synthetic-upstream" },
          },
        },
      },
    },
  };
}

describe("Northflank native graph compilation", () => {
  it("prepares private backing services and inactive compute with scoped secret channels", () => {
    const { entry, policy } = graphFixture();
    const graph = compileNorthflankGraph(entry, policy, "prepare");
    const steps = graph.spec.spec.steps;
    expect(() => compileNorthflankGraph(entry, policy, "activate")).toThrow();
    expect(steps.find((node) => node.kind === "Addon")?.spec).toMatchObject({
      externalAccessEnabled: false,
      tlsEnabled: true,
    });
    expect(steps.find((node) => node.kind === "DeploymentService")?.spec).toMatchObject({
      deployment: { instances: 0 },
      ports: [
        {
          public: false,
          security: { policies: [{ action: "ALLOW", addresses: ["192.0.2.0/24"] }] },
        },
      ],
    });
    expect(steps.some((node) => node.kind === "JobRun")).toBe(false);
    expect(steps.find((node) => node.kind === "SecretGroup")?.spec).toMatchObject({
      restrictions: { restricted: true, nfObjects: [{ type: "service" }] },
      addonDependencies: [
        {
          addonId: "${refs.r_db.id}",
          keys: [{ keyName: "POSTGRES_URI", aliases: ["DATABASE_URL"] }],
        },
      ],
      secrets: { variables: {}, files: {} },
    });
    expect(graph.runtimeSecrets).toEqual([
      { groupRef: "e_web", variables: { API_KEY: "synthetic-upstream" } },
    ]);
  });

  it("orders initialization before activation and protects default and custom public URLs", () => {
    const { entry, policy } = graphFixture();
    const prepared = compileNorthflankGraph(entry, policy, "prepare");
    const graph = compileNorthflankGraph(entry, policy, "activate", {
      resources: { r_db: "owned-db", r_seed: "owned-seed", r_web: "owned-web" },
      domains: Object.values(prepared.urls).map((url) => new URL(url).hostname),
    });
    const steps = graph.spec.spec.steps;
    const job = steps.findIndex((node) => node.kind === "JobRun");
    const serving = steps.findIndex(
      (node) =>
        node.kind === "DeploymentService" &&
        (node.spec.deployment as { instances: number }).instances === 1,
    );
    expect(job).toBeGreaterThan(-1);
    expect(serving).toBeGreaterThan(job);
    expect(steps[job]).toMatchObject({ runNodeOnce: "true", condition: "success" });
    expect(steps[serving].spec).toMatchObject({
      ports: [
        {
          public: true,
          domains: [new URL(graph.urls["web:http"]).hostname],
          security: { policies: [{ action: "ALLOW", addresses: ["192.0.2.0/24"] }] },
        },
      ],
    });
    const refs = steps.flatMap((node) => (node.ref ? [node.ref] : []));
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("serializes non-secret build payloads and private addresses for the exact generation", () => {
    const { entry, policy } = graphFixture();
    const web = entry.plan.resources[2];
    delete web.image;
    web.build = { context: ".", dockerfile: "Dockerfile" };
    policy.git = { url: "https://github.com/example/fixture", type: "github", branch: "main" };
    policy.resources.web.buildPlan = "nf-compute-200";
    policy.resources.web.publicBuildEnvironment = {
      PREVIEW_CONFIG: {
        json: {
          PREVIEW_ID: { generation: true },
          URL: { origin: "web", port: "http", path: "/graphql" },
          HOST: { origin: "web", port: "http", format: "hostname" },
          INTERNAL_URL: { service: "web", port: "http", format: "http-url", path: "/health" },
          QUOTED: { literal: 'quote" and \n newline' },
        },
      },
    };
    policy.resources.web.environment = {
      SELF_HOST: { service: "web", port: "http", format: "host" },
      SELF_PORT: { service: "web", port: "http", format: "authority" },
    };
    const first = compileNorthflankGraph(entry, policy, "prepare");
    const build = first.spec.spec.steps.find((node) => node.kind === "BuildService")!;
    const config = JSON.parse((build.spec.buildArguments as Record<string, string>).PREVIEW_CONFIG);
    const service = first.spec.spec.steps.find((node) => node.kind === "DeploymentService")!;
    expect(config.PREVIEW_ID).toBe(entry.session.generation);
    expect(config.URL).toBe(`${first.urls["web:http"]}/graphql`);
    expect(config.HOST).toBe(new URL(first.urls["web:http"]).hostname);
    expect(config.INTERNAL_URL).toBe(`http://${service.spec.name}:8080/health`);
    expect(config.QUOTED).toBe('quote" and \n newline');
    const group = first.spec.spec.steps.find((node) => node.ref === "e_web")!;
    expect(group.spec.secrets).toMatchObject({
      variables: {
        SELF_HOST: service.spec.name,
        SELF_PORT: `${service.spec.name}:8080`,
      },
    });
    entry.session.generation = "2".repeat(24);
    const second = compileNorthflankGraph(entry, policy, "prepare");
    const nextBuild = second.spec.spec.steps.find((node) => node.kind === "BuildService")!;
    expect(nextBuild.spec.name).not.toBe(build.spec.name);
    expect(nextBuild.spec.buildArguments).not.toEqual(build.spec.buildArguments);
    expect(second.urls["web:http"]).not.toBe(first.urls["web:http"]);
  });

  it("refuses secret JSON fields, oversized payloads, foreign addresses and public raw transports", () => {
    const { entry, policy } = graphFixture();
    const web = entry.plan.resources[2];
    delete web.image;
    web.build = { context: ".", dockerfile: "Dockerfile" };
    policy.git = { url: "https://github.com/example/fixture", type: "github", branch: "main" };
    policy.resources.web.buildPlan = "nf-compute-200";
    for (const fields of [
      { SECRET: { runtimeSecret: "upstream" } },
      { DB: { addon: "db", key: "POSTGRES_URI" } },
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`KEY_${i}`, { literal: "ok" }])),
      Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`KEY_${i}`, { literal: "a".repeat(4096) }]),
      ),
      { URL: { origin: "web", port: "http", path: "//foreign.example.org" } },
      { URL: { service: "foreign", port: "http", format: "http-url" } },
    ]) {
      policy.resources.web.publicBuildEnvironment = { CONFIG: { json: fields } } as never;
      expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    }
    delete policy.resources.web.publicBuildEnvironment;
    policy.resources.web.portProtocols = { http: "TCP" };
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    web.ports![0].public = false;
    const graph = compileNorthflankGraph(entry, policy, "prepare");
    expect(
      graph.spec.spec.steps.find((node) => node.kind === "DeploymentService")?.spec.ports,
    ).toMatchObject([{ protocol: "TCP", public: false }]);
    policy.resources.web.environment = {
      URL: { service: "web", port: "http", format: "http-url" },
    };
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
  });

  it("pins native source builds to the admitted SHA and rejects incomplete access or recipes", () => {
    const { entry, policy } = graphFixture();
    const web = entry.plan.resources[2];
    delete web.image;
    web.build = { context: ".", dockerfile: "Dockerfile" };
    policy.git = { url: "https://github.com/example/fixture", type: "github", branch: "main" };
    policy.resources.web.buildPlan = "nf-compute-200";
    for (const [id, port] of [
      ["build-web", "http"],
      ["env-web", "http"],
      ["a", "b-c"],
      ["a-b", "c"],
    ]) {
      entry.plan.resources.push({
        id,
        kind: "service",
        image: `example/app@sha256:${"0".repeat(64)}`,
        ports: [{ name: port, port: 8080, public: true }],
      });
      policy.resources[id] = {
        deploymentPlan: "nf-compute-10",
        readiness: { port, path: "/health" },
      };
    }
    const graph = compileNorthflankGraph(entry, policy, "prepare");
    expect(graph.spec.spec.steps.find((node) => node.kind === "Build")).toMatchObject({
      spec: { sha: entry.plan.source!.head },
      condition: "success",
    });
    const refs = graph.spec.spec.steps.flatMap((node) => (node.ref ? [node.ref] : []));
    expect(new Set(refs).size).toBe(refs.length);
    entry.plan.resources[1].ports = [{ name: "http", port: 8080, public: true }];
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    delete entry.plan.resources[1].ports;
    web.build.target = "${refs.r_db.id}";
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    delete web.build.target;
    web.command = ["sh", "-c", "${refs.r_db.id}"];
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    delete web.command;
    policy.allowedNetworks = [];
    expect(() => compileNorthflankGraph(entry, policy, "activate")).toThrow();
    policy.allowedNetworks = ["192.0.2.0/24"];
    delete policy.resources.web.readiness;
    expect(() => compileNorthflankGraph(entry, policy, "activate")).toThrow();
  });
});

describe("Northflank generation ownership", () => {
  it("preserves native identity and refuses recreated missing state or foreign metadata", async () => {
    let value: unknown;
    let version = 0;
    const store: PreviewStateStore = {
      async read<T>(_key: string, validate: (data: unknown) => T) {
        return value === undefined ? null : { value: validate(value), version: String(version) };
      },
      async compareAndSwap(_key, expected, data) {
        if (expected !== (value === undefined ? null : String(version)))
          throw new PreviewStateConflict();
        value = structuredClone(data);
        version += 1;
        return String(version);
      },
    };
    const steps: PreviewEffectStep[] = [];
    const gate: PreviewWriteGate = {
      read: async () => structuredClone(steps),
      fenced: async () => false,
      begin: async (name, mode) => {
        if (steps.some((step) => step.name === name)) return "resolve";
        steps.push({ name, mode, state: "intent", at: 1 });
        return "write";
      },
      record: async (name, state) => {
        steps.find((step) => step.name === name)!.state = state;
      },
    };
    const ownership = new NorthflankOwnershipStore({
      store,
      installationId: "fixture",
      generation: "1".repeat(24),
      policyDigest: "d".repeat(64),
    });
    await ownership.initialize(gate);
    await ownership.update((current) => ({
      ...current,
      blueprintId: "owned-blueprint",
      previewId: "owned-preview",
    }));
    await expect(
      ownership.update((current) => ({ ...current, previewId: "foreign-preview" })),
    ).rejects.toThrow();
    await expect(
      ownership.update((current) => ({ ...current, previewId: undefined })),
    ).rejects.toThrow();
    await ownership.update((current) => ({
      ...current,
      resources: [
        {
          reference: "r_web",
          kind: "services",
          id: "owned-web",
          uid: "1".repeat(24),
          name: "owned-web",
        },
      ],
    }));
    await expect(ownership.update((current) => ({ ...current, resources: [] }))).rejects.toThrow();
    await expect(
      ownership.update((current) => ({
        ...current,
        resources: current.resources.map((item) => ({ ...item, uid: "2".repeat(24) })),
      })),
    ).rejects.toThrow();
    const another = new NorthflankOwnershipStore({
      store,
      installationId: "fixture",
      generation: "2".repeat(24),
      policyDigest: "d".repeat(64),
    });
    await expect(another.read()).rejects.toThrow();
    value = undefined;
    await expect(ownership.initialize(gate)).rejects.toThrow();
    await expect(ownership.initialize({ ...gate, read: async () => [] }, true)).rejects.toThrow(
      "missing",
    );
  });
});

function providerFixture() {
  const { entry, policy } = graphFixture();
  let now = entry.session.setupDeadline - 20 * 60_000;
  let loseSpecReceipt = false;
  let stopBeforeDispatch = false;
  const records = new Map<string, { value: unknown; version: number }>([
    ["installations/fixture/pool", { value: createPreviewPool("fixture"), version: 1 }],
  ]);
  const store: PreviewStateStore = {
    async read<T>(key: string, validate: (value: unknown) => T) {
      const row = records.get(key);
      return row
        ? { value: validate(structuredClone(row.value)), version: String(row.version) }
        : null;
    },
    async compareAndSwap(key, expected, value) {
      const row = records.get(key);
      if (expected !== (row ? String(row.version) : null)) throw new PreviewStateConflict();
      const entries = Object.values(
        (value as { sessions?: Record<string, PreviewPoolEntry> }).sessions ?? {},
      );
      if (
        loseSpecReceipt &&
        entries.some((entry) =>
          Object.values(entry.operations).some((operation) =>
            operation.steps?.some(
              (step) => step.name === "prepare-spec" && step.state === "accepted",
            ),
          ),
        )
      ) {
        loseSpecReceipt = false;
        throw new Error("synthetic lost spec receipt");
      }
      records.set(key, { value: structuredClone(value), version: (row?.version ?? 0) + 1 });
      if (
        stopBeforeDispatch &&
        entries.some((entry) =>
          Object.values(entry.operations).some((operation) => operation.phase === "prepared"),
        )
      ) {
        stopBeforeDispatch = false;
        await command("stop-before-dispatch", { kind: "stop" });
      }
      return String((row?.version ?? 0) + 1);
    },
  };
  let blueprint: Record<string, any> | undefined;
  const runs = new Map<string, Record<string, any>>();
  const allocations = new Map<string, Record<string, any>>();
  const domains = new Map<string, string>();
  const mutations: string[] = [];
  let lostRun = false;
  let missingSecret = false;
  let pendingBootstrap = false;
  let delayedBlueprint: Record<string, any> | undefined;
  let delayBlueprint = false;
  let rejectBlueprint = false;
  let pendingPrepare = false;
  let failReset = false;
  let failRead = false;
  let failDelete = false;
  let refreshDuringPrepare = false;
  let desiredPlan = entry.plan;
  const response = (data: unknown) => {
    const rows =
      data && typeof data === "object" && !Array.isArray(data)
        ? Object.values(data).find(Array.isArray)
        : undefined;
    return new Response(
      JSON.stringify({
        data,
        ...(rows ? { pagination: { hasNextPage: false, count: rows.length } } : {}),
      }),
    );
  };
  const api = new NorthflankPreviewAPI({
    projectId: "fixture",
    domain: policy.baseDomain,
    accessToken: async () => "synthetic",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const parts = url.pathname.split("/").filter(Boolean);
      const tail = parts.slice(3);
      if (method !== "GET") mutations.push(`${method} ${tail.join("/")}`);
      if (parts[1] === "domains") {
        const name = parts.at(-1)!;
        if (method === "DELETE") domains.delete(name);
        return domains.has(name)
          ? response({ fullName: domains.get(name) })
          : new Response(null, { status: 404 });
      }
      if (tail[0] !== "preview-blueprints") {
        if (tail.length === 1) {
          const rows = [...allocations.values()].filter((row) => row.kind === tail[0]);
          return response(tail[0] === "volumes" ? rows : { [tail[0]]: rows });
        }
        const row = allocations.get(tail[1]);
        if (!row) return new Response(null, { status: 404 });
        if (method === "PATCH") row.patch = body;
        return response(row);
      }
      if (tail.length === 1) {
        if (method === "POST") {
          if (rejectBlueprint) return new Response(null, { status: 422 });
          if (delayBlueprint) {
            delayedBlueprint = { ...body, id: body.name };
            delayBlueprint = false;
            throw new Error("synthetic delayed create");
          }
          blueprint = { ...body, id: body.name };
        }
        return response({ workflows: blueprint ? [blueprint] : [] });
      }
      if (!blueprint) return new Response(null, { status: 404 });
      if (tail.length === 2) {
        if (method === "POST") blueprint = { ...body, id: tail[1] };
        if (method === "DELETE") blueprint = undefined;
        return response(blueprint);
      }
      if (tail[2] === "previews") {
        if (tail[4] === "reset") {
          if (failReset) {
            failReset = false;
            throw new Error("synthetic unknown reset");
          }
          return response({ expiryTime: new Date(now + body.lifetime * 60_000).toISOString() });
        }
        if (method === "DELETE") {
          if (failDelete) {
            failDelete = false;
            throw new Error("synthetic uncertain delete");
          }
          allocations.clear();
          domains.clear();
          runs.clear();
        }
        return response({
          previewEnvironments:
            method === "DELETE" || runs.size === 0 ? [] : [{ id: "environment" }],
        });
      }
      if (tail[2] === "runs") {
        if (method === "POST" && tail.length === 3) {
          const id = `run-${runs.size}`;
          const spec = structuredClone(blueprint.spec);
          const refs: Record<string, unknown> = {};
          for (const node of spec.spec.steps) {
            const kind: Record<string, string> = {
              Addon: "addons",
              DeploymentService: "services",
              BuildService: "services",
              Job: "jobs",
              Volume: "volumes",
              SecretGroup: "secrets",
            };
            if (node.kind === "Subdomain") {
              domains.set(node.spec.name, `${node.spec.name}.${policy.baseDomain}`);
              refs[node.ref] = { id: node.spec.name };
            } else if (kind[node.kind]) {
              const native = node.spec.name;
              const row = allocations.get(native) ?? {
                id: native,
                name: native,
                uid: "a".repeat(24),
                kind: kind[node.kind],
              };
              allocations.set(native, row);
              refs[node.ref] = { id: native };
            }
          }
          const row = {
            id,
            name: body.name,
            spec,
            refs,
            environmentId: "environment",
            concluded: !(
              (pendingBootstrap && body.name.startsWith("bootstrap-")) ||
              (pendingPrepare && body.name.startsWith("prepare-"))
            ),
            status: "success",
          };
          runs.set(id, row);
          if (lostRun) {
            lostRun = false;
            throw new Error("synthetic lost response");
          }
          return response(row);
        }
        if (tail.length === 3) return response({ runs: [...runs.values()] });
        if (failRead) {
          failRead = false;
          throw new Error("synthetic read unavailable");
        }
        const row = runs.get(tail[3]);
        if (refreshDuringPrepare && row?.name.startsWith("prepare-")) {
          refreshDuringPrepare = false;
          desiredPlan = structuredClone(entry.plan);
          desiredPlan.source!.head = "f".repeat(40);
          await command("refresh", { kind: "start", aliases: ["web"] });
        }
        return response(row);
      }
      throw new Error("Unexpected synthetic endpoint");
    },
  });
  const qualification = {
    fixedDeadline: true,
    sameEnvironment: true,
    deletionFence: true,
    scopedRuntimeSecrets: true,
    restrictedIngress: true,
  };
  const provider = new NorthflankPreviewProvider({
    api,
    store,
    graph: policy,
    installationId: "fixture",
    qualification,
    now: () => now,
    runtimeSecret: async () => {
      if (missingSecret) throw new Error("synthetic unavailable");
      return "test-value";
    },
    accept: async () => true,
  });
  const identity = { forgeHost: "github.com", projectId: "123", change: 7 };
  const engine = new PreviewEngine({
    store,
    provider,
    now: () => now,
    workerId: "worker",
    policy: {
      installationId: "fixture",
      maxActive: 2,
      maxReservedCents: 1000,
      maxCommandAgeMs: 60_000,
      startupBudgetMs: 20 * 60_000,
      leaseMs: 30_000,
      allowedProjects: ["github.com/123"],
      allowedAliases: ["web"],
      manifestDigests: [entry.plan.manifestDigest],
      localConfigDigests: [entry.plan.localConfigDigest],
    },
  });
  const command = (id: string, command: any) =>
    engine.admit({
      identity,
      commandId: id,
      createdAt: now,
      actorCanWrite: true,
      originalHumanRoot: true,
      open: true,
      sameProject: true,
      command,
      plan: desiredPlan,
      hourlyCents: 1,
    });
  const reconcile = async (count = 10) => {
    for (let i = 0; i < count; i++) await engine.reconcile(identity);
    return engine.status(identity);
  };
  return {
    provider,
    qualification,
    command,
    reconcile,
    mutations,
    allocations,
    runs,
    engine,
    identity,
    loseRun: () => {
      lostRun = true;
    },
    loseSpecReceipt: () => {
      loseSpecReceipt = true;
    },
    stopBeforeDispatch: () => {
      stopBeforeDispatch = true;
    },
    failReset: () => {
      failReset = true;
    },
    rejectBlueprint: () => {
      rejectBlueprint = true;
    },
    holdPrepare: () => {
      pendingPrepare = true;
    },
    finishRuns: () => {
      pendingPrepare = false;
      for (const run of runs.values()) run.concluded = true;
    },
    refreshSource: () => {
      desiredPlan = structuredClone(entry.plan);
      desiredPlan.source!.head = "f".repeat(40);
    },
    delayBlueprint: () => {
      delayBlueprint = true;
    },
    completeBlueprint: () => {
      blueprint = delayedBlueprint;
    },
    holdBootstrap: () => {
      pendingBootstrap = true;
    },
    failRead: () => {
      failRead = true;
    },
    failDelete: () => {
      failDelete = true;
    },
    refreshDuringPrepare: () => {
      refreshDuringPrepare = true;
    },
    failSecret: () => {
      missingSecret = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Northflank provider lifecycle", () => {
  it("requires qualification before admission and keeps the source graph offline", async () => {
    const f = providerFixture();
    f.qualification.restrictedIngress = false;
    await expect(f.command("start", { kind: "start", aliases: ["web"] })).rejects.toThrow(
      "qualification",
    );
    expect(f.mutations).toEqual([]);
  });
  it("arms a deadline before compute, delivers runtime secrets, reaches ready and verifies deletion", async () => {
    const f = providerFixture();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const ready = await f.reconcile();
    expect(ready?.session.status).toBe("ready");
    expect(f.mutations.findIndex((item) => item.endsWith("/reset"))).toBeLessThan(
      f.mutations.findIndex((item) => item.startsWith("PATCH secrets/")),
    );
    const group = [...f.allocations.values()].find((item) => item.kind === "secrets");
    expect(group?.patch.secrets.variables.API_KEY).toBe("test-value");
    await f.command("stop", { kind: "stop" });
    const stopped = await f.reconcile();
    expect(stopped?.session.reservationHeld).toBe(false);
    expect(f.allocations.size).toBe(0);
  });
  it("recovers a lost once-only run response without posting another bootstrap run", async () => {
    const f = providerFixture();
    f.loseRun();
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile())?.session.status).toBe("ready");
    expect([...f.runs.values()].filter((run) => run.name.startsWith("bootstrap-")).length).toBe(1);
  });
  it("stops and cleans up when runtime secret delivery fails", async () => {
    const f = providerFixture();
    f.failSecret();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const failed = await f.reconcile(20);
    expect(failed?.session.reservationHeld).toBe(false);
    expect(f.allocations.size).toBe(0);
    expect([...f.runs.values()].some((run) => run.name.startsWith("activate-"))).toBe(false);
  });
  it("stops during pending bootstrap without wedging the ownership initializer", async () => {
    const f = providerFixture();
    f.holdBootstrap();
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile(1))?.session.reservationHeld).toBe(true);
    await f.command("stop", { kind: "stop" });
    expect((await f.reconcile(20))?.session.reservationHeld).toBe(false);
  });
  it("preserves an in-flight generation across a transient observation failure", async () => {
    const f = providerFixture();
    await f.command("start", { kind: "start", aliases: ["web"] });
    f.failRead();
    await expect(f.reconcile(1)).rejects.toThrow();
    expect((await f.engine.status(f.identity))?.session.reservationHeld).toBe(true);
    expect((await f.reconcile())?.session.status).toBe("ready");
    expect(f.mutations.some((item) => item.startsWith("DELETE"))).toBe(false);
  });
  it("cancels a superseded deployment between stages and deploys the newer source", async () => {
    const f = providerFixture();
    f.refreshDuringPrepare();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const ready = await f.reconcile(20);
    expect(ready?.session.status).toBe("ready");
    expect(ready?.session.desiredRevision).toBe("f".repeat(40));
    expect(f.mutations.some((item) => item.startsWith("DELETE"))).toBe(false);
  });
  it("retries a convergent delete after observing that its uncertain request left resources", async () => {
    const f = providerFixture();
    await f.command("start", { kind: "start", aliases: ["web"] });
    await f.reconcile();
    await f.command("stop", { kind: "stop" });
    f.failDelete();
    await expect(f.reconcile(20)).rejects.toBeInstanceOf(NorthflankOutcomeUncertain);
    expect((await f.engine.status(f.identity))?.session.reservationHeld).toBe(true);
    expect((await f.reconcile(20))?.session.reservationHeld).toBe(false);
  });
  it("holds the reservation until an uncertain late blueprint create can be fenced and deleted", async () => {
    const f = providerFixture();
    f.delayBlueprint();
    await f.command("start", { kind: "start", aliases: ["web"] });
    await f.reconcile(1);
    await f.command("stop", { kind: "stop" });
    expect((await f.reconcile(10))?.session.reservationHeld).toBe(true);
    f.completeBlueprint();
    expect((await f.reconcile(20))?.session.reservationHeld).toBe(false);
  });
  it("releases a definitively rejected blueprint creation after complete absence checks", async () => {
    const f = providerFixture();
    f.rejectBlueprint();
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile(20))?.session.reservationHeld).toBe(false);
  });
  it("waits for a superseded native run before submitting the newer source", async () => {
    const f = providerFixture();
    f.holdPrepare();
    await f.command("start", { kind: "start", aliases: ["web"] });
    await f.reconcile(3);
    f.refreshSource();
    await f.command("refresh", { kind: "start", aliases: ["web"] });
    const before = f.mutations.length;
    await f.reconcile(3);
    expect(f.mutations.length).toBe(before);
    f.finishRuns();
    expect((await f.reconcile(20))?.session.status).toBe("ready");
  });
  it("keeps the earlier confirmed deadline when an extension reset is uncertain", async () => {
    const f = providerFixture();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const ready = await f.reconcile();
    f.failReset();
    await f.command("extend", { kind: "extend" });
    const unchanged = await f.reconcile(2);
    expect(unchanged?.session.status).toBe("ready");
    expect(unchanged?.session.expiresAt).toBe(ready?.session.expiresAt);
    expect(unchanged?.session.pendingDeadline).toBeUndefined();
    expect(f.mutations.some((item) => item.startsWith("DELETE"))).toBe(false);
  });
  it("compiles explicit command readiness for a worker with no routed port", () => {
    const { entry, policy } = graphFixture();
    entry.plan.resources.push({
      id: "worker",
      kind: "service",
      image: `example/worker@sha256:${"a".repeat(64)}`,
    });
    policy.resources.worker = {
      deploymentPlan: "nf-compute-10",
      readiness: { command: ["test", "-f", "/tmp/worker-ready"] },
    };
    const graph = compileNorthflankGraph(entry, policy, "prepare");
    expect(graph.spec.spec.steps.find((node) => node.ref === "r_worker")?.spec).toMatchObject({
      ports: [],
      healthChecks: [
        { protocol: "CMD", type: "readinessProbe", cmd: "'test' '-f' '/tmp/worker-ready'" },
      ],
    });
    policy.resources.worker.readiness = { command: ["${refs.r_db.id}"] };
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
  });
  it("accepts a spec recovered by read-back before waiting for a superseded run", async () => {
    const f = providerFixture();
    f.holdPrepare();
    f.loseSpecReceipt();
    await f.command("start", { kind: "start", aliases: ["web"] });
    await expect(f.reconcile(2)).rejects.toThrow();
    f.refreshSource();
    await f.command("refresh", { kind: "start", aliases: ["web"] });
    await f.reconcile(2);
    f.finishRuns();
    expect((await f.reconcile(20))?.session.status).toBe("ready");
  });
  it("releases a generation stopped before its first provider call", async () => {
    const f = providerFixture();
    f.stopBeforeDispatch();
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile(20))?.session.reservationHeld).toBe(false);
    expect(f.mutations).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { PreviewWriteGate } from "../engine";
import { createPreviewSession } from "../lifecycle";
import { NorthflankOwnershipStore } from "../providers/northflank";
import { NorthflankOutcomeUncertain, NorthflankPreviewAPI } from "../providers/northflank-api";
import { compileNorthflankGraph, type NorthflankGraphPolicy } from "../providers/northflank-graph";
import type { PreviewPoolEntry } from "../state";
import { type PreviewEffectStep, PreviewStateConflict, type PreviewStateStore } from "../state";

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
    await expect(api.request("GET", ["services"])).rejects.toThrow();
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

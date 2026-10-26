import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const COMMAND_FAILED = "Northflank service command failed.";

class SyntheticSocket {
  binaryType = "blob";
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(value: string) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(value);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: string | ArrayBuffer) {
    this.emit("message", { data });
  }

  closeEvent(code: number) {
    this.readyState = 3;
    this.emit("close", { code });
  }

  private emit(type: string, event: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function commandHarness(token = "synthetic-token") {
  let tokenCalls = 0;
  const sockets: SyntheticSocket[] = [];
  const urls: string[] = [];
  const api = new NorthflankPreviewAPI({
    projectId: "isolated",
    accessToken: async () => {
      tokenCalls += 1;
      return token;
    },
    websocketFactory: (url) => {
      urls.push(url);
      const socket = new SyntheticSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { api, sockets, urls, tokenCalls: () => tokenCalls };
}

async function startCommand(
  harness: ReturnType<typeof commandHarness>,
  bounds = { maxBytes: 64, timeoutMs: 1000 },
  argv = ["node", "-e", "console.log('ok')"],
) {
  const pending = harness.api.execServiceCommand("worker", argv, bounds);
  for (let attempt = 0; attempt < 4 && !harness.sockets[0]; attempt += 1) await Promise.resolve();
  const socket = harness.sockets[0];
  if (!socket) throw new Error("socket was not created");
  return { pending, socket };
}

function authenticate(socket: SyntheticSocket) {
  socket.open();
  socket.message(JSON.stringify({ type: "init", data: { auth: "successful" } }));
}

async function expectFixedFailure(pending: Promise<string>) {
  await expect(pending).rejects.toMatchObject({ message: COMMAND_FAILED });
}

describe("Northflank native command execution", () => {
  afterEach(() => vi.useRealTimers());
  it("uses the exact service URL, waits for close, and returns only bounded stdout", async () => {
    const harness = commandHarness();
    const { pending, socket } = await startCommand(harness, { maxBytes: 64, timeoutMs: 1000 }, [
      "node",
      "-e",
      "console.log('ok')",
      "",
    ]);
    expect(harness.urls).toEqual([
      "wss://api.northflank.com/v1/command-exec/projects/isolated/services/worker",
    ]);
    expect(harness.tokenCalls()).toBe(1);

    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "init",
      data: {
        auth: { type: "apiToken", apiToken: "synthetic-token" },
        context: {
          command: ["node", "-e", "console.log('ok')", ""],
          shell: "none",
          tty: false,
        },
      },
    });
    socket.message(JSON.stringify({ type: "init", data: { auth: "successful" } }));
    socket.message(JSON.stringify({ type: "stdOut", data: "hel" }));
    socket.message(JSON.stringify({ type: "stdErr", data: "diagnostic" }));
    socket.message(
      JSON.stringify({
        type: "completion",
        data: { exitCode: 0, status: "Success" },
      }),
    );
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "stdOut", data: "lo" }));
    socket.message(bytes.buffer as ArrayBuffer);

    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(socket.closeCalls).toBe(0);

    socket.closeEvent(1000);
    await expect(pending).resolves.toBe("hello");
    expect(harness.urls).toHaveLength(1);
  });

  it("rejects invalid command requests before retrieving a token or opening a socket", async () => {
    const harness = commandHarness();
    const bounds = { maxBytes: 64, timeoutMs: 1000 };
    await expect(
      harness.api.execServiceCommand("../foreign", ["ok"], bounds),
    ).rejects.toMatchObject({ message: "Invalid Northflank service command request." });
    await expect(harness.api.execServiceCommand("worker", [], bounds)).rejects.toMatchObject({
      message: "Invalid Northflank service command request.",
    });
    await expect(
      harness.api.execServiceCommand("worker", ["", "arg"], bounds),
    ).rejects.toMatchObject({ message: "Invalid Northflank service command request." });
    await expect(
      harness.api.execServiceCommand("worker", Array(33).fill("arg"), bounds),
    ).rejects.toMatchObject({ message: "Invalid Northflank service command request." });
    await expect(
      harness.api.execServiceCommand("worker", ["a".repeat(4097)], bounds),
    ).rejects.toMatchObject({ message: "Invalid Northflank service command request." });
    await expect(harness.api.execServiceCommand("worker", ["a\0b"], bounds)).rejects.toMatchObject({
      message: "Invalid Northflank service command request.",
    });
    await expect(
      harness.api.execServiceCommand("worker", Array(5).fill("a".repeat(4096)), bounds),
    ).rejects.toMatchObject({ message: "Invalid Northflank service command request." });
    await expect(
      harness.api.execServiceCommand("worker", ["ok"], {
        maxBytes: 8193,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ message: "Invalid Northflank service command request." });
    await expect(
      harness.api.execServiceCommand("worker", ["ok"], {
        maxBytes: 64,
        timeoutMs: 20_001,
      }),
    ).rejects.toMatchObject({ message: "Invalid Northflank service command request." });
    expect(harness.tokenCalls()).toBe(0);
    expect(harness.sockets).toHaveLength(0);
    expect(harness.urls).toHaveLength(0);
  });

  it("keeps token retrieval failures generic without opening a socket", async () => {
    let socketCalls = 0;
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => {
        throw new Error("token-sentinel");
      },
      websocketFactory: () => {
        socketCalls += 1;
        return new SyntheticSocket() as unknown as WebSocket;
      },
    });
    await expectFixedFailure(
      api.execServiceCommand("worker", ["ok"], {
        maxBytes: 64,
        timeoutMs: 1000,
      }),
    );
    expect(socketCalls).toBe(0);
  });

  it.each([
    [
      "authentication failure",
      (socket: SyntheticSocket) => {
        socket.open();
        socket.message(JSON.stringify({ type: "init", data: { auth: "rejected" } }));
      },
    ],
    [
      "malformed frame",
      (socket: SyntheticSocket) => {
        authenticate(socket);
        socket.message("{");
      },
    ],
    [
      "oversized raw frame",
      (socket: SyntheticSocket) => {
        socket.open();
        socket.message(
          JSON.stringify({
            type: "init",
            data: { auth: "successful" },
            padding: "a".repeat(16 * 1024),
          }),
        );
      },
    ],
    [
      "provider error",
      (socket: SyntheticSocket) => {
        authenticate(socket);
        socket.message(JSON.stringify({ type: "error", data: "remote-sentinel" }));
      },
    ],
    [
      "nonzero completion",
      (socket: SyntheticSocket) => {
        authenticate(socket);
        socket.message(
          JSON.stringify({
            type: "completion",
            data: { exitCode: 2, status: "Failure" },
          }),
        );
      },
    ],
    [
      "unknown completion",
      (socket: SyntheticSocket) => {
        authenticate(socket);
        socket.message(
          JSON.stringify({
            type: "completion",
            data: { exitCode: 0, status: "Unknown" },
          }),
        );
      },
    ],
    [
      "missing completion",
      (socket: SyntheticSocket) => {
        authenticate(socket);
        socket.closeEvent(1000);
      },
    ],
    [
      "abnormal close",
      (socket: SyntheticSocket) => {
        authenticate(socket);
        socket.message(
          JSON.stringify({
            type: "completion",
            data: { exitCode: 0, status: "Success" },
          }),
        );
        socket.closeEvent(1006);
      },
    ],
  ])("fails generically for %s without retrying", async (_name, act) => {
    vi.useFakeTimers();
    const harness = commandHarness();
    const { pending, socket } = await startCommand(harness);
    act(socket);
    await expectFixedFailure(pending);
    expect(harness.urls).toHaveLength(1);
  });

  it("counts discarded stderr against the output budget", async () => {
    vi.useFakeTimers();
    const harness = commandHarness();
    const { pending, socket } = await startCommand(harness, {
      maxBytes: 5,
      timeoutMs: 1000,
    });
    authenticate(socket);
    socket.message(JSON.stringify({ type: "stdOut", data: "ok" }));
    socket.message(JSON.stringify({ type: "stdErr", data: "no" }));
    socket.message(JSON.stringify({ type: "stdOut", data: "!" }));
    socket.message(JSON.stringify({ type: "stdErr", data: "x" }));
    await expectFixedFailure(pending);
    expect(socket.closeCalls).toBe(1);
    expect(harness.urls).toHaveLength(1);
  });

  it("bounds total protocol bytes even when each valid frame is small", async () => {
    vi.useFakeTimers();
    const harness = commandHarness();
    const { pending, socket } = await startCommand(harness);
    authenticate(socket);
    const frame = JSON.stringify({ type: "stdOut", data: "", padding: "a".repeat(1024) });
    for (let count = 0; count < 65; count += 1) socket.message(frame);
    await expectFixedFailure(pending);
    expect(socket.closeCalls).toBe(1);
    expect(harness.urls).toHaveLength(1);
  });

  it("times out once and closes without retrying", async () => {
    const harness = commandHarness();
    const { pending, socket } = await startCommand(harness, {
      maxBytes: 64,
      timeoutMs: 5,
    });
    authenticate(socket);
    socket.message(JSON.stringify({ type: "stdOut", data: "partial" }));
    await expectFixedFailure(pending);
    expect(socket.closeCalls).toBe(1);
    expect(harness.urls).toHaveLength(1);
  });
});

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

function buildGraphFixture() {
  const { entry, policy } = graphFixture();
  const web = Object.assign(entry.plan.resources[2], {
    build: { context: ".", dockerfile: "Dockerfile" },
  });
  delete web.image;
  policy.git = { url: "https://github.com/example/fixture", type: "github", branch: "main" };
  policy.resources.web.buildPlan = "nf-compute-200";
  return { entry, policy, web };
}

function secretGraphFixture() {
  const { entry, policy } = graphFixture();
  entry.plan.resources.push({
    id: "worker",
    kind: "service",
    dependsOn: ["web"],
    image: `example/worker@sha256:${"0".repeat(64)}`,
  });
  policy.resources.worker = {
    deploymentPlan: "nf-compute-10",
    readiness: { command: ["node", "--version"] },
    environment: {
      HATCHET_TOKEN: { output: "hatchet-token" },
      DATABASE_PASSWORD: { generated: "database-password" },
    },
  };
  policy.generated = {
    "database-password": { bytes: 32, encoding: "base64url" },
  };
  policy.outputs = {
    "hatchet-token": {
      service: "web",
      command: ["node", "-e", "process.stdout.write('synthetic-token')"],
      pattern: "^[A-Za-z0-9._-]{16,8000}$",
      maxBytes: 8000,
    },
  };
  const web = entry.plan.resources[2]!;
  const worker = entry.plan.resources[3]!;
  return { entry, policy, web, worker };
}

function ownedGraph(entry: PreviewPoolEntry) {
  return {
    resources: Object.fromEntries(
      entry.plan.resources.map((resource) => [
        `r_${resource.id.replaceAll("-", "_")}`,
        `owned-${resource.id}`,
      ]),
    ),
    domains: [],
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
      healthChecks: [{ protocol: "HTTP", successThreshold: 1 }],
      ports: [
        {
          public: false,
          security: { policies: [{ action: "ALLOW", addresses: ["192.0.2.0/24"] }] },
        },
      ],
    });
    expect(steps.find((node) => node.kind === "Job")?.spec).toMatchObject({
      settings: { runOnSourceChange: "never", backoffLimit: 0, activeDeadlineSeconds: 600 },
    });
    expect(steps.some((node) => node.kind === "JobRun")).toBe(false);
    expect(graph.sourceResources).toEqual([]);
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
    const { entry, policy } = buildGraphFixture();
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
    const { entry, policy, web } = buildGraphFixture();
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
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    policy.resources.web.readiness = { command: ["node", "--version"] };
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
    const { entry, policy, web } = buildGraphFixture();
    const job = entry.plan.resources[1];
    job.build = { context: ".", dockerfile: "Dockerfile" };
    delete job.image;
    policy.resources.seed.buildPlan = "nf-compute-200";
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
    const builds = graph.spec.spec.steps.filter((node) => node.kind === "Build");
    expect(builds).toHaveLength(2);
    for (const build of builds)
      expect(build).toMatchObject({
        spec: { branch: "main", sha: entry.plan.source!.head },
        condition: "success",
      });
    for (const source of graph.spec.spec.steps.filter((node) => node.kind === "BuildService")) {
      const vcsData = (source.spec as Record<string, any>).vcsData;
      expect(vcsData).toMatchObject({
        projectUrl: "https://github.com/example/fixture",
        projectType: "github",
      });
      expect(vcsData).not.toHaveProperty("projectBranch");
    }
    for (const ref of ["r_seed", "r_web"]) {
      expect(graph.spec.spec.steps.find((node) => node.ref === ref)?.spec).toMatchObject({
        deployment: {
          internal: { branch: "main", buildSHA: entry.plan.source!.head },
        },
      });
    }
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

  it("binds generated and output names and activates only the source dependency closure", () => {
    const { entry, policy } = secretGraphFixture();
    const owned = ownedGraph(entry);
    expect(() => compileNorthflankGraph(entry, policy, "source")).toThrow();
    const prepared = compileNorthflankGraph(entry, policy, "prepare");
    const source = compileNorthflankGraph(entry, policy, "source", owned);
    const activated = compileNorthflankGraph(entry, policy, "activate", owned);
    const sourceJob = source.spec.spec.steps.find((node) => node.kind === "JobRun");
    const activeJob = activated.spec.spec.steps.find((node) => node.kind === "JobRun");

    expect(prepared.sourceResources).toEqual(["db", "seed", "web"]);
    expect(source.sourceResources).toEqual(["db", "seed", "web"]);
    expect(sourceJob).toEqual(activeJob);
    expect(sourceJob).toMatchObject({
      ref: "init_seed",
      runNodeOnce: "true",
      condition: "success",
    });
    expect(source.spec.spec.steps.filter((node) => node.kind === "JobRun")).toHaveLength(1);
    expect(source.spec.spec.steps.some((node) => node.ref === "activate_web")).toBe(true);
    expect(source.spec.spec.steps.some((node) => node.ref === "activate_worker")).toBe(false);
    expect(activated.spec.spec.steps.some((node) => node.ref === "activate_worker")).toBe(true);
    expect(prepared.secretBindings).toEqual([
      {
        groupRef: "e_web",
        variables: { API_KEY: { runtimeSecret: "synthetic-upstream" } },
      },
      {
        groupRef: "e_worker",
        variables: {
          HATCHET_TOKEN: { output: "hatchet-token" },
          DATABASE_PASSWORD: { generated: "database-password" },
        },
      },
    ]);
    expect(prepared.runtimeSecrets).toEqual([
      { groupRef: "e_web", variables: { API_KEY: "synthetic-upstream" } },
    ]);
    const workerGroup = prepared.spec.spec.steps.find((node) => node.ref === "e_worker");
    expect(workerGroup?.spec).toMatchObject({
      restrictions: { restricted: true, nfObjects: [{ type: "service" }] },
      secrets: { variables: {} },
    });
  });

  it("refuses undeclared, unselected, cyclic and externally bound sensitive sources", () => {
    let fixture = secretGraphFixture();
    fixture.policy.outputs!["hatchet-token"]!.service = "missing";
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    delete fixture.policy.resources.web;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    fixture.policy.resources.worker.environment!.MISSING = { generated: "not-declared" };
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    fixture.policy.resources.worker.environment!.MISSING = { output: "not-declared" };
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    fixture.policy.outputs!["hatchet-token"]!.service = "seed";
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    const worker = fixture.entry.plan.resources.pop()!;
    worker.dependsOn = [];
    fixture.entry.plan.resources.splice(2, 0, worker);
    const sourceService = fixture.entry.plan.resources[3]!;
    sourceService.dependsOn = ["seed", "worker"];
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    fixture.entry.plan.resources.push({
      id: "external",
      kind: "service",
      image: `example/external@sha256:${"0".repeat(64)}`,
      ports: [{ name: "http", port: 8080, public: false }],
    });
    fixture.policy.resources.external = {
      deploymentPlan: "nf-compute-10",
      readiness: { port: "http", path: "/health" },
    };
    fixture.policy.resources.web.environment!.EXTERNAL = {
      service: "external",
      port: "http",
      format: "http-url",
    };
    expect(() =>
      compileNorthflankGraph(fixture.entry, fixture.policy, "source", ownedGraph(fixture.entry)),
    ).toThrow();
    delete fixture.policy.resources.web.environment!.EXTERNAL;
    fixture.policy.resources.web.publicBuildEnvironment = {
      CONFIG: {
        json: {
          EXTERNAL: { service: "external", port: "http", format: "http-url" },
        },
      },
    };
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();
  });

  it("resolves output sources only for selected consumers and accepts source-built services", () => {
    const { entry, policy } = secretGraphFixture();
    policy.outputs!.unused = {
      service: "unselected",
      command: ["token"],
      pattern: "^[a-f0-9]{32}$",
      maxBytes: 32,
    };
    const web = entry.plan.resources.find((resource) => resource.id === "web")!;
    delete web.image;
    web.build = { context: ".", dockerfile: "Dockerfile" };
    policy.git = { url: "https://github.com/example/fixture", type: "github", branch: "main" };
    policy.resources.web.buildPlan = "nf-compute-200";
    const source = compileNorthflankGraph(entry, policy, "source", ownedGraph(entry));
    expect(source.sourceResources).toEqual(["db", "seed", "web"]);
    expect(source.spec.spec.steps.some((node) => node.kind === "Build")).toBe(true);
  });

  it("bounds generated and output declarations, commands and secret recipients", () => {
    let fixture = secretGraphFixture();
    fixture.policy.generated!["database-password"]!.encoding = "hex";
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).not.toThrow();

    fixture = secretGraphFixture();
    fixture.policy.generated!["database-password"]!.bytes = 15;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    fixture.policy.generated!["database-password"]!.bytes = 65;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    fixture.policy.generated!["database-password"]!.encoding = "raw" as never;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    (fixture.policy.generated!["database-password"] as never as Record<string, unknown>).extra =
      true;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    for (const name of ["Database-Password", "bad_name", "a".repeat(49)]) {
      fixture = secretGraphFixture();
      fixture.policy.generated = {
        [name]: { bytes: 32, encoding: "hex" },
      };
      fixture.policy.resources.worker.environment!.DATABASE_PASSWORD = { generated: name };
      expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();
    }

    fixture = secretGraphFixture();
    Object.assign(
      fixture.policy.generated!,
      Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `generated-${index}`,
          { bytes: 16, encoding: "hex" },
        ]),
      ),
    );
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).not.toThrow();
    fixture.policy.generated!.overflow = { bytes: 16, encoding: "hex" };
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    Object.assign(
      fixture.policy.outputs!,
      Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [
          `output-${index}`,
          { service: "web", command: ["token"], pattern: "^[A-Fa-f0-9]{32}$", maxBytes: 32 },
        ]),
      ),
    );
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).not.toThrow();
    fixture.policy.outputs!.overflow = {
      service: "web",
      command: ["token"],
      pattern: "^[A-Fa-f0-9]{32}$",
      maxBytes: 32,
    };
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    for (const command of [
      [],
      Array(33).fill("argument"),
      [""],
      ["a".repeat(4097)],
      Array(5).fill("a".repeat(4096)),
    ]) {
      fixture = secretGraphFixture();
      fixture.policy.outputs!["hatchet-token"]!.command = command;
      expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();
    }
    for (const maxBytes of [0, 8001]) {
      fixture = secretGraphFixture();
      fixture.policy.outputs!["hatchet-token"]!.maxBytes = maxBytes;
      expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();
    }
    fixture = secretGraphFixture();
    (fixture.policy.outputs!["hatchet-token"] as never as Record<string, unknown>).timeoutMs =
      20_000;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    const { entry, policy } = graphFixture();
    for (let index = 0; index < 31; index += 1) {
      const id = `worker-${index}`;
      entry.plan.resources.push({
        id,
        kind: "service",
        image: `example/worker@sha256:${"0".repeat(64)}`,
      });
      policy.resources[id] = {
        deploymentPlan: "nf-compute-10",
        readiness: { command: ["node", "--version"] },
        environment: { TOKEN: { runtimeSecret: "synthetic-upstream" } },
      };
    }
    policy.resources.seed.environment = { TOKEN: { runtimeSecret: "synthetic-upstream" } };
    policy.resources.web.environment!.TOKEN = { runtimeSecret: "synthetic-upstream" };
    expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
  });

  it("requires exact discriminants, safe output patterns and non-public sensitive bindings", () => {
    for (const pattern of [
      "^[A-Za-z0-9._-]{16,8000}$",
      "^[A-Za-z0-9+/=_-]{16,8000}$",
      "^[A-Fa-f0-9]{32}$",
    ]) {
      const { entry, policy } = secretGraphFixture();
      policy.outputs!["hatchet-token"]!.pattern = pattern;
      expect(() => compileNorthflankGraph(entry, policy, "prepare")).not.toThrow();
    }
    for (const pattern of [
      "[A-Za-z0-9._-]{16,8000}",
      "^[^A-Za-z0-9._-]{16,8000}$",
      "^.*$",
      "^([A-Za-z0-9._-]){16,8000}$",
      "^[A-Za-z0-9._-]+$",
      "^[A-Za-z0-9._-]{16,8000}$/g",
      "^[A-Za-z0-9._-]{0,16}$",
      "^[A-Za-z0-9._-]{16,15}$",
      "^[A-Za-z0-9._-]{8000,8001}$",
      `^[${"A".repeat(128)}]{1,16}$`,
    ]) {
      const { entry, policy } = secretGraphFixture();
      policy.outputs!["hatchet-token"]!.pattern = pattern;
      expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    }

    for (const binding of [
      { generated: "database-password", extra: true },
      { generated: "database-password", output: "hatchet-token" },
      { output: "hatchet-token", literal: "x" },
      { runtimeSecret: "synthetic-upstream", extra: true },
      { literal: "x", generated: "database-password" },
    ]) {
      const { entry, policy } = secretGraphFixture();
      policy.resources.worker.environment!.MALFORMED = binding as never;
      expect(() => compileNorthflankGraph(entry, policy, "prepare")).toThrow();
    }

    let fixture = secretGraphFixture();
    fixture.policy.resources.web.publicBuildEnvironment = {
      TOKEN: { generated: "database-password" },
    } as never;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();

    fixture = secretGraphFixture();
    fixture.policy.resources.web.publicBuildEnvironment = {
      CONFIG: { json: { TOKEN: { output: "hatchet-token" } } },
    } as never;
    expect(() => compileNorthflankGraph(fixture.entry, fixture.policy, "prepare")).toThrow();
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
    await ownership.update((current) => ({ ...current, delivered: ["g:password", "o:token"] }));
    await expect(
      ownership.update((current) => ({ ...current, delivered: ["o:token"] })),
    ).rejects.toThrow();
    await expect(
      ownership.update((current) => ({ ...current, delivered: ["o:token", "g:password"] })),
    ).rejects.toThrow();
    await expect(
      ownership.update((current) => ({ ...current, delivered: ["g:password", "g:password"] })),
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

function providerFixture(
  configure?: (entry: PreviewPoolEntry, policy: NorthflankGraphPolicy) => void,
) {
  const { entry, policy } = graphFixture();
  configure?.(entry, policy);
  const policyDigest = createHash("sha256")
    .update(JSON.stringify({ project: "fixture", graph: policy }))
    .digest("hex");
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
  let partialPrepareFailure = false;
  let skipUnchanged = false;
  let unavailableRunReadback = false;
  let missingSecret = false;
  let secretReads = 0;
  let loseSecretPatch = false;
  let wipeAtActivate = false;
  let wipeAtSource = false;
  let sourceWithoutGeneratedMarker = false;
  let forgeOutputSource = false;
  let refreshDuringOutput = false;
  let outputValue = "abcdef0123456789".repeat(2);
  const outputCalls: Array<{ id: string; argv: string[] }> = [];
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
        if (tail[0] === "secrets" && method === "GET") secretReads += 1;
        if (!row) return new Response(null, { status: 404 });
        if (
          forgeOutputSource &&
          tail[0] === "services" &&
          row.name ===
            [...allocations.values()].find(
              (item) => item.kind === "secrets" && item.secrets.variables.API_KEY,
            )?.restrictions.nfObjects[0].id
        )
          return response({ ...row, uid: "f".repeat(24) });
        if (method === "PATCH") {
          row.patch = body;
          if (tail[0] === "secrets") {
            row.secrets.variables = body.secrets.variables;
            if (loseSecretPatch) {
              loseSecretPatch = false;
              throw new Error("synthetic lost secret receipt");
            }
          }
        }
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
            method === "DELETE"
              ? []
              : [...new Set([...runs.values()].map((run) => run.environmentId))].map((id) => ({
                  id,
                })),
        });
      }
      if (tail[2] === "runs") {
        if (method === "POST" && tail.length === 3) {
          const id = `run-${runs.size}`;
          const spec = structuredClone(blueprint.spec);
          const refs: Record<string, unknown> = {};
          const operation = body.arguments?.devrouterOperation ?? "";
          if (wipeAtActivate && String(operation).startsWith("activate-")) {
            wipeAtActivate = false;
            for (const group of allocations.values())
              if (group.kind === "secrets") group.secrets.variables = {};
          }
          if (String(operation).startsWith("source-")) {
            const owned = records.get(`installations/fixture/northflank/${body.name.slice(8)}`)
              ?.value as { delivered?: string[] } | undefined;
            sourceWithoutGeneratedMarker ||= !owned?.delivered?.includes("g:password");
            if (wipeAtSource) {
              wipeAtSource = false;
              for (const group of allocations.values())
                if (group.kind === "secrets") group.secrets.variables = {};
            }
          }
          const partialPrepare = partialPrepareFailure && String(operation).startsWith("prepare-");
          const skipped = skipUnchanged && /^(prepare|activate)-/.test(String(operation));
          let refCount = 0;
          for (const node of spec.spec.steps) {
            const kind: Record<string, string> = {
              Addon: "addons",
              DeploymentService: "services",
              BuildService: "services",
              Job: "jobs",
              Volume: "volumes",
              SecretGroup: "secrets",
            };
            let refId: string | undefined;
            if (node.kind === "Subdomain") {
              domains.set(node.spec.name, `${node.spec.name}.${policy.baseDomain}`);
              refId = node.spec.name;
            } else if (kind[node.kind]) {
              const native = node.spec.name;
              const row = allocations.get(native) ?? {
                id: native,
                name: native,
                uid: "a".repeat(24),
                kind: kind[node.kind],
              };
              if (!allocations.has(native) || node.updateMode !== "create") {
                const nativeSpec = JSON.parse(
                  JSON.stringify(node.spec).replace(
                    /\$\{refs\.([a-z0-9_]+)\.id\}/g,
                    (_match, reference) => {
                      const sourceNode = spec.spec.steps.find(
                        (item: any) => item.ref === reference,
                      );
                      return sourceNode?.spec.name ?? "unresolved";
                    },
                  ),
                );
                Object.assign(row, nativeSpec);
              }
              allocations.set(native, row);
              refId = native;
            }
            if (refId) {
              if (skipped) {
                refs[node.ref] = { status: "skipped" };
              } else if (!partialPrepare || refCount === 0) {
                refs[node.ref] = { status: "success", data: { id: refId } };
              } else if (refCount === 1) {
                refs[node.ref] = { status: "failed", data: { id: refId } };
              } else {
                refs[node.ref] = { status: "success" };
              }
              refCount += 1;
            }
          }
          const row = {
            id,
            name: body.name,
            arguments: body.arguments ?? {},
            spec,
            refs,
            environmentId: body.name,
            concluded: !(
              (pendingBootstrap && String(operation).startsWith("bootstrap-")) ||
              (pendingPrepare && String(operation).startsWith("prepare-"))
            ),
            status: partialPrepare ? "failed" : skipped ? "skipped" : "success",
          };
          runs.set(id, row);
          if (partialPrepare) partialPrepareFailure = false;
          if (lostRun) {
            lostRun = false;
            if (unavailableRunReadback) {
              failRead = true;
              unavailableRunReadback = false;
            }
            throw new Error("synthetic lost response");
          }
          return response(row);
        }
        if (tail.length === 3)
          return response({
            runs: [...runs.values()].map(({ id, environmentId, concluded, status }) => ({
              id,
              environmentId,
              concluded,
              status,
            })),
          });
        if (failRead) {
          failRead = false;
          throw new Error("synthetic read unavailable");
        }
        const row = runs.get(tail[3]);
        if (refreshDuringPrepare && row?.arguments.devrouterOperation?.startsWith("prepare-")) {
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
  api.execServiceCommand = async (id, argv) => {
    outputCalls.push({ id, argv });
    if (refreshDuringOutput) {
      refreshDuringOutput = false;
      desiredPlan = structuredClone(entry.plan);
      desiredPlan.source!.head = "f".repeat(40);
      await command("refresh-during-output", { kind: "start", aliases: ["web"] });
    }
    return `${outputValue}\n`;
  };
  const qualification = {
    outputExec: true,
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
    store,
    records,
    outputCalls,
    secretReads: () => secretReads,
    outputValue: (value: string) => {
      outputValue = value;
    },
    loseSecretPatch: () => {
      loseSecretPatch = true;
    },
    wipeAtActivate: () => {
      wipeAtActivate = true;
    },
    wipeAtSource: () => {
      wipeAtSource = true;
    },
    sourceWithoutGeneratedMarker: () => sourceWithoutGeneratedMarker,
    refreshDuringOutput: () => {
      refreshDuringOutput = true;
    },
    forgeOutputSource: () => {
      forgeOutputSource = true;
    },
    policyDigest,
    qualification,
    command,
    reconcile,
    mutations,
    allocations,
    runs,
    engine,
    identity,
    loseRun: (unavailableReadback = false) => {
      lostRun = true;
      unavailableRunReadback = unavailableReadback;
    },
    partialPrepare: () => {
      partialPrepareFailure = true;
    },
    skipUnchanged: () => {
      skipUnchanged = true;
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

function credentialProviderFixture(outputs = true) {
  return providerFixture((entry, policy) => {
    policy.generated = { password: { bytes: 32, encoding: "hex" } };
    policy.resources.seed.environment = { PASSWORD: { generated: "password" } };
    policy.resources.web.environment!.PASSWORD = { generated: "password" };
    if (outputs) {
      entry.plan.resources.push({
        id: "consumer",
        kind: "service",
        dependsOn: ["web"],
        image: `example/consumer@sha256:${"0".repeat(64)}`,
      });
      policy.outputs = {
        token: {
          service: "web",
          command: ["cat", "/config/token"],
          pattern: "^[a-f0-9]{32}$",
          maxBytes: 32,
        },
      };
      policy.resources.consumer = {
        deploymentPlan: "nf-compute-10",
        readiness: { command: ["test", "-s", "/ready"] },
        environment: { PASSWORD: { generated: "password" }, TOKEN: { output: "token" } },
      };
    }
  });
}

describe("Northflank generation credential delivery", () => {
  it("persists one generation value, reuses it on refresh, and keeps values outside controller state", async () => {
    const f = credentialProviderFixture();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const ready = await f.reconcile(12);
    expect(ready?.session.status).toBe("ready");
    const groups = [...f.allocations.values()].filter((item) => item.kind === "secrets");
    const password = groups[0].secrets.variables.PASSWORD;
    expect(password).toMatch(/^[a-f0-9]{64}$/);
    expect(groups.every((group) => group.secrets.variables.PASSWORD === password)).toBe(true);
    expect(f.outputCalls).toHaveLength(1);
    expect(f.sourceWithoutGeneratedMarker()).toBe(false);
    expect(f.outputCalls[0].argv).toEqual(["cat", "/config/token"]);
    const consumer = groups.find((group) => group.secrets.variables.TOKEN)!;
    expect(consumer.secrets.variables.TOKEN).toBe("abcdef0123456789".repeat(2));
    const saved = JSON.stringify([...f.records.values()]);
    expect(saved).not.toContain(password);
    expect(saved).not.toContain(consumer.secrets.variables.TOKEN);
    expect(saved).not.toContain("test-value");
    const patches = f.mutations.filter((item) => item.startsWith("PATCH secrets/")).length;
    f.refreshSource();
    await f.command("refresh", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile(12))?.session.status).toBe("ready");
    expect(f.outputCalls).toHaveLength(2);
    expect(f.mutations.filter((item) => item.startsWith("PATCH secrets/"))).toHaveLength(patches);
    expect(
      [...f.allocations.values()]
        .filter((item) => item.kind === "secrets")
        .every((group) => group.secrets.variables.PASSWORD === password),
    ).toBe(true);
    const reads = f.secretReads();
    await f.command("extend", { kind: "extend", hours: 1 });
    await f.reconcile();
    expect(f.secretReads()).toBe(reads);
    expect(f.outputCalls).toHaveLength(2);
    await f.command("stop", { kind: "stop" });
    await f.reconcile();
    f.advance(1);
    await f.command("restart", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile(12))?.session.status).toBe("ready");
    const next = [...f.allocations.values()].find((item) => item.kind === "secrets")!.secrets
      .variables.PASSWORD;
    expect(next).not.toBe(password);
  });

  it("cancels an output read superseded before any write without tearing down the generation", async () => {
    const f = credentialProviderFixture();
    f.refreshDuringOutput();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const ready = await f.reconcile(20);
    expect(ready?.session.status).toBe("ready");
    expect(ready?.session.desiredRevision).toBe("f".repeat(40));
    expect(f.mutations.some((mutation) => mutation.startsWith("DELETE"))).toBe(false);
    expect(f.outputCalls).toHaveLength(2);
  });

  it("counts retained deselected services before the first native effect write", async () => {
    for (const count of [132, 133]) {
      const f = credentialProviderFixture(false);
      await f.command("start", { kind: "start", aliases: ["web"] });
      const entry = await f.reconcile();
      expect(entry?.session.status).toBe("ready");
      const row = f.records.get(`installations/fixture/northflank/${entry!.session.generation}`)!;
      const owned = row.value as { resources: unknown[] };
      owned.resources.push(
        ...Array.from({ length: count }, (_, index) => ({
          reference: `r_old_${index}`,
          kind: "services",
          id: `old-${index}`,
          name: `old-${index}`,
          uid: "e".repeat(24),
        })),
      );
      const mutations = f.mutations.length;
      const gate: PreviewWriteGate = {
        read: async () => [],
        fenced: async () => true,
        begin: async () => {
          throw new Error("Unexpected write intent");
        },
        record: async () => {
          throw new Error("Unexpected write receipt");
        },
      };
      const receipt = await f.provider.observe(
        { id: "bound-check", kind: "deploy", generation: entry!.session.generation } as any,
        entry!,
        gate,
      );
      expect(receipt.outcome).toBe(count === 132 ? "cancelled" : "failed");
      expect(receipt.cleanupRequired === true).toBe(count === 133);
      expect(f.mutations).toHaveLength(mutations);
    }
  });

  it("bounds repeated output progress and verifies partial recipient adoption", async () => {
    const f = providerFixture((entry, policy) => {
      policy.generated = { password: { bytes: 32, encoding: "base64url" } };
      policy.resources.web.environment!.PASSWORD = { generated: "password" };
      entry.plan.resources.push({
        id: "consumer",
        kind: "service",
        dependsOn: ["web"],
        image: `example/consumer@sha256:${"0".repeat(64)}`,
      });
      policy.outputs = Object.fromEntries(
        ["token-one", "token-two"].map((name) => [
          name,
          {
            service: "web",
            command: ["cat", `/config/${name}`],
            pattern: "^[a-f0-9]{32}$",
            maxBytes: 32,
          },
        ]),
      );
      policy.resources.consumer = {
        deploymentPlan: "nf-compute-10",
        readiness: { command: ["true"] },
        environment: {
          PASSWORD: { generated: "password" },
          FIRST: { output: "token-one" },
          SECOND: { output: "token-two" },
        },
      };
    });
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile(15))?.session.status).toBe("ready");
    expect(f.outputCalls).toHaveLength(2);
    const groups = [...f.allocations.values()].filter((item) => item.kind === "secrets");
    expect(
      groups.every(
        (group) => group.secrets.variables.PASSWORD === groups[0].secrets.variables.PASSWORD,
      ),
    ).toBe(true);
    const consumer = groups.find((group) => group.secrets.variables.FIRST)!;
    expect(consumer.secrets.variables.SECOND).toBe(consumer.secrets.variables.FIRST);
  });

  it("refuses outputs unless the installed command has separate native qualification", async () => {
    const f = credentialProviderFixture();
    f.qualification.outputExec = false;
    await expect(f.command("start", { kind: "start", aliases: ["web"] })).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it("does not replay a secret write whose response was lost", async () => {
    const f = credentialProviderFixture(false);
    f.loseSecretPatch();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const state = await f.reconcile(3);
    expect(state?.session.status).not.toBe("ready");
    expect(f.mutations.filter((item) => item.startsWith("PATCH secrets/"))).toHaveLength(1);
    await f.reconcile(12);
    expect(f.allocations.size).toBe(0);
  });

  it("detects missing or disagreeing delivered values before refresh can rotate them", async () => {
    for (const mode of ["missing", "disagree"]) {
      const f = credentialProviderFixture(false);
      await f.command("start", { kind: "start", aliases: ["web"] });
      expect((await f.reconcile())?.session.status).toBe("ready");
      const groups = [...f.allocations.values()].filter((item) => item.kind === "secrets");
      if (mode === "missing") for (const group of groups) delete group.secrets.variables.PASSWORD;
      else groups[0].secrets.variables.PASSWORD = "a".repeat(64);
      const patches = f.mutations.filter((item) => item.startsWith("PATCH secrets/")).length;
      f.refreshSource();
      await f.command("refresh", { kind: "start", aliases: ["web"] });
      const state = await f.reconcile();
      expect(state?.session.status).not.toBe("ready");
      expect(f.mutations.filter((item) => item.startsWith("PATCH secrets/"))).toHaveLength(patches);
    }
  });

  it("fails closed after a source-stage credential wipe or source identity change", async () => {
    for (const scenario of ["wipe", "source-identity"]) {
      const f = credentialProviderFixture();
      if (scenario === "wipe") f.wipeAtSource();
      else f.forgeOutputSource();
      await f.command("start", { kind: "start", aliases: ["web"] });
      expect((await f.reconcile(12))?.session.status).not.toBe("ready");
      expect(f.sourceWithoutGeneratedMarker()).toBe(false);
      if (scenario === "source-identity") expect(f.outputCalls).toHaveLength(0);
    }
  });

  it("rejects changed or malformed output before delivering it and detects a final group wipe", async () => {
    for (const value of ["bad value", "fedcba9876543210".repeat(2)]) {
      const f = credentialProviderFixture();
      await f.command("start", { kind: "start", aliases: ["web"] });
      expect((await f.reconcile(12))?.session.status).toBe("ready");
      const patches = f.mutations.filter((item) => item.startsWith("PATCH secrets/")).length;
      f.outputValue(value);
      f.refreshSource();
      await f.command("refresh", { kind: "start", aliases: ["web"] });
      expect((await f.reconcile(12))?.session.status).not.toBe("ready");
      expect(f.mutations.filter((item) => item.startsWith("PATCH secrets/"))).toHaveLength(patches);
      expect(JSON.stringify([...f.records.values()])).not.toContain(value);
    }
    const f = credentialProviderFixture(false);
    f.wipeAtActivate();
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile())?.session.status).not.toBe("ready");
  });
});

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
  it("keeps bootstrap, activation and explicit refresh in the same native environment", async () => {
    const f = providerFixture();
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile())?.session.status).toBe("ready");
    f.refreshSource();
    await f.command("refresh", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile())?.session.status).toBe("ready");
    const runs = [...f.runs.values()];
    expect(runs.length).toBeGreaterThan(3);
    expect(new Set(runs.map((run) => run.environmentId)).size).toBe(1);
    expect(new Set(runs.map((run) => run.arguments.devrouterOperation)).size).toBe(runs.length);
  });
  it("retains its generation when preparation and activation nodes are all skipped", async () => {
    const f = providerFixture();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const initial = await f.reconcile();
    expect(initial?.session.status).toBe("ready");
    f.refreshSource();
    f.skipUnchanged();
    await f.command("refresh", { kind: "start", aliases: ["web"] });
    const refreshed = await f.reconcile();
    expect(refreshed?.session.status).toBe("ready");
    expect(refreshed?.session.generation).toBe(initial?.session.generation);
    expect([...f.runs.values()].filter((run) => run.status === "skipped")).toHaveLength(2);
    expect(f.mutations.some((item) => item.startsWith("DELETE"))).toBe(false);
  });
  it("recovers a lost once-only run response without posting another bootstrap run", async () => {
    const f = providerFixture();
    f.loseRun();
    await f.command("start", { kind: "start", aliases: ["web"] });
    expect((await f.reconcile())?.session.status).toBe("ready");
    expect(
      [...f.runs.values()].filter((run) =>
        run.arguments.devrouterOperation?.startsWith("bootstrap-"),
      ).length,
    ).toBe(1);
  });
  it("captures only successful resources from a partially failed prepare run", async () => {
    const f = providerFixture();
    f.partialPrepare();
    await f.command("start", { kind: "start", aliases: ["web"] });
    let prepared: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 10 && !prepared; attempt += 1) {
      await f.reconcile(1);
      prepared = [...f.runs.values()].find((run) =>
        run.arguments.devrouterOperation?.startsWith("prepare-"),
      );
    }
    expect(prepared?.status).toBe("failed");
    const refs = Object.values(prepared!.refs) as Record<string, unknown>[];
    const successful = refs.filter((ref) => ref.status === "success" && ref.data);
    expect(successful).toHaveLength(1);
    expect(refs.slice(1).some((ref) => ref.status === "failed" && ref.data)).toBe(true);
    expect(refs.slice(1).some((ref) => ref.status === "success" && !("data" in ref))).toBe(true);
    const generation = (await f.engine.status(f.identity))!.session.generation;
    const ownership = new NorthflankOwnershipStore({
      store: f.store,
      installationId: "fixture",
      generation,
      policyDigest: f.policyDigest,
    });
    const owned = (await ownership.read())!;
    expect(
      owned.resources
        .filter((resource) => resource.kind !== "domains")
        .map((resource) => resource.id),
    ).toEqual([(successful[0].data as Record<string, unknown>).id]);
    expect(owned.resources.filter((resource) => resource.kind === "domains")).toHaveLength(1);
    const failed = await f.reconcile(20);
    expect(failed?.session.reservationHeld).toBe(false);
    expect(f.allocations.size).toBe(0);
    expect(await f.provider.absent(failed!)).toBe(true);
  });
  it("stops and cleans up when runtime secret delivery fails", async () => {
    const f = providerFixture();
    f.failSecret();
    await f.command("start", { kind: "start", aliases: ["web"] });
    const failed = await f.reconcile(20);
    expect(failed?.session.reservationHeld).toBe(false);
    expect(f.allocations.size).toBe(0);
    expect(
      [...f.runs.values()].some((run) => run.arguments.devrouterOperation?.startsWith("activate-")),
    ).toBe(false);
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
  it("settles a superseded run whose response was lost before deploying newer source", async () => {
    const f = providerFixture();
    f.holdPrepare();
    await f.command("start", { kind: "start", aliases: ["web"] });
    await f.reconcile(1);
    f.loseRun(true);
    await expect(f.reconcile(1)).rejects.toThrow();
    const submitted = [...f.runs.values()].find((run) =>
      run.arguments.devrouterOperation?.startsWith("prepare-"),
    );
    expect(submitted).toBeDefined();
    f.refreshSource();
    await f.command("refresh", { kind: "start", aliases: ["web"] });
    f.finishRuns();
    expect((await f.reconcile(20))?.session.status).toBe("ready");
    expect(
      [...f.runs.values()].filter(
        (run) => run.arguments.devrouterOperation === submitted!.arguments.devrouterOperation,
      ),
    ).toHaveLength(1);
    expect(f.mutations.some((item) => item.startsWith("DELETE"))).toBe(false);
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
        {
          protocol: "CMD",
          type: "readinessProbe",
          cmd: "'test' '-f' '/tmp/worker-ready'",
          successThreshold: 1,
        },
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

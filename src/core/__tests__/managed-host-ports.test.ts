import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContainerSnapshot } from "../devpod-environment";
import {
  assertManagedHostPortsAvailable,
  type ManagedHostPorts,
  managedHostPortIdentity,
  managedHostPortVariables,
  resolveManagedHostPorts,
} from "../managed-host-ports";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const REPO = "/workspaces/example";
const COMPOSE_PROJECT = "example";
const COMPOSE_FILES = [
  `${REPO}/.devcontainer/compose.yml`,
  `${REPO}/.devcontainer/compose.devrouter.yml`,
];

type ContainerOptions = {
  id?: string;
  project?: string;
  repoPath?: string;
  service?: string;
  configFiles?: string[];
  running?: boolean;
};

function container(options: ContainerOptions = {}): WorkspaceContainerSnapshot {
  const repoPath = options.repoPath ?? REPO;
  return {
    id: options.id ?? "db-container",
    state: { Running: options.running ?? true },
    labels: {
      "com.docker.compose.project": options.project ?? COMPOSE_PROJECT,
      "com.docker.compose.service": options.service ?? "db",
      "com.docker.compose.project.working_dir": `${repoPath}/.devcontainer`,
      "com.docker.compose.project.config_files": (options.configFiles ?? COMPOSE_FILES).join(","),
    },
    mounts: [],
    networks: {},
  };
}

function resolve(
  overrides: Partial<Parameters<typeof resolveManagedHostPorts>[0]> = {},
): ManagedHostPorts {
  return resolveManagedHostPorts({
    repoPath: REPO,
    declarations: { "db-port": { service: "db", target: 5432 } },
    selectedServices: ["db"],
    composeProject: COMPOSE_PROJECT,
    composeFiles: COMPOSE_FILES,
    containers: [container()],
    publishedBindings: () => "127.0.0.1:49153\n",
    ...overrides,
  });
}

function inspectOutput(snapshot: WorkspaceContainerSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveManagedHostPorts", () => {
  it("returns an empty report without Docker when no declarations exist", () => {
    const publishedBindings = vi.fn(() => "127.0.0.1:49153\n");

    expect(
      resolveManagedHostPorts({
        repoPath: REPO,
        declarations: {},
        selectedServices: ["db"],
        publishedBindings,
      }),
    ).toEqual({});
    expect(spawnSync).not.toHaveBeenCalled();
    expect(publishedBindings).not.toHaveBeenCalled();
  });

  it("marks unselected declarations inactive without inspecting or looking up a port", () => {
    const publishedBindings = vi.fn(() => "127.0.0.1:49153\n");
    const report = resolve({ selectedServices: [], publishedBindings });

    expect(report).toEqual({
      "db-port": { service: "db", target: 5432, status: "inactive" },
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(publishedBindings).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no project", composeProject: undefined },
    { name: "no files", composeFiles: undefined },
    { name: "empty files", composeFiles: [] },
  ])("requires a proven $name identity", ({ composeProject, composeFiles }) => {
    const publishedBindings = vi.fn(() => "127.0.0.1:49153\n");
    const report = resolve({ composeProject, composeFiles, publishedBindings });

    expect(report["db-port"]).toEqual({
      service: "db",
      target: 5432,
      status: "unavailable",
      reason: "unavailable",
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(publishedBindings).not.toHaveBeenCalled();
  });

  it.each([
    { name: "project", evidence: container({ project: "foreign" }) },
    { name: "checkout", evidence: container({ repoPath: "/workspaces/foreign" }) },
    { name: "service", evidence: container({ service: "api" }) },
    {
      name: "configuration",
      evidence: container({ configFiles: [...COMPOSE_FILES, "/tmp/foreign-compose.yml"] }),
    },
  ])("does not accept a foreign $name", ({ evidence }) => {
    const publishedBindings = vi.fn(() => "127.0.0.1:49153\n");
    const report = resolve({ containers: [evidence], publishedBindings });

    expect(report["db-port"]).toMatchObject({ status: "unavailable", reason: "not-found" });
    expect(publishedBindings).not.toHaveBeenCalled();
  });

  it("accepts the exact configuration with a provider-generated feature overlay", () => {
    vi.stubEnv("DEVPOD_HOME", "/workspace/devpod");
    const providerOverlay =
      "/workspace/devpod/agent/contexts/default/workspaces/example/.docker-compose/docker-compose.devcontainer.containerFeatures-1.yml";

    expect(
      resolve({
        containers: [container({ configFiles: [...COMPOSE_FILES, providerOverlay] })],
      })["db-port"],
    ).toEqual({
      service: "db",
      target: 5432,
      status: "available",
      endpoint: { host: "127.0.0.1", port: 49_153 },
    });
  });

  it.each([
    {
      name: "missing",
      containers: [],
      reason: "not-found",
    },
    {
      name: "stopped",
      containers: [container({ running: false })],
      reason: "not-running",
    },
    {
      name: "multiple",
      containers: [container({ id: "first" }), container({ id: "second" })],
      reason: "ambiguous",
    },
  ])("refuses a $name owner before reading its port", ({ containers, reason }) => {
    const publishedBindings = vi.fn(() => "127.0.0.1:49153\n");
    const report = resolve({ containers, publishedBindings });

    expect(report["db-port"]).toMatchObject({ status: "unavailable", reason });
    expect(report["db-port"]).not.toHaveProperty("endpoint");
    expect(publishedBindings).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty", output: "", reason: "not-published" },
    { name: "public", output: "0.0.0.0:6000\n", reason: "not-published" },
    { name: "IPv6", output: "[::1]:6000\n", reason: "not-published" },
    { name: "zero", output: "127.0.0.1:0\n", reason: "not-published" },
    { name: "too high", output: "127.0.0.1:65536\n", reason: "not-published" },
    { name: "non-numeric", output: "127.0.0.1:port\n", reason: "not-published" },
    {
      name: "multiple loopback",
      output: "127.0.0.1:49153\n127.0.0.1:49154\n",
      reason: "ambiguous",
    },
    {
      name: "mixed loopback and public",
      output: "127.0.0.1:49153\n0.0.0.0:6000\n",
      reason: "ambiguous",
    },
  ])("rejects the complete $name binding output", ({ output, reason }) => {
    const report = resolve({ publishedBindings: () => output });

    expect(report["db-port"]).toMatchObject({ status: "unavailable", reason });
    expect(report["db-port"]).not.toHaveProperty("endpoint");
  });

  it("maps absent or failed binding evidence to a bounded unavailable reason", () => {
    expect(resolve({ publishedBindings: () => undefined })["db-port"]).toMatchObject({
      status: "unavailable",
      reason: "unavailable",
    });

    const report = resolve({
      publishedBindings: () => {
        throw new Error("private Docker failure");
      },
    });
    expect(report["db-port"]).toMatchObject({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(JSON.stringify(report)).not.toContain("private Docker failure");
  });

  it("collects containers by exact project and revalidates the owner after live lookup", () => {
    const owner = container();
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "db-container\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: inspectOutput(owner), stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "127.0.0.1:49153\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: inspectOutput(owner), stderr: "" } as never);

    const report = resolveManagedHostPorts({
      repoPath: REPO,
      declarations: { "db-port": { service: "db", target: 5432 } },
      selectedServices: ["db"],
      composeProject: COMPOSE_PROJECT,
      composeFiles: COMPOSE_FILES,
    });

    expect(report["db-port"]).toMatchObject({
      status: "available",
      endpoint: { host: "127.0.0.1", port: 49_153 },
    });
    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][1]).toContain(`label=com.docker.compose.project=${COMPOSE_PROJECT}`);
    expect(calls[2][1]).toEqual(["port", "db-container", "5432/tcp"]);
    expect(calls[2][2]).toMatchObject({
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    expect(calls[3][1]).toEqual(["inspect", "--format", expect.any(String), "db-container"]);
  });

  it("rejects a live owner whose identity changed during port lookup", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "db-container\n", stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: inspectOutput(container()), stderr: "" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "127.0.0.1:49153\n", stderr: "" } as never)
      .mockReturnValueOnce({
        status: 0,
        stdout: inspectOutput(container({ project: "replacement" })),
        stderr: "",
      } as never);

    const report = resolveManagedHostPorts({
      repoPath: REPO,
      declarations: { "db-port": { service: "db", target: 5432 } },
      selectedServices: ["db"],
      composeProject: COMPOSE_PROJECT,
      composeFiles: COMPOSE_FILES,
    });

    expect(report["db-port"]).toMatchObject({ status: "unavailable", reason: "unavailable" });
    expect(report["db-port"]).not.toHaveProperty("endpoint");
  });

  it("reports bounded reasons for live Docker failures without leaking output", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "private daemon failure",
    } as never);

    const report = resolveManagedHostPorts({
      repoPath: REPO,
      declarations: { "db-port": { service: "db", target: 5432 } },
      selectedServices: ["db"],
      composeProject: COMPOSE_PROJECT,
      composeFiles: COMPOSE_FILES,
    });

    expect(report["db-port"]).toMatchObject({ status: "unavailable", reason: "unavailable" });
    expect(JSON.stringify(report)).not.toContain("private daemon failure");
  });
});

describe("managed host-port helpers", () => {
  it("exports available ports and clears stale inactive or unavailable values", () => {
    const report: ManagedHostPorts = {
      "db-port": {
        service: "db",
        target: 5432,
        status: "available",
        endpoint: { host: "127.0.0.1", port: 49_153 },
      },
      "cache-port": { service: "cache", target: 6379, status: "inactive" },
      "search-port": {
        service: "search",
        target: 9200,
        status: "unavailable",
        reason: "not-found",
      },
    };

    expect(managedHostPortVariables(report)).toEqual({
      DEVROUTER_HOST_PORT_DB_PORT: "49153",
      DEVROUTER_HOST_PORT_CACHE_PORT: "",
      DEVROUTER_HOST_PORT_SEARCH_PORT: "",
    });
  });

  it("keeps identity stable for the same sorted mapping and changes it with current availability", () => {
    const available: ManagedHostPorts = {
      "db-port": {
        service: "db",
        target: 5432,
        status: "available",
        endpoint: { host: "127.0.0.1", port: 49_153 },
      },
      "cache-port": {
        service: "cache",
        target: 6379,
        status: "available",
        endpoint: { host: "127.0.0.1", port: 49_154 },
      },
    };
    const reordered = Object.fromEntries(Object.entries(available).reverse());
    const changed: ManagedHostPorts = structuredClone(available);
    changed["db-port"].endpoint = { host: "127.0.0.1", port: 49_155 };

    expect(managedHostPortIdentity(available)).toBe(managedHostPortIdentity(reordered));
    expect(managedHostPortIdentity(changed)).not.toBe(managedHostPortIdentity(available));
    expect(managedHostPortIdentity({})).toBeUndefined();
    expect(
      managedHostPortIdentity({
        "db-port": { service: "db", target: 5432, status: "inactive" },
      }),
    ).not.toBe(
      managedHostPortIdentity({
        "db-port": {
          service: "db",
          target: 5432,
          status: "unavailable",
          reason: "not-found",
        },
      }),
    );
  });

  it("fails only when a selected declaration is unavailable", () => {
    const report: ManagedHostPorts = {
      "db-port": {
        service: "db",
        target: 5432,
        status: "available",
        endpoint: { host: "127.0.0.1", port: 49_153 },
      },
      "cache-port": { service: "cache", target: 6379, status: "inactive" },
    };
    expect(() => assertManagedHostPortsAvailable(report)).not.toThrow();

    report["search-port"] = {
      service: "search",
      target: 9200,
      status: "unavailable",
      reason: "not-published",
    };
    expect(() => assertManagedHostPortsAvailable(report)).toThrow();
  });
});

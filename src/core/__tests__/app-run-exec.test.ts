import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterApp, DevrouterConfig, DevrouterDockerPostgresApp, DevrouterHostHttpApp } from "../../types";

const {
  spawnMock,
  spawnSyncMock,
  resolveRepoPathMock,
  resolveAppByNameMock,
  resolveAppDependenciesMock,
  ensureNetworkMock,
  ensureRouterFilesMock,
  prepareDockerOverlayMock,
  runDockerComposeUpMock,
  runDockerComposeStopMock,
  runDockerComposeLogsMock,
  queryMappedPortMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  resolveRepoPathMock: vi.fn(),
  resolveAppByNameMock: vi.fn(),
  resolveAppDependenciesMock: vi.fn(),
  ensureNetworkMock: vi.fn(),
  ensureRouterFilesMock: vi.fn(),
  prepareDockerOverlayMock: vi.fn(),
  runDockerComposeUpMock: vi.fn(),
  runDockerComposeStopMock: vi.fn(),
  runDockerComposeLogsMock: vi.fn(),
  queryMappedPortMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("../repo-config", () => ({
  resolveRepoPath: resolveRepoPathMock,
  resolveAppByName: resolveAppByNameMock,
  resolveAppDependencies: resolveAppDependenciesMock,
}));

vi.mock("../docker", () => ({
  ensureNetwork: ensureNetworkMock,
}));

vi.mock("../router", () => ({
  DEVNET_NAME: "devnet",
  ensureRouterFiles: ensureRouterFilesMock,
}));

vi.mock("../docker-run", () => ({
  prepareDockerOverlay: prepareDockerOverlayMock,
  runDockerComposeUp: runDockerComposeUpMock,
  runDockerComposeStop: runDockerComposeStopMock,
  runDockerComposeLogs: runDockerComposeLogsMock,
  queryMappedPort: queryMappedPortMock,
}));

vi.mock("../host-routes", () => ({
  buildHostRouteId: vi.fn(),
  removeHostRouteById: vi.fn(),
  upsertHostRoute: vi.fn(),
}));

vi.mock("../paths", () => ({
  assertPathWithinRepo: vi.fn((value: string) => value),
}));

import { buildExecEnvironment, execWithAppEnv, parseEnvMapEntries } from "../app-run";

const HOST_APP: DevrouterHostHttpApp = {
  name: "web",
  host: "web.localhost",
  protocol: "http",
  runtime: "host",
  dependencies: [],
  hostRun: {
    command: "pnpm dev",
    cwd: ".",
    strategy: {
      type: "auto",
      denyPorts: [80, 443, 5432],
      allowPortRange: "1024-65535",
    },
  },
};

const POSTGRES_DEP: DevrouterDockerPostgresApp = {
  name: "db",
  host: "db.localhost",
  protocol: "tcp",
  tcpProtocol: "postgres",
  runtime: "docker",
  dependencies: [],
  docker: {
    service: "db",
    internalPort: 5432,
    composeFiles: ["docker-compose.yml"],
  },
};

function makeConfig(apps: DevrouterApp[]): DevrouterConfig {
  return {
    version: 1,
    apps,
  };
}

function makeChild(options: { exitCode?: number; error?: Error } = {}): EventEmitter & { pid: number } {
  const child = new EventEmitter() as EventEmitter & { pid: number };
  child.pid = 4242;
  queueMicrotask(() => {
    if (options.error) {
      child.emit("error", options.error);
      return;
    }
    child.emit("exit", options.exitCode ?? 0);
  });
  return child;
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...originalEnv };

  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  resolveRepoPathMock.mockReset();
  resolveAppByNameMock.mockReset();
  resolveAppDependenciesMock.mockReset();
  ensureNetworkMock.mockReset();
  ensureRouterFilesMock.mockReset();
  prepareDockerOverlayMock.mockReset();
  runDockerComposeUpMock.mockReset();
  runDockerComposeStopMock.mockReset();
  runDockerComposeLogsMock.mockReset();
  queryMappedPortMock.mockReset();

  resolveRepoPathMock.mockReturnValue("/repo");
  resolveAppByNameMock.mockReturnValue({
    config: makeConfig([HOST_APP]),
    app: HOST_APP,
  });
  resolveAppDependenciesMock.mockReturnValue([]);
  ensureNetworkMock.mockResolvedValue(undefined);
  prepareDockerOverlayMock.mockReturnValue({
    overlayPath: "/overlay.yml",
    composeFiles: ["docker-compose.yml"],
    dockerApps: [POSTGRES_DEP],
  });
  queryMappedPortMock.mockReturnValue(55432);

  spawnMock.mockImplementation(() => makeChild());
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  process.env = originalEnv;
});

describe("parseEnvMapEntries", () => {
  it("parses TARGET=SOURCE mappings", () => {
    expect(parseEnvMapEntries(["DATABASE_URI=DATABASE_URL"])).toEqual([
      { target: "DATABASE_URI", source: "DATABASE_URL" },
    ]);
  });

  it("rejects invalid mapping syntax", () => {
    expect(() => parseEnvMapEntries(["DATABASE_URI"])).toThrow("Invalid --env-map value");
    expect(() => parseEnvMapEntries(["BAD-NAME=DATABASE_URL"])).toThrow("Invalid --env-map value");
  });
});

describe("buildExecEnvironment", () => {
  it("applies dep env before env-map and lets last mapping win", () => {
    const env = buildExecEnvironment(
      { DATABASE_URL: "postgres://dep", ALT_URL: "postgres://alt" },
      ["DATABASE_URI=DATABASE_URL", "DATABASE_URI=ALT_URL"],
      { DATABASE_URL: "postgres://process" }
    );

    expect(env.DATABASE_URL).toBe("postgres://dep");
    expect(env.DATABASE_URI).toBe("postgres://alt");
  });

  it("fails fast when source variable is missing", () => {
    expect(() =>
      buildExecEnvironment({}, ["DATABASE_URI=__DEVROUTER_TEST_MISSING__"], {})
    ).toThrow("references missing source variable");
  });
});

describe("execWithAppEnv", () => {
  it("preserves argv semantics and uses shell false by default", async () => {
    const result = await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      command: ["infisical", "run", "--projectId", "proj", "--", "pnpm", "payload", "migrate"],
    });

    expect(result.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith(
      "infisical",
      ["run", "--projectId", "proj", "--", "pnpm", "payload", "migrate"],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
        stdio: "inherit",
      })
    );
  });

  it("requires exactly one command string in explicit shell mode", async () => {
    await expect(
      execWithAppEnv({
        name: "web",
        repoPath: "/repo",
        shell: true,
        command: ["echo", "DATABASE_URL"],
      })
    ).rejects.toThrow("--shell requires exactly one command string");

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs explicit shell mode with one command string", async () => {
    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      shell: true,
      command: ["echo $DATABASE_URL"],
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "echo $DATABASE_URL",
      expect.objectContaining({
        cwd: "/repo",
        shell: true,
        stdio: "inherit",
      })
    );
  });

  it("maps DATABASE_URL to DATABASE_URI after dep env resolution", async () => {
    process.env.DATABASE_URL = "postgres://secret-manager-value";

    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      envMap: ["DATABASE_URI=DATABASE_URL"],
      command: ["pnpm", "payload", "migrate"],
    });

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(spawnOptions.env.DB_HOST).toBe("localhost");
    expect(spawnOptions.env.DB_PORT).toBe("55432");
    expect(spawnOptions.env.DATABASE_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnOptions.env.DATABASE_URI).toBe("postgres://prisma:prisma@localhost:55432/prisma");
  });

  it("fails fast on missing env-map source before spawning", async () => {
    await expect(
      execWithAppEnv({
        name: "web",
        repoPath: "/repo",
        envMap: ["DATABASE_URI=__DEVROUTER_TEST_MISSING__"],
        command: ["pnpm", "payload", "migrate"],
      })
    ).rejects.toThrow("references missing source variable");

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("surfaces spawn errors with command context", async () => {
    spawnMock.mockImplementationOnce(() => makeChild({ error: new Error("ENOENT") }));

    await expect(
      execWithAppEnv({
        name: "web",
        repoPath: "/repo",
        command: ["does-not-exist"],
      })
    ).rejects.toThrow("Failed to start command 'does-not-exist'");
  });
});

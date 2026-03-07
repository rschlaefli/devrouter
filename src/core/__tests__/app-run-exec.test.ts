import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DevrouterApp,
  DevrouterConfig,
  DevrouterDockerDependencyApp,
  DevrouterDockerTcpApp,
  DevrouterHostHttpApp
} from "../../types";

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
  queryRunningComposeServicesMock,
  queryMappedPortMock,
  ensureTLSHostsCoveredMock
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
  queryRunningComposeServicesMock: vi.fn(),
  queryMappedPortMock: vi.fn(),
  ensureTLSHostsCoveredMock: vi.fn(),
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
  TCP_PROTOCOL_REGISTRY: {
    postgres: { port: 5432, entrypoint: "postgres" },
    redis: { port: 6379, entrypoint: "redis" },
    mariadb: { port: 3306, entrypoint: "mariadb" },
    mysql: { port: 3306, entrypoint: "mysql" },
  },
  ensureRouterFiles: ensureRouterFilesMock,
  activateTcpProtocol: vi.fn(() => false),
  startRouterStack: vi.fn(),
}));

vi.mock("../docker-run", () => ({
  prepareDockerOverlay: prepareDockerOverlayMock,
  runDockerComposeUp: runDockerComposeUpMock,
  runDockerComposeStop: runDockerComposeStopMock,
  runDockerComposeLogs: runDockerComposeLogsMock,
  queryRunningComposeServices: queryRunningComposeServicesMock,
  queryMappedPort: queryMappedPortMock,
}));

vi.mock("../host-routes", () => ({
  buildHostRouteId: vi.fn(),
  removeHostRouteById: vi.fn(),
  upsertHostRoute: vi.fn(),
}));

vi.mock("../concurrency", () => ({
  assertAppNotRunning: vi.fn(),
}));

vi.mock("../paths", () => ({
  assertPathWithinRepo: vi.fn((value: string) => value),
}));

vi.mock("../tls", () => ({
  ensureTLSHostsCovered: ensureTLSHostsCoveredMock,
}));

import { buildExecEnvironment, buildTcpDepUrl, buildTcpDepShadowUrl, execWithAppEnv, resolveSmCommand, runConfiguredApp, wrapWithSecretManager } from "../app-run";

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

const POSTGRES_DEP: DevrouterDockerTcpApp = {
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

const REDIS_DEP: DevrouterDockerDependencyApp = {
  kind: "dependency",
  name: "redis",
  runtime: "docker",
  dependencies: [],
  docker: {
    service: "redis",
    composeFiles: ["docker-compose.yml"]
  }
};

function makeConfig(
  apps: DevrouterApp[],
  options?: { secretManager?: { command: string; defaultEnv?: string } }
): DevrouterConfig {
  return {
    version: 1,
    ...(options?.secretManager ? { secretManager: options.secretManager } : {}),
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
  queryRunningComposeServicesMock.mockReset();
  queryMappedPortMock.mockReset();
  ensureTLSHostsCoveredMock.mockReset();

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
  queryRunningComposeServicesMock.mockReturnValue({
    status: "known",
    runningServices: new Set<string>(),
  });
  queryMappedPortMock.mockReturnValue(55432);
  ensureTLSHostsCoveredMock.mockResolvedValue({
    refreshed: false,
    uncoveredHosts: [],
    certificateHosts: [],
  });

  spawnMock.mockImplementation(() => makeChild());
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  process.env = originalEnv;
});

describe("buildExecEnvironment", () => {
  it("merges dep env over process env", () => {
    const env = buildExecEnvironment(
      { DB_URL: "postgres://dep" },
      { DB_URL: "postgres://process" }
    );

    expect(env.DB_URL).toBe("postgres://dep");
  });
});

describe("buildTcpDepUrl", () => {
  it("builds postgres URL", () => {
    expect(buildTcpDepUrl("postgres", 55432)).toBe("postgres://prisma:prisma@localhost:55432/prisma");
  });

  it("builds redis URL", () => {
    expect(buildTcpDepUrl("redis", 63791)).toBe("redis://localhost:63791");
  });

  it("builds mysql URL", () => {
    expect(buildTcpDepUrl("mysql", 33061)).toBe("mysql://root@localhost:33061");
  });

  it("builds mariadb URL", () => {
    expect(buildTcpDepUrl("mariadb", 33062)).toBe("mysql://root@localhost:33062");
  });

  it("returns undefined for unknown protocol", () => {
    expect(buildTcpDepUrl("cassandra", 9042)).toBeUndefined();
  });
});

describe("buildTcpDepShadowUrl", () => {
  it("builds postgres shadow URL", () => {
    expect(buildTcpDepShadowUrl("postgres", 55432)).toBe("postgres://prisma:prisma@localhost:55432/shadow");
  });

  it("returns undefined for non-postgres", () => {
    expect(buildTcpDepShadowUrl("redis", 63791)).toBeUndefined();
    expect(buildTcpDepShadowUrl("mysql", 33061)).toBeUndefined();
  });
});

describe("wrapWithSecretManager", () => {
  it("wraps shell command with env re-injection", () => {
    const result = wrapWithSecretManager(
      "infisical run --env dev --",
      { DB_HOST: "localhost", DB_PORT: "55432" },
      "pnpm dev",
      true
    );
    expect(result).toBe("infisical run --env dev -- env DB_HOST=localhost DB_PORT=55432 pnpm dev");
  });

  it("wraps non-shell command with env re-injection", () => {
    const result = wrapWithSecretManager(
      "infisical run --env dev --",
      { DB_HOST: "localhost" },
      ["pnpm", "prisma", "migrate"],
      false
    );
    expect(result).toEqual([
      "infisical", "run", "--env", "dev", "--",
      "env", "DB_HOST=localhost",
      "pnpm", "prisma", "migrate"
    ]);
  });

  it("skips env prefix when reinject env is empty", () => {
    expect(wrapWithSecretManager("sm run --", {}, "pnpm dev", true)).toBe("sm run -- pnpm dev");
    expect(wrapWithSecretManager("sm run --", {}, ["pnpm", "dev"], false)).toEqual(["sm", "run", "--", "pnpm", "dev"]);
  });
});

describe("resolveSmCommand", () => {
  it("replaces all {env} occurrences with defaultEnv", () => {
    expect(resolveSmCommand("infisical run --env {env} --", "dev")).toBe("infisical run --env dev --");
  });

  it("replaces all {env} occurrences with overrideEnv", () => {
    expect(resolveSmCommand("infisical run --env {env} --", "dev", "stg")).toBe("infisical run --env stg --");
  });

  it("returns command as-is when no {env} placeholder", () => {
    expect(resolveSmCommand("infisical run --env dev --")).toBe("infisical run --env dev --");
  });

  it("throws when {env} present but no env resolved", () => {
    expect(() => resolveSmCommand("cmd --env {env} --")).toThrow(
      "secretManager.command contains {env} but no environment was resolved"
    );
  });

  it("replaces multiple {env} occurrences", () => {
    expect(resolveSmCommand("{env}-prefix --env {env} --", "dev")).toBe("dev-prefix --env dev --");
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
    expect(ensureTLSHostsCoveredMock).toHaveBeenCalledWith(["web.localhost"]);
  });

  it("refreshes TLS coverage against all configured repo hosts before exec", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: HOST_APP,
    });

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      command: ["pnpm", "payload", "migrate"],
    });

    expect(ensureTLSHostsCoveredMock).toHaveBeenCalledWith(["web.localhost", "db.localhost"]);
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

  it("injects per-dep vars and applies config-level envMap", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name, envMap: { DATABASE_URL: "DB_URL", DIRECT_URL: "DB_URL", SHADOW_DATABASE_URL: "DB_SHADOW_URL" } }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["pnpm", "payload", "migrate"],
    });

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(spawnOptions.env.DB_HOST).toBe("localhost");
    expect(spawnOptions.env.DB_PORT).toBe("55432");
    expect(spawnOptions.env.DB_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnOptions.env.DB_SHADOW_URL).toBe("postgres://prisma:prisma@localhost:55432/shadow");
    expect(spawnOptions.env.DATABASE_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnOptions.env.DIRECT_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnOptions.env.SHADOW_DATABASE_URL).toBe("postgres://prisma:prisma@localhost:55432/shadow");
  });

  it("rejects direct exec on dependency-only app targets", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, REDIS_DEP]),
      app: REDIS_DEP
    });

    await expect(
      execWithAppEnv({
        name: "redis",
        repoPath: "/repo",
        command: ["redis-cli", "PING"]
      })
    ).rejects.toThrow("is kind=dependency and cannot be run directly");
  });

  it("starts dependency-only services for host exec without injecting DB env", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, REDIS_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: REDIS_DEP.name }]
      }
    });
    resolveAppDependenciesMock.mockReturnValue([REDIS_DEP]);
    prepareDockerOverlayMock.mockReturnValue({
      overlayPath: "/overlay.yml",
      composeFiles: ["docker-compose.yml"],
      dockerApps: [REDIS_DEP]
    });
    queryRunningComposeServicesMock.mockReturnValue({
      status: "known",
      runningServices: new Set<string>()
    });

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["pnpm", "run", "cache:seed"]
    });

    expect(runDockerComposeUpMock).toHaveBeenCalledWith(
      "/repo",
      ["docker-compose.yml"],
      "/overlay.yml",
      ["redis"]
    );
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(spawnOptions.env.REDIS_HOST).toBeUndefined();
    expect(spawnOptions.env.REDIS_PORT).toBeUndefined();
    expect(spawnOptions.env.REDIS_URL).toBeUndefined();
    expect(runDockerComposeStopMock).toHaveBeenCalledWith(
      "/repo",
      ["docker-compose.yml"],
      "/overlay.yml",
      ["redis"]
    );
  });

  it("does not stop dependencies already running before exec", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);
    queryRunningComposeServicesMock.mockReturnValue({
      status: "known",
      runningServices: new Set(["db"]),
    });

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["pnpm", "payload", "seed"],
    });

    expect(runDockerComposeStopMock).not.toHaveBeenCalled();
  });

  it("stops dependencies started by exec when they were not running before", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);
    queryRunningComposeServicesMock.mockReturnValue({
      status: "known",
      runningServices: new Set<string>(),
    });

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["pnpm", "payload", "seed"],
    });

    expect(runDockerComposeStopMock).toHaveBeenCalledWith(
      "/repo",
      ["docker-compose.yml"],
      "/overlay.yml",
      ["db"]
    );
  });

  it("stops only newly started dependencies when some were already running", async () => {
    const ANALYTICS_DB_DEP: DevrouterDockerTcpApp = {
      ...POSTGRES_DEP,
      name: "analytics-db",
      host: "analytics-db.localhost",
      docker: {
        ...POSTGRES_DEP.docker,
        service: "analytics-db",
      },
    };

    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP, ANALYTICS_DB_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }, { app: ANALYTICS_DB_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP, ANALYTICS_DB_DEP]);
    prepareDockerOverlayMock.mockReturnValue({
      overlayPath: "/overlay.yml",
      composeFiles: ["docker-compose.yml"],
      dockerApps: [POSTGRES_DEP, ANALYTICS_DB_DEP],
    });
    queryRunningComposeServicesMock.mockReturnValue({
      status: "known",
      runningServices: new Set(["db"]),
    });

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["pnpm", "payload", "seed"],
    });

    expect(runDockerComposeStopMock).toHaveBeenCalledWith(
      "/repo",
      ["docker-compose.yml"],
      "/overlay.yml",
      ["analytics-db"]
    );
  });

  it("keeps dependencies running when ownership detection is unknown", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);
    queryRunningComposeServicesMock.mockReturnValue({
      status: "unknown",
      reason: "docker compose ps failed",
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["pnpm", "payload", "seed"],
    });

    expect(runDockerComposeStopMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("unable to determine which dependencies were already running before 'dev app exec'")
    );
    stderrSpy.mockRestore();
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

  it("fails before spawning when TLS coverage refresh fails", async () => {
    ensureTLSHostsCoveredMock.mockRejectedValueOnce(
      new Error("TLS cert does not currently cover host(s): elearning.klicker.localhost")
    );

    await expect(
      execWithAppEnv({
        name: "web",
        repoPath: "/repo",
        command: ["pnpm", "payload", "migrate"],
      })
    ).rejects.toThrow("TLS cert does not currently cover host(s): elearning.klicker.localhost");

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("wraps exec command with secret manager (shell: false)", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP], { secretManager: { command: "infisical run --env dev --" } }),
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
      command: ["pnpm", "prisma", "migrate"],
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "infisical",
      expect.arrayContaining([
        "run", "--env", "dev", "--",
        "env",
      ]),
      expect.objectContaining({ shell: false })
    );
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toContain("DB_HOST=localhost");
    expect(spawnArgs).toContain("DB_PORT=55432");
    expect(spawnArgs).toContain("DB_URL=postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnArgs).toContain("DB_SHADOW_URL=postgres://prisma:prisma@localhost:55432/shadow");
    expect(spawnArgs.slice(-3)).toEqual(["pnpm", "prisma", "migrate"]);
  });

  it("wraps exec command with secret manager (shell: true)", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP], { secretManager: { command: "infisical run --" } }),
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
      shell: true,
      command: ["pnpm prisma migrate"],
    });

    const spawnCommand = spawnMock.mock.calls[0]?.[0] as string;
    expect(spawnCommand).toContain("infisical run --");
    expect(spawnCommand).toContain("env DB_HOST=localhost");
    expect(spawnCommand).toContain("pnpm prisma migrate");
    expect(spawnMock).toHaveBeenCalledWith(
      spawnCommand,
      expect.objectContaining({ shell: true })
    );
  });

  it("includes config envMap targets in secret manager re-injection", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP], { secretManager: { command: "infisical run --" } }),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name, envMap: { DATABASE_URL: "DB_URL" } }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["pnpm", "payload", "migrate"],
    });

    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toContain("DATABASE_URL=postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnArgs).toContain("DB_URL=postgres://prisma:prisma@localhost:55432/prisma");
  });

  it("config envMap referencing missing source throws", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name, envMap: { DATABASE_URL: "NONEXISTENT_VAR" } }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);

    await expect(
      execWithAppEnv({
        name: "web",
        repoPath: "/repo",
        yes: true,
        command: ["pnpm", "test"],
      })
    ).rejects.toThrow("source variable 'NONEXISTENT_VAR' not found in dependency env");
  });

  it("multiple postgres deps get unique per-dep vars", async () => {
    const ANALYTICS_DB_DEP: DevrouterDockerTcpApp = {
      ...POSTGRES_DEP,
      name: "analytics-db",
      host: "analytics-db.localhost",
      docker: { ...POSTGRES_DEP.docker, service: "analytics-db" },
    };

    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP, ANALYTICS_DB_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }, { app: ANALYTICS_DB_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP, ANALYTICS_DB_DEP]);
    prepareDockerOverlayMock.mockReturnValue({
      overlayPath: "/overlay.yml",
      composeFiles: ["docker-compose.yml"],
      dockerApps: [POSTGRES_DEP, ANALYTICS_DB_DEP],
    });
    queryMappedPortMock
      .mockReturnValueOnce(55432)
      .mockReturnValueOnce(55433);

    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      yes: true,
      command: ["printenv"],
    });

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(spawnOptions.env.DB_HOST).toBe("localhost");
    expect(spawnOptions.env.DB_PORT).toBe("55432");
    expect(spawnOptions.env.DB_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnOptions.env.DB_SHADOW_URL).toBe("postgres://prisma:prisma@localhost:55432/shadow");
    expect(spawnOptions.env.ANALYTICS_DB_HOST).toBe("localhost");
    expect(spawnOptions.env.ANALYTICS_DB_PORT).toBe("55433");
    expect(spawnOptions.env.ANALYTICS_DB_URL).toBe("postgres://prisma:prisma@localhost:55433/prisma");
    expect(spawnOptions.env.ANALYTICS_DB_SHADOW_URL).toBe("postgres://prisma:prisma@localhost:55433/shadow");
  });

  it("resolves {env} placeholder with --env override in exec", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP], { secretManager: { command: "infisical run --env {env} --", defaultEnv: "dev" } }),
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
      env: "stg",
      command: ["pnpm", "prisma", "migrate"],
    });

    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs[0]).toBe("run");
    expect(spawnArgs[1]).toBe("--env");
    expect(spawnArgs[2]).toBe("stg");
  });

  it("resolves {env} placeholder with defaultEnv when no --env", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP], { secretManager: { command: "infisical run --env {env} --", defaultEnv: "dev" } }),
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
      command: ["pnpm", "prisma", "migrate"],
    });

    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs[0]).toBe("run");
    expect(spawnArgs[1]).toBe("--env");
    expect(spawnArgs[2]).toBe("dev");
  });

  it("does not wrap exec command without secret manager config", async () => {
    await execWithAppEnv({
      name: "web",
      repoPath: "/repo",
      command: ["pnpm", "test"],
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "pnpm",
      ["test"],
      expect.objectContaining({ shell: false })
    );
  });
});

describe("runConfiguredApp", () => {
  it("rejects direct run on dependency-only app targets", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, REDIS_DEP]),
      app: REDIS_DEP
    });

    await expect(
      runConfiguredApp({
        name: "redis",
        repoPath: "/repo",
        yes: true
      })
    ).rejects.toThrow("is kind=dependency and cannot be run directly");
  });

  it("wraps host run command with secret manager", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP], { secretManager: { command: "infisical run --" } }),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runConfiguredApp({
      name: "web",
      repoPath: "/repo",
      yes: true,
    });
    stdoutSpy.mockRestore();

    const spawnCommand = spawnMock.mock.calls[0]?.[0] as string;
    expect(spawnCommand).toContain("infisical run --");
    expect(spawnCommand).toContain("env DB_HOST=localhost");
    expect(spawnCommand).toContain("DB_PORT=55432");
    expect(spawnCommand).toContain("DB_URL=postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnCommand).toContain("pnpm dev");
    expect(spawnMock).toHaveBeenCalledWith(
      spawnCommand,
      expect.objectContaining({ shell: true })
    );
  });

  it("resolves {env} in host run SM command with --env override", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP], { secretManager: { command: "infisical run --env {env} --", defaultEnv: "dev" } }),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runConfiguredApp({
      name: "web",
      repoPath: "/repo",
      yes: true,
      env: "stg",
    });
    stdoutSpy.mockRestore();

    const spawnCommand = spawnMock.mock.calls[0]?.[0] as string;
    expect(spawnCommand).toContain("infisical run --env stg --");
    expect(spawnCommand).toContain("pnpm dev");
  });

  it("applies config-level envMap aliases in run path", async () => {
    resolveAppByNameMock.mockReturnValue({
      config: makeConfig([HOST_APP, POSTGRES_DEP]),
      app: {
        ...HOST_APP,
        dependencies: [{ app: POSTGRES_DEP.name, envMap: { DATABASE_URL: "DB_URL" } }],
      },
    });
    resolveAppDependenciesMock.mockReturnValue([POSTGRES_DEP]);

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runConfiguredApp({
      name: "web",
      repoPath: "/repo",
      yes: true,
    });
    stdoutSpy.mockRestore();

    // runHostApp uses spawn(command, { env }) — options at index 1
    const spawnOptions = spawnMock.mock.calls[0]?.[1] as { env: Record<string, string> };
    expect(spawnOptions.env.DB_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(spawnOptions.env.DATABASE_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
  });
});

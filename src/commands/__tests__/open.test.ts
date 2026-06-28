import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenCommand } from "../open";
import type { Route } from "../../types";
import { discoverRoutes } from "../../core/routes";
import { loadRuntimeConfig } from "../../core/repo-config";

vi.mock("../../core/docker", () => ({
  listContainers: vi.fn(async () => []),
}));

vi.mock("../../core/host-routes", () => ({
  listHostRoutes: vi.fn(() => []),
}));

vi.mock("../../core/router", () => ({
  DEVNET_NAME: "devnet",
  TCP_PROTOCOL_REGISTRY: {
    postgres: { port: 5432, entrypoint: "postgres" },
    redis: { port: 6379, entrypoint: "redis" },
    mariadb: { port: 3306, entrypoint: "mariadb" },
    mysql: { port: 3306, entrypoint: "mysql" },
  },
  isTLSEnabled: vi.fn(() => true),
}));

vi.mock("../../core/repo-config", () => ({
  loadRuntimeConfig: vi.fn(),
  resolveRepoPath: vi.fn(() => "/repo"),
  getRepoConfigPath: vi.fn(() => "/repo/.devrouter.yml"),
}));

vi.mock("../../core/routes", async () => {
  const actual = await vi.importActual("../../core/routes");
  return {
    ...(actual as object),
    discoverRoutes: vi.fn(),
  };
});

function makeTcpRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "db-route",
    source: "docker",
    protocol: "tcp/postgres",
    appName: "postgres",
    serviceName: "postgres",
    projectName: "elearning",
    hosts: ["db.elearning.klicker.localhost"],
    urls: ["postgres://db.elearning.klicker.localhost:5432 (tls required)"],
    status: "running",
    health: "unknown",
    createdAt: 1700000000,
    ...overrides,
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.clearAllMocks();
});

describe("runOpenCommand", () => {
  it("resolves configured app name to route host when service/app names differ", async () => {
    vi.mocked(discoverRoutes).mockReturnValue({
      routes: [makeTcpRoute()],
      duplicateHosts: [],
    });
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      workspace: undefined,
      config: {
        version: 1,
        apps: [
          {
            name: "db",
            host: "db.elearning.klicker.localhost",
            protocol: "tcp",
            tcpProtocol: "postgres",
            runtime: "docker",
            dependencies: [],
            docker: {
              service: "postgres",
              internalPort: 5432,
              composeFiles: ["docker-compose.yml"],
            },
          },
        ],
      },
    });

    await runOpenCommand("db");
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("Route 'postgres' is tcp/postgres: postgres://db.elearning.klicker.localhost:5432")
    );
  });

  it("throws targeted message when app exists but no active route is found", async () => {
    vi.mocked(discoverRoutes).mockReturnValue({
      routes: [makeTcpRoute({ hosts: ["other.localhost"], urls: ["postgres://other.localhost:5432 (tls required)"] })],
      duplicateHosts: [],
    });
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      workspace: undefined,
      config: {
        version: 1,
        apps: [
          {
            name: "db",
            host: "db.elearning.klicker.localhost",
            protocol: "tcp",
            tcpProtocol: "postgres",
            runtime: "docker",
            dependencies: [],
            docker: {
              service: "postgres",
              internalPort: 5432,
              composeFiles: ["docker-compose.yml"],
            },
          },
        ],
      },
    });

    await expect(runOpenCommand("db")).rejects.toThrow(
      "Start it with 'dev app run db --repo /repo --yes' and re-run 'dev ls'"
    );
  });

  it("throws clear guidance for dependency-only apps without routes", async () => {
    vi.mocked(discoverRoutes).mockReturnValue({
      routes: [makeTcpRoute()],
      duplicateHosts: [],
    });
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      workspace: undefined,
      config: {
        version: 1,
        apps: [
          {
            kind: "dependency",
            name: "redis",
            runtime: "docker",
            dependencies: [],
            docker: {
              service: "redis",
              composeFiles: ["docker-compose.yml"],
            },
          },
        ],
      },
    });

    await expect(runOpenCommand("redis")).rejects.toThrow(
      "is kind=dependency and does not create a route"
    );
  });
});

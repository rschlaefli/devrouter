import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenCommand } from "../open";
import type { Route } from "../../types";
import { discoverRoutes } from "../../core/routes";
import { loadRepoConfig } from "../../core/repo-config";

vi.mock("../../core/docker", () => ({
  listContainers: vi.fn(async () => []),
}));

vi.mock("../../core/host-routes", () => ({
  listHostRoutes: vi.fn(() => []),
}));

vi.mock("../../core/router", () => ({
  DEVNET_NAME: "devnet",
  isTLSEnabled: vi.fn(() => true),
}));

vi.mock("../../core/repo-config", () => ({
  loadRepoConfig: vi.fn(),
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
    vi.mocked(loadRepoConfig).mockReturnValue({
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
    vi.mocked(loadRepoConfig).mockReturnValue({
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
    });

    await expect(runOpenCommand("db")).rejects.toThrow(
      "Start it with 'dev app run db --repo /repo --yes' and re-run 'dev ls'"
    );
  });
});

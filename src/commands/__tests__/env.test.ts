import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEnvReport } from "../../core/host-env";
import { hostEnvVariables } from "../../core/host-env";
import { parseEnvInvocation, runEnvCommand, runHostCommand } from "../env";

const command = vi.hoisted(() => ({
  collectHostEnvReport: vi.fn(),
  spawn: vi.fn(),
  actualSpawn: undefined as typeof import("node:child_process").spawn | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  command.actualSpawn = actual.spawn;
  return { ...actual, spawn: command.spawn };
});
vi.mock("../../core/host-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/host-env")>()),
  collectHostEnvReport: command.collectHostEnvReport,
}));
vi.mock("../environment-path", () => ({
  resolveGitCheckoutPath: () => "/synthetic/checkout",
}));

const REPORT: HostEnvReport = {
  version: 1,
  repoPath: "/synthetic/repo",
  workspace: "feature",
  tls: true,
  caPath: "/synthetic/ca/rootCA.pem",
  apps: [
    {
      name: "response-api",
      protocol: "http",
      host: "response-api.shop.feature.localhost",
      active: true,
      url: "https://response-api.shop.feature.localhost",
    },
    {
      name: "db",
      protocol: "tcp",
      tcpProtocol: "postgres",
      host: "db.shop.feature.localhost",
      active: true,
      routed: { host: "db.shop.feature.localhost", port: 5432, params: {} },
      loopback: { host: "127.0.0.1", port: 49153 },
    },
  ],
  hostPorts: {
    blob: {
      service: "blob",
      target: 10000,
      status: "available",
      endpoint: { host: "127.0.0.1", port: 49154 },
    },
    mail: { service: "mail", target: 1025, status: "inactive" },
  },
};

beforeEach(() => {
  command.collectHostEnvReport.mockReset().mockResolvedValue(REPORT);
  command.spawn.mockReset();
  if (command.actualSpawn) command.spawn.mockImplementation(command.actualSpawn);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("parseEnvInvocation", () => {
  it("separates the checkout path from the host command", () => {
    expect(parseEnvInvocation([])).toEqual({ json: false });
    expect(parseEnvInvocation(["../repo", "--json"])).toEqual({ path: "../repo", json: true });
    expect(parseEnvInvocation(["../repo", "--", "psql", "--json"])).toEqual({
      path: "../repo",
      json: false,
      command: ["psql", "--json"],
    });
  });

  it("rejects ambiguous invocations before collecting anything", () => {
    expect(() => parseEnvInvocation(["--json", "--", "psql"])).toThrow(/cannot be combined/);
    expect(() => parseEnvInvocation(["a", "b"])).toThrow(/at most one/);
    expect(() => parseEnvInvocation(["--"])).toThrow(/No command/);
    expect(() => parseEnvInvocation(["--profile", "x"])).toThrow(/Unknown option/);
  });
});

describe("hostEnvVariables", () => {
  it("exports namespaced endpoints and keeps a caller-chosen CA", () => {
    expect(hostEnvVariables(REPORT, {})).toEqual({
      DEVROUTER_WORKSPACE: "feature",
      NODE_EXTRA_CA_CERTS: "/synthetic/ca/rootCA.pem",
      DEVROUTER_RESPONSE_API_URL: "https://response-api.shop.feature.localhost",
      DEVROUTER_DB_ROUTED_HOST: "db.shop.feature.localhost",
      DEVROUTER_DB_ROUTED_PORT: "5432",
      DEVROUTER_DB_HOST: "127.0.0.1",
      DEVROUTER_DB_PORT: "49153",
      DEVROUTER_HOST_PORT_BLOB: "49154",
    });
    expect(hostEnvVariables(REPORT, { NODE_EXTRA_CA_CERTS: "/own.pem" })).not.toHaveProperty(
      "NODE_EXTRA_CA_CERTS",
    );
  });
});

describe("runHostCommand", () => {
  it("passes argv literally, exports the environment, and returns the exit code", async () => {
    const script =
      "process.exit(process.argv[1] === '$HOME; exit 0' && process.env.DEVROUTER_DB_PORT === '49153' ? 7 : 1)";
    const code = await runHostCommand([process.execPath, "-e", script, "$HOME; exit 0"], {
      ...process.env,
      DEVROUTER_DB_PORT: "49153",
    });
    expect(code).toBe(7);
  });

  it("reports a missing executable as exit code 127", async () => {
    expect(await runHostCommand(["devrouter-env-missing-binary"], process.env)).toBe(127);
  });
});

describe("runEnvCommand", () => {
  it("refuses to launch when a selected managed host port is unavailable", async () => {
    command.collectHostEnvReport.mockResolvedValue({
      ...REPORT,
      hostPorts: {
        blob: {
          service: "blob",
          target: 10000,
          status: "unavailable",
          reason: "not-found",
        },
      },
    });

    await expect(
      runEnvCommand({ json: false, command: ["devrouter-test-must-not-spawn"] }),
    ).rejects.toThrow("Selected managed host ports are unavailable: blob.");
    expect(command.spawn).not.toHaveBeenCalled();
  });

  it("removes stale inherited port variables before exporting current proof", async () => {
    vi.stubEnv("DEVROUTER_HOST_PORT_BLOB", "4444");
    vi.stubEnv("DEVROUTER_HOST_PORT_REMOVED", "5555");
    vi.stubEnv("DEVROUTER_UNRELATED", "keep");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/caller/rootCA.pem");
    let childEnv: NodeJS.ProcessEnv | undefined;
    command.spawn.mockImplementationOnce(((
      _file: string,
      _args: string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      childEnv = options.env;
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
      child.kill = () => true;
      queueMicrotask(() => child.emit("exit", 9, null));
      return child;
    }) as never);

    await runEnvCommand({ json: false, command: ["synthetic-host-command"] });

    expect(process.exitCode).toBe(9);
    expect(childEnv).toMatchObject({
      DEVROUTER_HOST_PORT_BLOB: "49154",
      DEVROUTER_UNRELATED: "keep",
      NODE_EXTRA_CA_CERTS: "/caller/rootCA.pem",
    });
    expect(childEnv).not.toHaveProperty("DEVROUTER_HOST_PORT_REMOVED");
    expect(childEnv).not.toHaveProperty("DEVROUTER_HOST_PORT_MAIL");
  });
});

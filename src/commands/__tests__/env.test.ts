import { describe, expect, it } from "vitest";
import type { HostEnvReport } from "../../core/host-env";
import { hostEnvVariables } from "../../core/host-env";
import { parseEnvInvocation, runHostCommand } from "../env";

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
};

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

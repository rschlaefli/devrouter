import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterConfig } from "../../types";
import { ensureNetwork } from "../docker";
import { replaceHostRoutesForRepo } from "../host-routes";
import { replacePublishedProxyRoutes } from "../route-publication";
import { activateTcpProtocol, ensureRouterFiles, startRouterStack } from "../router";
import { ensureTLSHostsCovered } from "../tls";

vi.mock("../docker", () => ({ ensureNetwork: vi.fn(async () => undefined) }));
vi.mock("../host-routes", () => ({
  parseUpstream: vi.fn((upstream: string) => {
    const [host, port] = upstream.split(":");
    return { host, upstreamHost: host, port: Number(port) };
  }),
  replaceHostRoutesForRepo: vi.fn(() => []),
}));
vi.mock("../router", () => ({
  DEVNET_NAME: "devnet",
  activateTcpProtocol: vi.fn(() => false),
  ensureRouterFiles: vi.fn(),
  isTLSEnabled: vi.fn(() => true),
  startRouterStack: vi.fn(),
}));
vi.mock("../tls", () => ({
  ensureTLSHostsCovered: vi.fn(async () => ({
    refreshed: false,
    uncoveredHosts: [],
    certificateHosts: [],
  })),
}));

const proxyConfig: DevrouterConfig = {
  version: 1,
  project: { name: "sample" },
  apps: [
    {
      name: "app",
      host: "sample.localhost",
      protocol: "http",
      runtime: "proxy",
      upstream: "sample-app:3000",
      dependencies: [],
    },
    {
      name: "db",
      host: "db.sample.localhost",
      protocol: "tcp",
      tcpProtocol: "postgres",
      runtime: "proxy",
      upstream: "sample-db:5432",
      dependencies: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("replacePublishedProxyRoutes", () => {
  it("prepares shared infrastructure and replaces one complete route batch", async () => {
    vi.mocked(ensureTLSHostsCovered).mockResolvedValueOnce({
      refreshed: true,
      uncoveredHosts: ["sample.localhost"],
      certificateHosts: ["sample.localhost", "db.sample.localhost"],
    });
    const result = await replacePublishedProxyRoutes("/repo", proxyConfig);

    expect(ensureRouterFiles).toHaveBeenCalledOnce();
    expect(ensureNetwork).toHaveBeenCalledWith("devnet");
    expect(ensureTLSHostsCovered).toHaveBeenCalledWith(
      ["sample.localhost", "db.sample.localhost"],
      { repoPath: "/repo" },
    );
    expect(activateTcpProtocol).toHaveBeenCalledWith("postgres");
    expect(startRouterStack).toHaveBeenCalledOnce();
    expect(replaceHostRoutesForRepo).toHaveBeenCalledOnce();
    expect(vi.mocked(replaceHostRoutesForRepo).mock.calls[0][1]).toHaveLength(2);
    expect(result).toMatchObject({ tlsRefreshed: true });
    expect(result.routes).toHaveLength(2);
  });

  it("rejects mixed routed runtimes before infrastructure or route mutation", async () => {
    const mixed = structuredClone(proxyConfig);
    mixed.apps.push({
      name: "host",
      host: "host.localhost",
      protocol: "http",
      runtime: "host",
      hostRun: {
        command: "pnpm dev",
        cwd: ".",
        strategy: { type: "auto", denyPorts: [], allowPortRange: "1024-65535" },
      },
      dependencies: [],
    });

    await expect(replacePublishedProxyRoutes("/repo", mixed)).rejects.toThrow(
      "supports proxy runtime apps only",
    );
    expect(ensureRouterFiles).not.toHaveBeenCalled();
    expect(replaceHostRoutesForRepo).not.toHaveBeenCalled();
  });
});

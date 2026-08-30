import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRouteInput } from "../host-routes";
import { restartRouterStack } from "../router";
import { ensureTraefikRoutesLoaded } from "../traefik-route-health";

const { testHome } = vi.hoisted(() => ({
  testHome: `/tmp/devrouter-traefik-health-test-${process.pid}`,
}));

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../file-lock", () => ({
  createStderrWaitReporter: vi.fn(() => () => undefined),
  withFileLock: vi.fn(async (_path: string, _options: unknown, operation: () => Promise<unknown>) =>
    operation(),
  ),
}));
vi.mock("../host-routes", () => ({
  buildHostRouteRouterName: vi.fn(
    (repoPath: string, name: string) => `host-${repoPath.slice(1)}-${name}@file`,
  ),
}));
vi.mock("../router", () => ({
  DEVROUTER_HOME: testHome,
  restartRouterStack: vi.fn(),
}));

const route: HostRouteInput = {
  name: "chat",
  host: "chat.feature.localhost",
  protocol: "http",
  repoPath: "/repo",
  port: 3004,
  mode: "proxy",
  upstreamHost: "feature-app",
};

const tcpRoute: HostRouteInput = {
  name: "db",
  host: "db.feature.localhost",
  protocol: "tcp",
  tcpProtocol: "postgres",
  repoPath: "/repo",
  port: 5432,
  mode: "proxy",
  upstreamHost: "feature-db",
};

function mockHttpRouterResponses(responses: unknown[][]): void {
  let call = 0;
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    expect((args as string[]).at(-1)).toBe("http://127.0.0.1:8080/api/http/routers");
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { status: 0, stdout: JSON.stringify(response), stderr: "" } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("ensureTraefikRoutesLoaded", () => {
  it("accepts a file-provider router already loaded by Traefik", async () => {
    mockHttpRouterResponses([[{ name: "host-repo-chat@file" }]]);

    await expect(
      ensureTraefikRoutesLoaded([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).resolves.toEqual({ restarted: false });
    expect(restartRouterStack).not.toHaveBeenCalled();
  });

  it("restarts only Traefik once after a missed file-provider reload", async () => {
    mockHttpRouterResponses([[], [], [{ name: "host-repo-chat@file" }]]);

    await expect(
      ensureTraefikRoutesLoaded([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).resolves.toEqual({ restarted: true });
    expect(restartRouterStack).toHaveBeenCalledOnce();
  });

  it("proves HTTP and TCP router sets through their separate APIs", async () => {
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const url = (args as string[]).at(-1);
      const response =
        url === "http://127.0.0.1:8080/api/http/routers"
          ? [{ name: "host-repo-chat@file" }]
          : [{ name: "host-repo-db@file" }];
      return { status: 0, stdout: JSON.stringify(response), stderr: "" } as never;
    });

    await expect(
      ensureTraefikRoutesLoaded([route, tcpRoute], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).resolves.toEqual({ restarted: false });
    expect(vi.mocked(spawnSync).mock.calls.map((call) => (call[1] as string[]).at(-1))).toEqual([
      "http://127.0.0.1:8080/api/http/routers",
      "http://127.0.0.1:8080/api/tcp/routers",
    ]);
  });

  it("fails after one restart when the route remains absent", async () => {
    mockHttpRouterResponses([[]]);

    await expect(
      ensureTraefikRoutesLoaded([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).rejects.toThrow("did not load file-provider routes after one restart");
    expect(restartRouterStack).toHaveBeenCalledOnce();
  });
});

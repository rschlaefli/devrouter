import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRouteInput } from "../host-routes";
import { restartRouterStack } from "../router";
import { ensureTraefikRoutesLoaded, ensureTraefikRoutesRemoved } from "../traefik-route-health";

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
    expect((args as string[]).at(-1)).toBe("http://127.0.0.1:8080/api/http/routers?per_page=1000");
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
  it("refuses shared restart when repair cannot prove route reload", async () => {
    mockHttpRouterResponses([[]]);
    await expect(
      ensureTraefikRoutesLoaded([route], { initialTimeoutMs: 0, allowRestart: false }),
    ).rejects.toThrow();
    expect(restartRouterStack).not.toHaveBeenCalled();
  });

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

  it("finds an exact file-provider router beyond Traefik's first API page", async () => {
    const routers = [
      ...Array.from({ length: 100 }, (_, index) => ({ name: `other-${index}@file` })),
      { name: "host-repo-chat@file" },
    ];
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const url = new URL((args as string[]).at(-1) as string);
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      const start = (page - 1) * perPage;
      return {
        status: 0,
        stdout: JSON.stringify(routers.slice(start, start + perPage)),
        stderr: "",
      } as never;
    });

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
        url === "http://127.0.0.1:8080/api/http/routers?per_page=1000"
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
      "http://127.0.0.1:8080/api/http/routers?per_page=1000",
      "http://127.0.0.1:8080/api/tcp/routers?per_page=1000",
    ]);
  });

  it("fails closed when an absent router may be beyond the bounded API page", async () => {
    mockHttpRouterResponses([
      Array.from({ length: 1_000 }, (_, index) => ({ name: `other-${index}@file` })),
    ]);

    await expect(
      ensureTraefikRoutesLoaded([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).rejects.toThrow("HTTP router API reached the 1000-entry safety limit");
    expect(restartRouterStack).toHaveBeenCalledOnce();
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

describe("ensureTraefikRoutesRemoved", () => {
  it("accepts a complete API view without the removed router", async () => {
    mockHttpRouterResponses([[{ name: "other@file" }]]);

    await expect(
      ensureTraefikRoutesRemoved([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).resolves.toEqual({ restarted: false });
    expect(restartRouterStack).not.toHaveBeenCalled();
  });

  it("restarts Traefik once when a removed route remains loaded", async () => {
    mockHttpRouterResponses([
      [{ name: "host-repo-chat@file" }],
      [{ name: "host-repo-chat@file" }],
      [],
    ]);

    await expect(
      ensureTraefikRoutesRemoved([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).resolves.toEqual({ restarted: true });
    expect(restartRouterStack).toHaveBeenCalledOnce();
  });

  it("fails closed when removal cannot be proved beyond the bounded API page", async () => {
    mockHttpRouterResponses([
      Array.from({ length: 1_000 }, (_, index) => ({ name: `other-${index}@file` })),
    ]);

    await expect(
      ensureTraefikRoutesRemoved([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).rejects.toThrow("HTTP router API reached the 1000-entry safety limit");
    expect(restartRouterStack).toHaveBeenCalledOnce();
  });

  it("fails after one restart when the removed router remains loaded", async () => {
    mockHttpRouterResponses([[{ name: "host-repo-chat@file" }]]);

    await expect(
      ensureTraefikRoutesRemoved([route], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).rejects.toThrow("did not remove file-provider routes after one restart");
    expect(restartRouterStack).toHaveBeenCalledOnce();
  });

  it("proves removed HTTP and TCP routers through their separate APIs", async () => {
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const url = (args as string[]).at(-1);
      const response = url?.includes("/http/") ? [{ name: "other-http@file" }] : [];
      return { status: 0, stdout: JSON.stringify(response), stderr: "" } as never;
    });

    await expect(
      ensureTraefikRoutesRemoved([route, tcpRoute], {
        initialTimeoutMs: 0,
        recoveryTimeoutMs: 0,
      }),
    ).resolves.toEqual({ restarted: false });
    expect(vi.mocked(spawnSync).mock.calls.map((call) => (call[1] as string[]).at(-1))).toEqual([
      "http://127.0.0.1:8080/api/http/routers?per_page=1000",
      "http://127.0.0.1:8080/api/tcp/routers?per_page=1000",
    ]);
  });
});

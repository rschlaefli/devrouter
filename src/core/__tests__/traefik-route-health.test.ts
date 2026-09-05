import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRouteInput } from "../host-routes";
import { restartRouterStack } from "../router";
import {
  ensureTraefikRoutesLoaded,
  ensureTraefikRoutesMatch,
  ensureTraefikRoutesRemoved,
} from "../traefik-route-health";

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
  buildHostRouteId: vi.fn((repoPath: string, name: string) => `${repoPath}::${name}`),
  buildHostRouteRouterName: vi.fn(
    (repoPath: string, name: string) => `host-${repoPath.slice(1)}-${name}@file`,
  ),
  buildHostRoutesDocument: vi.fn(
    (
      routes: Array<{
        host: string;
        name: string;
        protocol?: "http" | "tcp";
        repoPath: string;
        port: number;
        upstreamHost?: string;
      }>,
    ) => {
      const httpRouters: Record<string, unknown> = {};
      const httpServices: Record<string, unknown> = {};
      const tcpRouters: Record<string, unknown> = {};
      const tcpServices: Record<string, unknown> = {};

      for (const route of routes) {
        const key = `host-${route.repoPath.slice(1)}-${route.name}`;
        const upstream = route.upstreamHost ?? "host.docker.internal";
        if (route.protocol === "tcp") {
          tcpRouters[key] = {
            rule: `HostSNI(\`${route.host}\`)`,
            service: key,
          };
          tcpServices[key] = {
            loadBalancer: {
              servers: [{ address: `${upstream}:${route.port}` }],
            },
          };
        } else {
          httpRouters[key] = {
            rule: `Host(\`${route.host}\`)`,
            service: key,
          };
          httpServices[key] = {
            loadBalancer: {
              servers: [{ url: `http://${upstream}:${route.port}` }],
            },
          };
        }
      }

      return {
        http: { routers: httpRouters, services: httpServices },
        ...(Object.keys(tcpRouters).length > 0
          ? { tcp: { routers: tcpRouters, services: tcpServices } }
          : {}),
      };
    },
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

function namedApiUrl(protocol: "http" | "tcp", resource: "routers" | "services", name: string) {
  return `http://127.0.0.1:8080/api/${protocol}/${resource}/${encodeURIComponent(name)}`;
}

function mockNamedApiResponses(
  responses: Array<{ url: string; stdout: string; status?: number; stderr?: string }>,
): void {
  let call = 0;
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    const response = responses[call++];
    expect((args as string[]).at(-1)).toBe(response.url);
    return {
      status: response.status ?? 0,
      stdout: response.stdout,
      stderr: response.stderr ?? "",
    } as never;
  });
}

function namedApiResponses(
  route: HostRouteInput,
  overrides: Partial<Pick<HostRouteInput, "host" | "port" | "upstreamHost">> = {},
  routerServiceName: "unqualified" | "qualified" = "unqualified",
): Array<{ url: string; stdout: string }> {
  const protocol = route.protocol ?? "http";
  const key = `host-${route.repoPath.slice(1)}-${route.name}`;
  const name = `${key}@file`;
  const host = overrides.host ?? route.host;
  const port = overrides.port ?? route.port;
  const upstreamHost = overrides.upstreamHost ?? route.upstreamHost ?? "host.docker.internal";
  const rule = protocol === "tcp" ? `HostSNI(\`${host}\`)` : `Host(\`${host}\`)`;
  const server = protocol === "tcp" ? `${upstreamHost}:${port}` : `http://${upstreamHost}:${port}`;
  const field = protocol === "tcp" ? "address" : "url";

  return [
    {
      url: namedApiUrl(protocol, "routers", name),
      stdout: JSON.stringify({
        name,
        rule,
        service: routerServiceName === "qualified" ? name : key,
        status: "enabled",
      }),
    },
    {
      url: namedApiUrl(protocol, "services", name),
      stdout: JSON.stringify({
        name,
        status: "enabled",
        loadBalancer: { servers: [{ [field]: server }] },
      }),
    },
  ];
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

describe("ensureTraefikRoutesMatch", () => {
  it("rejects stale same-name HTTP fields before accepting restored fields", async () => {
    const stale = namedApiResponses(route, { host: "old.feature.localhost" });
    const restored = namedApiResponses(route);
    mockNamedApiResponses([stale[0], restored[0], restored[1]]);

    await expect(ensureTraefikRoutesMatch([route], { initialTimeoutMs: 0 })).rejects.toThrow();
    await expect(
      ensureTraefikRoutesMatch([route], { initialTimeoutMs: 0 }),
    ).resolves.toBeUndefined();
    expect(restartRouterStack).not.toHaveBeenCalled();
  });

  it("rejects a stale same-name HTTP upstream before accepting the restored upstream", async () => {
    const stale = namedApiResponses(route, { upstreamHost: "old-app" });
    const restored = namedApiResponses(route);
    mockNamedApiResponses([restored[0], stale[1], restored[0], restored[1]]);

    await expect(ensureTraefikRoutesMatch([route], { initialTimeoutMs: 0 })).rejects.toThrow();
    await expect(
      ensureTraefikRoutesMatch([route], { initialTimeoutMs: 0 }),
    ).resolves.toBeUndefined();
    expect(restartRouterStack).not.toHaveBeenCalled();
  });

  it("accepts exact HTTP and TCP router and service fields", async () => {
    mockNamedApiResponses([...namedApiResponses(route), ...namedApiResponses(tcpRoute)]);

    await expect(
      ensureTraefikRoutesMatch([route, tcpRoute], { initialTimeoutMs: 0 }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(spawnSync).mock.calls.map((call) => (call[1] as string[]).at(-1))).toEqual([
      namedApiUrl("http", "routers", "host-repo-chat@file"),
      namedApiUrl("http", "services", "host-repo-chat@file"),
      namedApiUrl("tcp", "routers", "host-repo-db@file"),
      namedApiUrl("tcp", "services", "host-repo-db@file"),
    ]);
  });

  it("accepts a provider-qualified router service reference", async () => {
    mockNamedApiResponses(namedApiResponses(route, {}, "qualified"));

    await expect(
      ensureTraefikRoutesMatch([route], { initialTimeoutMs: 0 }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["malformed response", { stdout: "not-json" }],
    ["missing response fields", { stdout: JSON.stringify({}) }],
    ["unavailable response", { stdout: "", status: 7 }],
  ])("fails closed for %s", async (_label, response) => {
    const [routerResponse, serviceResponse] = namedApiResponses(route);
    const responseStatus = "status" in response ? response.status : undefined;
    mockNamedApiResponses([
      {
        url: routerResponse.url,
        stdout: response.stdout,
        ...(responseStatus === undefined ? {} : { status: responseStatus }),
      },
      serviceResponse,
    ]);

    await expect(ensureTraefikRoutesMatch([route], { initialTimeoutMs: 0 })).rejects.toThrow();
    expect(restartRouterStack).not.toHaveBeenCalled();
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

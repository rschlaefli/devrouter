import type { ContainerInfo } from "dockerode";
import { describe, expect, it } from "vitest";
import {
  discoverRoutes,
  findDuplicateHosts,
  parseHostsFromRule,
  resolveRouteByName,
} from "../routes";
import type { Route } from "../../types";

// -- helpers --

const NETWORK = "devrouter";

/** Minimal ContainerInfo stub — only fields used by routes.ts */
function makeContainer(
  overrides: Partial<ContainerInfo> & { Labels?: Record<string, string> } = {}
): ContainerInfo {
  return {
    Id: overrides.Id ?? "abc123",
    Names: overrides.Names ?? ["/test-container"],
    Image: "test-image",
    ImageID: "sha256:test",
    Command: "",
    Created: overrides.Created ?? 1700000000,
    Ports: [],
    Labels: overrides.Labels ?? {},
    State: overrides.State ?? "running",
    Status: overrides.Status ?? "Up 5 minutes",
    HostConfig: { NetworkMode: "default" },
    NetworkSettings: overrides.NetworkSettings ?? {
      Networks: { [NETWORK]: {} as any },
    },
    Mounts: [],
  } as ContainerInfo;
}

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "r1",
    source: "docker",
    protocol: "http",
    containerId: "abc123",
    containerName: "test-container",
    serviceName: "web",
    projectName: "proj",
    hosts: ["web.localhost"],
    urls: ["https://web.localhost"],
    status: "running",
    health: "unknown",
    createdAt: 1700000000,
    ...overrides,
  };
}

// ---- parseHostsFromRule ----

describe("parseHostsFromRule", () => {
  it("parses single host rule", () => {
    expect(parseHostsFromRule("Host(`foo.localhost`)")).toEqual([
      "foo.localhost",
    ]);
  });

  it("parses multiple hosts with ||", () => {
    expect(
      parseHostsFromRule(
        "Host(`a.localhost`) || Host(`b.localhost`)"
      )
    ).toEqual(["a.localhost", "b.localhost"]);
  });

  it("parses comma-separated hosts in single Host()", () => {
    expect(
      parseHostsFromRule("Host(`a.localhost`, `b.localhost`)")
    ).toEqual(["a.localhost", "b.localhost"]);
  });

  it("handles double-quoted hosts", () => {
    expect(parseHostsFromRule('Host("foo.localhost")')).toEqual([
      "foo.localhost",
    ]);
  });

  it("handles single-quoted hosts", () => {
    expect(parseHostsFromRule("Host('foo.localhost')")).toEqual([
      "foo.localhost",
    ]);
  });

  it("deduplicates repeated hosts", () => {
    expect(
      parseHostsFromRule(
        "Host(`foo.localhost`) || Host(`foo.localhost`)"
      )
    ).toEqual(["foo.localhost"]);
  });

  it("returns empty for empty string", () => {
    expect(parseHostsFromRule("")).toEqual([]);
  });

  it("returns empty for malformed rule (no Host matcher)", () => {
    expect(parseHostsFromRule("PathPrefix(`/api`)")).toEqual([]);
  });

  it("returns empty for Host() with empty parens", () => {
    expect(parseHostsFromRule("Host()")).toEqual([]);
  });
});

// ---- findDuplicateHosts ----

describe("findDuplicateHosts", () => {
  it("returns empty when no duplicates", () => {
    const routes = [
      makeRoute({ hosts: ["a.localhost"] }),
      makeRoute({ hosts: ["b.localhost"] }),
    ];
    expect(findDuplicateHosts(routes)).toEqual([]);
  });

  it("detects one host in two routes", () => {
    const routes = [
      makeRoute({ hosts: ["a.localhost"] }),
      makeRoute({ hosts: ["a.localhost"] }),
    ];
    expect(findDuplicateHosts(routes)).toEqual(["a.localhost"]);
  });

  it("returns sorted unique list for multiple duplicates", () => {
    const routes = [
      makeRoute({ hosts: ["b.localhost", "a.localhost"] }),
      makeRoute({ hosts: ["a.localhost"] }),
      makeRoute({ hosts: ["b.localhost"] }),
    ];
    expect(findDuplicateHosts(routes)).toEqual([
      "a.localhost",
      "b.localhost",
    ]);
  });

  it("returns empty for empty routes", () => {
    expect(findDuplicateHosts([])).toEqual([]);
  });
});

// ---- resolveRouteByName ----

describe("resolveRouteByName", () => {
  const routes = [
    makeRoute({
      id: "web",
      serviceName: "web",
      containerName: "proj-web-1",
      hosts: ["web.localhost"],
    }),
    makeRoute({
      id: "api",
      serviceName: "api",
      containerName: "proj-api-1",
      hosts: ["api.localhost"],
    }),
  ];

  it("matches by service name", () => {
    expect(resolveRouteByName(routes, "web").id).toBe("web");
  });

  it("matches by container name", () => {
    expect(resolveRouteByName(routes, "proj-api-1").id).toBe("api");
  });

  it("matches by full hostname", () => {
    expect(resolveRouteByName(routes, "api.localhost").id).toBe("api");
  });

  it("matches by shorthand (without .localhost)", () => {
    expect(resolveRouteByName(routes, "api").id).toBe("api");
  });

  it("strips protocol prefix before matching", () => {
    expect(resolveRouteByName(routes, "https://web.localhost").id).toBe("web");
  });

  it("strips trailing slash before matching", () => {
    expect(resolveRouteByName(routes, "web.localhost/").id).toBe("web");
  });

  it("throws when no match found", () => {
    expect(() => resolveRouteByName(routes, "nonexistent")).toThrow(
      "No route found"
    );
  });

  it("throws on ambiguous match", () => {
    const ambiguous = [
      makeRoute({
        id: "r1",
        serviceName: "app",
        hosts: ["app.localhost"],
      }),
      makeRoute({
        id: "r2",
        serviceName: "other",
        containerName: "app",
        hosts: ["other.localhost"],
      }),
    ];
    expect(() => resolveRouteByName(ambiguous, "app")).toThrow("ambiguous");
  });

  it("throws on empty routes", () => {
    expect(() => resolveRouteByName([], "anything")).toThrow("No route found");
  });
});

// ---- discoverRoutes ----

describe("discoverRoutes", () => {
  it("filters containers by network membership", () => {
    const onNetwork = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
        "com.docker.compose.service": "web",
        "com.docker.compose.project": "proj",
      },
    });
    const offNetwork = makeContainer({
      Id: "other",
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.api.rule": "Host(`api.localhost`)",
      },
      NetworkSettings: { Networks: { bridge: {} as any } },
    });

    const { routes } = discoverRoutes([onNetwork, offNetwork], true, NETWORK);
    expect(routes).toHaveLength(1);
    expect(routes[0].hosts).toEqual(["web.localhost"]);
  });

  it("filters by traefik.enable=true label", () => {
    const enabled = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
        "com.docker.compose.service": "web",
      },
    });
    const disabled = makeContainer({
      Id: "disabled",
      Labels: {
        "traefik.enable": "false",
        "traefik.http.routers.api.rule": "Host(`api.localhost`)",
      },
    });
    const missing = makeContainer({
      Id: "nolabel",
      Labels: {
        "traefik.http.routers.svc.rule": "Host(`svc.localhost`)",
      },
    });

    const { routes } = discoverRoutes(
      [enabled, disabled, missing],
      true,
      NETWORK
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].serviceName).toBe("web");
  });

  it("parses HTTP router labels into routes", () => {
    const container = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
        "com.docker.compose.service": "web",
        "com.docker.compose.project": "myproj",
      },
    });

    const { routes } = discoverRoutes([container], true, NETWORK);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: "web",
      protocol: "http",
      serviceName: "web",
      projectName: "myproj",
      hosts: ["web.localhost"],
      urls: ["https://web.localhost"],
      source: "docker",
    });
  });

  it("parses TCP router labels (HostSNI) into postgres routes", () => {
    const container = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.tcp.routers.db.rule": "HostSNI(`db.localhost`)",
        "com.docker.compose.service": "db",
        "com.docker.compose.project": "myproj",
      },
    });

    const { routes } = discoverRoutes([container], true, NETWORK);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: "db",
      protocol: "tcp/postgres",
      hosts: ["db.localhost"],
    });
    expect(routes[0].urls[0]).toContain("postgres://");
  });

  it("filters HostSNI(*) wildcard from TCP routes", () => {
    const container = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.tcp.routers.catchall.rule": "HostSNI(`*`)",
      },
    });

    const { routes } = discoverRoutes([container], true, NETWORK);
    expect(routes).toHaveLength(0);
  });

  it("returns duplicate hosts when hostnames collide", () => {
    const c1 = makeContainer({
      Id: "c1",
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web1.rule": "Host(`web.localhost`)",
        "com.docker.compose.service": "web1",
      },
    });
    const c2 = makeContainer({
      Id: "c2",
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web2.rule": "Host(`web.localhost`)",
        "com.docker.compose.service": "web2",
      },
    });

    const { duplicateHosts } = discoverRoutes([c1, c2], true, NETWORK);
    expect(duplicateHosts).toEqual(["web.localhost"]);
  });

  it("skips containers without router labels", () => {
    const container = makeContainer({
      Labels: {
        "traefik.enable": "true",
        // no router rule labels
      },
    });

    const { routes } = discoverRoutes([container], true, NETWORK);
    expect(routes).toHaveLength(0);
  });

  it("uses http:// scheme when TLS is disabled", () => {
    const container = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
        "com.docker.compose.service": "web",
      },
    });

    const { routes } = discoverRoutes([container], false, NETWORK);
    expect(routes[0].urls).toEqual(["http://web.localhost"]);
  });

  it("uses https:// scheme when TLS is enabled", () => {
    const container = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
        "com.docker.compose.service": "web",
      },
    });

    const { routes } = discoverRoutes([container], true, NETWORK);
    expect(routes[0].urls).toEqual(["https://web.localhost"]);
  });

  it("handles multiple routers on same container", () => {
    const container = makeContainer({
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
        "traefik.http.routers.api.rule": "Host(`api.localhost`)",
        "com.docker.compose.service": "multi",
      },
    });

    const { routes } = discoverRoutes([container], true, NETWORK);
    expect(routes).toHaveLength(2);
    const hosts = routes.flatMap((r) => r.hosts).sort();
    expect(hosts).toEqual(["api.localhost", "web.localhost"]);
  });

  it("normalizes container name by stripping leading slash", () => {
    const container = makeContainer({
      Names: ["/proj-web-1"],
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
      },
    });

    const { routes } = discoverRoutes([container], true, NETWORK);
    expect(routes[0].containerName).toBe("proj-web-1");
  });

  it("extracts health from status text", () => {
    const healthy = makeContainer({
      Status: "Up 5 minutes (healthy)",
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
      },
    });

    const { routes } = discoverRoutes([healthy], true, NETWORK);
    expect(routes[0].health).toBe("healthy");
  });

  it("detects unhealthy from status text", () => {
    const unhealthy = makeContainer({
      Status: "Up 5 minutes (unhealthy)",
      Labels: {
        "traefik.enable": "true",
        "traefik.http.routers.web.rule": "Host(`web.localhost`)",
      },
    });

    const { routes } = discoverRoutes([unhealthy], true, NETWORK);
    expect(routes[0].health).toBe("unhealthy");
  });

  it("returns empty routes for empty containers", () => {
    const { routes, duplicateHosts } = discoverRoutes([], true, NETWORK);
    expect(routes).toEqual([]);
    expect(duplicateHosts).toEqual([]);
  });
});

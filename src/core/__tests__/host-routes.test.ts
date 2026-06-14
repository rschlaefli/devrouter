import { describe, expect, it } from "vitest";
import { buildHostRoutesDocument, parseUpstream } from "../host-routes";
import { HostRouteState } from "../../types";

function makeRoute(overrides: Partial<HostRouteState>): HostRouteState {
  return {
    id: "/repo::app",
    name: "app",
    host: "app.localhost",
    protocol: "http",
    repoPath: "/repo",
    port: 3000,
    mode: "proxy",
    upstreamHost: "app-app",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("parseUpstream", () => {
  it("parses host:port", () => {
    expect(parseUpstream("example.localhost:8080")).toEqual({
      host: "example.localhost",
      port: 8080,
      upstreamHost: "example.localhost"
    });
  });

  it("rewrites loopback hosts to host.docker.internal (Traefik runs in Docker)", () => {
    for (const loopback of ["localhost", "127.0.0.1", "0.0.0.0"]) {
      const result = parseUpstream(`${loopback}:3000`);
      expect(result.port).toBe(3000);
      expect(result.upstreamHost).toBe("host.docker.internal");
    }
  });

  it("passes host.docker.internal through verbatim", () => {
    expect(parseUpstream("host.docker.internal:3000").upstreamHost).toBe("host.docker.internal");
  });

  it("accepts underscores in the host (docker compose service names)", () => {
    expect(parseUpstream("my_service:3000")).toEqual({
      host: "my_service",
      port: 3000,
      upstreamHost: "my_service"
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseUpstream("  127.0.0.1:3000  ").port).toBe(3000);
  });

  it("rejects missing port", () => {
    expect(() => parseUpstream("127.0.0.1")).toThrow("host:port");
  });

  it("rejects non-numeric port", () => {
    expect(() => parseUpstream("127.0.0.1:abc")).toThrow("host:port");
  });

  it("rejects out-of-range port", () => {
    expect(() => parseUpstream("127.0.0.1:70000")).toThrow("between 1 and 65535");
  });
});

describe("buildHostRoutesDocument", () => {
  it("emits an http Host() router for http routes and no tcp section", () => {
    const doc = buildHostRoutesDocument([makeRoute({})], true) as any;
    const key = "host-repo-app";
    expect(doc.http.routers[key].rule).toBe("Host(`app.localhost`)");
    expect(doc.http.routers[key].tls).toBe(true);
    expect(doc.http.services[key].loadBalancer.servers[0].url).toBe("http://app-app:3000");
    expect(doc.tcp).toBeUndefined();
  });

  it("emits a tcp HostSNI() router with the protocol entrypoint, tls, and an address backend", () => {
    const route = makeRoute({
      id: "/repo::db",
      name: "db",
      host: "db.app.localhost",
      protocol: "tcp",
      tcpProtocol: "postgres",
      port: 5432,
      upstreamHost: "app-db"
    });
    const doc = buildHostRoutesDocument([route], true) as any;
    const key = "host-repo-db";
    expect(doc.tcp.routers[key].rule).toBe("HostSNI(`db.app.localhost`)");
    expect(doc.tcp.routers[key].entryPoints).toEqual(["postgres"]);
    expect(doc.tcp.services[key].loadBalancer.servers[0].address).toBe("app-db:5432");
    // Postgres direct-SSL clients require the server to negotiate ALPN
    // `postgresql`; the router must reference a TLSOption that offers it.
    expect(doc.tcp.routers[key].tls.options).toBe("devrouter-tcp-postgres@file");
    expect(doc.tls.options["devrouter-tcp-postgres"].alpnProtocols).toEqual(["postgresql"]);
    // TCP routes must not leak into the http section.
    expect(doc.http.routers[key]).toBeUndefined();
  });

  it("maps redis to its own entrypoint", () => {
    const route = makeRoute({
      id: "/repo::cache",
      protocol: "tcp",
      tcpProtocol: "redis",
      port: 6379
    });
    const doc = buildHostRoutesDocument([route], true) as any;
    expect(doc.tcp.routers["host-repo-cache"].entryPoints).toEqual(["redis"]);
  });
});

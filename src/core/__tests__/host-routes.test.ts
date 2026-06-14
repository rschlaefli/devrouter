import { describe, expect, it } from "vitest";
import { parseUpstream } from "../host-routes";

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

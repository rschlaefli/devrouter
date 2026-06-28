import { describe, expect, it } from "vitest";
import {
  DEP_ENV_SUFFIXES,
  DEPENDENCY_ONLY_RUNTIME,
  POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE,
  POSTGRES_DEPENDENCY_URL_TEMPLATE,
  RUNTIME_PROTOCOL_COMPATIBILITY,
  SECRET_MANAGER_ENV_PLACEHOLDER,
  SUPPORTED_PROTOCOLS,
  SUPPORTED_RUNTIMES,
  SUPPORTED_TCP_PROTOCOLS,
  WORKSPACE_PLACEHOLDER,
  buildPostgresDependencyShadowUrl,
  buildPostgresDependencyUrl,
  formatSupportedProtocolsForRuntime,
  formatSupportedTcpProtocols
} from "../capabilities";

describe("capability facts", () => {
  it("publishes stable runtime and protocol facts", () => {
    expect(SUPPORTED_RUNTIMES).toEqual(["host", "docker", "proxy"]);
    expect(SUPPORTED_PROTOCOLS).toEqual(["http", "tcp"]);
    expect(SUPPORTED_TCP_PROTOCOLS).toEqual(["postgres", "redis", "mariadb", "mysql"]);
    expect(formatSupportedTcpProtocols()).toBe("postgres, redis, mariadb, mysql");
    expect(DEPENDENCY_ONLY_RUNTIME).toBe("docker");
  });

  it("publishes runtime/protocol compatibility facts", () => {
    expect(RUNTIME_PROTOCOL_COMPATIBILITY.host).toEqual(["http"]);
    expect(RUNTIME_PROTOCOL_COMPATIBILITY.docker).toEqual(["http", "tcp"]);
    expect(RUNTIME_PROTOCOL_COMPATIBILITY.proxy).toEqual(["http", "tcp"]);
    expect(formatSupportedProtocolsForRuntime("proxy")).toBe("http, tcp");
  });

  it("publishes placeholders and dependency env suffixes", () => {
    expect(WORKSPACE_PLACEHOLDER).toBe("${WORKSPACE}");
    expect(SECRET_MANAGER_ENV_PLACEHOLDER).toBe("{env}");
    expect(DEP_ENV_SUFFIXES).toEqual(["HOST", "PORT", "URL", "SHADOW_URL"]);
  });

  it("publishes postgres dependency URL facts", () => {
    expect(POSTGRES_DEPENDENCY_URL_TEMPLATE).toBe("postgres://prisma:prisma@localhost:<port>/prisma");
    expect(POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE).toBe("postgres://prisma:prisma@localhost:<port>/shadow");
    expect(buildPostgresDependencyUrl(55432)).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(buildPostgresDependencyShadowUrl(55432)).toBe("postgres://prisma:prisma@localhost:55432/shadow");
  });
});

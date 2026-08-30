import { describe, expect, it } from "vitest";
import type { DevrouterConfig } from "../../types";
import { buildProfileResolutionReport } from "../profile-resolution";

function config(): DevrouterConfig {
  return {
    version: 1,
    managedRuntime: {
      devcontainer: {
        baseServices: ["postgres"],
        profileServices: ["mailhog", "redis"],
      },
      processes: ["local-mcp", "web"],
    },
    profiles: {
      manage: {
        apps: ["web", "api"],
        readiness: ["web"],
        devcontainerServices: ["redis"],
        processes: ["web"],
      },
      pwa: {
        apps: ["student", "api"],
        devcontainerServices: ["redis"],
        processes: ["web"],
      },
      ai: {
        apps: [],
        devcontainerServices: ["mailhog"],
      },
      full: {
        apps: ["*"],
        devcontainerServices: ["*"],
        processes: ["*"],
        default: true,
      },
    },
    apps: [
      {
        name: "api",
        host: "api.example.localhost",
        protocol: "http",
        runtime: "proxy",
        upstream: "app:3000",
        dependencies: [{ app: "db" }],
      },
      {
        name: "student",
        host: "student.example.localhost",
        protocol: "http",
        runtime: "proxy",
        upstream: "app:3001",
        dependencies: [],
      },
      {
        name: "web",
        host: "web.example.localhost",
        protocol: "http",
        runtime: "proxy",
        upstream: "app:3002",
        dependencies: [],
      },
      {
        name: "db-route",
        host: "db.example.localhost",
        protocol: "tcp",
        tcpProtocol: "postgres",
        runtime: "proxy",
        upstream: "db:5432",
        dependencies: [],
      },
      {
        kind: "dependency",
        name: "db",
        runtime: "docker",
        dependencies: [],
        docker: { service: "db", composeFiles: ["compose.yml"] },
      },
    ],
  };
}

describe("buildProfileResolutionReport", () => {
  it("expands the default full profile to concrete sorted resources", () => {
    expect(buildProfileResolutionReport(config(), "/repo")).toEqual({
      schemaVersion: 1,
      repoPath: "/repo",
      profile: "full",
      apps: ["api", "db-route", "student", "web"],
      dependencies: ["db"],
      readiness: ["api", "student", "web"],
      managedRuntime: {
        baseServices: ["postgres"],
        profileServices: ["mailhog", "redis"],
        services: ["mailhog", "postgres", "redis"],
        processes: ["local-mcp", "web"],
      },
    });
  });

  it("returns the exact selected runtime and dependency closure", () => {
    expect(buildProfileResolutionReport(config(), "/repo", "manage")).toEqual({
      schemaVersion: 1,
      repoPath: "/repo",
      profile: "manage",
      apps: ["api", "web"],
      dependencies: ["db"],
      readiness: ["web"],
      managedRuntime: {
        baseServices: ["postgres"],
        profileServices: ["redis"],
        services: ["postgres", "redis"],
        processes: ["web"],
      },
    });
  });

  it("expands omitted readiness for a selected app profile", () => {
    const report = buildProfileResolutionReport(config(), "/repo", "pwa");
    expect(report.readiness).toEqual(["api", "student"]);
  });

  it("expands omitted readiness independently in a merged selection", () => {
    const report = buildProfileResolutionReport(config(), "/repo", "manage,pwa");
    expect(report.readiness).toEqual(["api", "student", "web"]);
  });

  it("canonicalizes merged profile names and keeps route-free resources", () => {
    const left = buildProfileResolutionReport(config(), "/repo", "pwa, ai");
    const right = buildProfileResolutionReport(config(), "/repo", "ai,pwa,ai");

    expect(left).toEqual(right);
    expect(left.profile).toBe("ai,pwa");
    expect(left.apps).toEqual(["api", "student"]);
    expect(left.managedRuntime.profileServices).toEqual(["mailhog", "redis"]);
  });

  it("fails closed on unknown and empty selections", () => {
    expect(() => buildProfileResolutionReport(config(), "/repo", "missing")).toThrow(
      /Profile 'missing' is not defined/,
    );
    expect(() => buildProfileResolutionReport(config(), "/repo", "manage,,pwa")).toThrow(
      /empty token/,
    );
  });

  it("returns empty managed sets for legacy configurations", () => {
    const legacy = config();
    delete legacy.managedRuntime;
    delete legacy.profiles;

    expect(buildProfileResolutionReport(legacy, "/repo").managedRuntime).toEqual({
      baseServices: [],
      profileServices: [],
      services: [],
      processes: [],
    });
  });
});

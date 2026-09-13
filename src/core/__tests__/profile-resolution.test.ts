import { describe, expect, it } from "vitest";
import type { DevrouterConfig, DevrouterProfile } from "../../types";
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
  function managedConfigWithFull(full: DevrouterProfile): DevrouterConfig {
    const base = config();
    return { ...base, profiles: { ...base.profiles, full: { default: true, ...full } } };
  }

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

  it("reports every dimension a declared finite full profile widens", () => {
    const report = buildProfileResolutionReport(managedConfigWithFull({ apps: ["web"] }), "/repo");

    expect(report.apps).toEqual(["api", "db-route", "student", "web"]);
    expect(report.managedRuntime.profileServices).toEqual(["mailhog", "redis"]);
    expect(report.managedRuntime.processes).toEqual(["local-mcp", "web"]);
    expect(report.notices).toEqual([
      {
        code: "MANAGED_FULL_PROFILE_EXPANSION",
        profile: "full",
        dimensions: ["apps", "devcontainerServices", "processes"],
        remedy: { code: "SET_NAMED_DEFAULT_PROFILE", profiles: ["ai", "manage", "pwa"] },
      },
    ]);
  });

  it("reports only the omitted dimensions a partly wildcard full profile widens", () => {
    const report = buildProfileResolutionReport(managedConfigWithFull({ apps: ["*"] }), "/repo");

    expect(report.notices?.[0]?.dimensions).toEqual(["devcontainerServices", "processes"]);
  });

  it("stays quiet when the full profile already declares every wildcard", () => {
    expect(buildProfileResolutionReport(config(), "/repo").notices).toBeUndefined();
  });

  it("stays quiet when finite full declarations already equal the registries", () => {
    const report = buildProfileResolutionReport(
      managedConfigWithFull({
        apps: ["api", "db-route", "student", "web"],
        devcontainerServices: ["mailhog", "redis"],
        processes: ["local-mcp", "web"],
      }),
      "/repo",
    );

    expect(report.notices).toBeUndefined();
    expect(report.apps).toEqual(["api", "db-route", "student", "web"]);
  });

  it("reports the same expansion for the explicit and default single selections", () => {
    const merged = managedConfigWithFull({
      apps: ["web"],
      devcontainerServices: ["redis"],
      processes: ["web"],
    });

    const explicit = buildProfileResolutionReport(merged, "/repo", "full");
    const byDefault = buildProfileResolutionReport(merged, "/repo");

    expect(explicit).toEqual(byDefault);
    expect(explicit.notices?.[0]?.dimensions).toEqual([
      "apps",
      "devcontainerServices",
      "processes",
    ]);
    expect(explicit.apps).toEqual(["api", "db-route", "student", "web"]);
    expect(explicit.managedRuntime.services).toEqual(["mailhog", "postgres", "redis"]);
    expect(explicit.managedRuntime.processes).toEqual(["local-mcp", "web"]);
  });

  it("keeps combined selections literal and does not report full expansion", () => {
    const cfg = managedConfigWithFull({
      apps: ["web"],
      devcontainerServices: ["redis"],
      processes: ["web"],
    });
    cfg.profiles = {
      ...cfg.profiles,
      manage: { apps: ["api"], devcontainerServices: ["mailhog"], processes: ["local-mcp"] },
    };

    const report = buildProfileResolutionReport(cfg, "/repo", "full,manage");

    expect(report.profile).toBe("full,manage");
    expect(report.notices).toBeUndefined();
    expect(report.apps).toEqual(["api", "web"]);
    expect(report.managedRuntime.profileServices).toEqual(["mailhog", "redis"]);
    expect(report.managedRuntime.processes).toEqual(["local-mcp", "web"]);
  });

  it("deduplicates a repeated full selection and reports the expansion once", () => {
    const report = buildProfileResolutionReport(
      managedConfigWithFull({ apps: ["web"] }),
      "/repo",
      "full,full",
    );

    expect(report.profile).toBe("full");
    expect(report.notices).toHaveLength(1);
    expect(report.apps).toEqual(["api", "db-route", "student", "web"]);
  });

  it("does not report for non-managed configurations and keeps declared membership", () => {
    const nonManaged = config();
    delete nonManaged.managedRuntime;
    nonManaged.profiles = { full: { apps: ["web"], default: true } };

    const report = buildProfileResolutionReport(nonManaged, "/repo");

    expect(report.notices).toBeUndefined();
    expect(report.apps).toEqual(["web"]);
    expect(report.managedRuntime).toEqual({
      baseServices: [],
      profileServices: [],
      services: [],
      processes: [],
    });
  });

  it("does not report implicit full behavior when no full profile is declared", () => {
    const cfg = config();
    cfg.profiles = { manage: { apps: ["web"] } };

    const report = buildProfileResolutionReport(cfg, "/repo");

    expect(report.profile).toBe("full");
    expect(report.notices).toBeUndefined();
    expect(report.apps).toEqual(["api", "db-route", "student", "web"]);
  });

  it("reports a declared finite full profile that no default selection honours", () => {
    const cfg = config();
    cfg.profiles = { manage: { apps: ["api"] }, full: { apps: ["web"] } };

    const report = buildProfileResolutionReport(cfg, "/repo");

    expect(report.profile).toBe("full");
    expect(report.notices?.[0]?.dimensions).toEqual(["apps", "devcontainerServices", "processes"]);
    expect(report.notices?.[0]?.remedy).toEqual({
      code: "SET_NAMED_DEFAULT_PROFILE",
      profiles: ["manage"],
    });
    expect(report.apps).toEqual(["api", "db-route", "student", "web"]);
  });
});

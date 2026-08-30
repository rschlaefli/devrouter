import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProfilePlanCommand } from "../../commands/profile";
import type { DevrouterConfig } from "../../types";
import {
  buildProfilePlanReport,
  parseProfilePlanContract,
  resolveProfilePlan,
} from "../profile-plan";
import { buildProfileResolutionReport } from "../profile-resolution";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function config(): DevrouterConfig {
  return {
    version: 1,
    managedRuntime: {
      devcontainer: {
        baseServices: ["postgres"],
        profileServices: ["redis", "mailhog"],
      },
      processes: ["web", "mcp"],
    },
    profiles: {
      manage: {
        apps: ["api", "web"],
        readiness: ["web"],
        devcontainerServices: ["redis"],
        processes: ["web"],
        default: true,
      },
      empty: {
        apps: [],
        devcontainerServices: [],
        processes: [],
      },
      unsupported: {
        apps: ["api"],
        devcontainerServices: ["mailhog"],
        processes: ["mcp"],
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
        name: "web",
        host: "web.example.localhost",
        protocol: "http",
        runtime: "proxy",
        upstream: "app:3001",
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

const source = `
version: 1
apps:
  requireNonEmpty: true
  mappings:
    api:
      bindings:
        filters: ['--filter=api']
        endpoints: ['http://127.0.0.1:3000/healthz']
    web:
      bindings:
        filters: ['--filter=web', '--filter=shared']
        endpoints: ['http://127.0.0.1:3001']
dependencies:
  allowed: [db]
managedRuntime:
  services:
    allowed: [postgres, redis]
  processes:
    exact: [web]
`;

const registry = {
  apps: ["api", "web"],
  dependencies: ["db"],
  managedServices: ["mailhog", "postgres", "redis"],
  managedProcesses: ["mcp", "web"],
};

function createRepository(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-profile-plan-"));
  temporaryDirectories.push(repoPath);
  fs.writeFileSync(
    path.join(repoPath, ".devrouter.yml"),
    `
version: 1
managedRuntime:
  devcontainer:
    baseServices: [postgres]
    profileServices: [redis]
  processes: [web]
profiles:
  manage:
    apps: [api, web]
    devcontainerServices: [redis]
    processes: [web]
    default: true
apps:
  - name: api
    host: api.example.localhost
    protocol: http
    runtime: proxy
    upstream: app:3000
  - name: web
    host: web.example.localhost
    protocol: http
    runtime: proxy
    upstream: app:3001
`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(repoPath, "plan.yml"),
    source.replace("allowed: [db]", "allowed: []"),
    "utf-8",
  );
  return repoPath;
}

describe("profile plan contract", () => {
  it("emits deterministic literal bindings for exact selected resources", () => {
    const report = buildProfileResolutionReport(config(), "/repo", "manage");
    const plan = buildProfilePlanReport({
      report,
      contract: parseProfilePlanContract(source),
      registry,
      contractPath: "ci/profile-plan.yml",
    });

    expect(plan).toEqual({
      ...report,
      contractPath: "ci/profile-plan.yml",
      bindings: {
        endpoints: ["http://127.0.0.1:3000/healthz", "http://127.0.0.1:3001"],
        filters: ["--filter=api", "--filter=web", "--filter=shared"],
      },
    });
  });

  it("fails closed for unmapped apps and unsupported selected resources", () => {
    const report = buildProfileResolutionReport(config(), "/repo", "manage");
    const contract = parseProfilePlanContract(source);
    delete contract.apps.mappings.web;
    expect(() =>
      buildProfilePlanReport({ report, contract, registry, contractPath: "plan.yml" }),
    ).toThrow(/no contract mapping: web/);

    const unsupported = buildProfileResolutionReport(config(), "/repo", "unsupported");
    expect(() =>
      buildProfilePlanReport({
        report: unsupported,
        contract: parseProfilePlanContract(source),
        registry,
        contractPath: "plan.yml",
      }),
    ).toThrow(/managedRuntime.services selects unsupported resources: mailhog/);
  });

  it("rejects contract mappings and policies for unknown resources", () => {
    const report = buildProfileResolutionReport(config(), "/repo", "manage");
    const contract = parseProfilePlanContract(
      source.replace(
        "    web:\n",
        "    stale-app:\n      bindings:\n        filters: ['--filter=stale']\n    web:\n",
      ),
    );
    expect(() =>
      buildProfilePlanReport({ report, contract, registry, contractPath: "plan.yml" }),
    ).toThrow(/apps\.mappings contains unknown resources: stale-app/);

    const unknownService = parseProfilePlanContract(
      source.replace("allowed: [postgres, redis]", "allowed: [postgres, redis, stale-service]"),
    );
    expect(() =>
      buildProfilePlanReport({
        report,
        contract: unknownService,
        registry,
        contractPath: "plan.yml",
      }),
    ).toThrow(/managedRuntime\.services\.allowed contains unknown resources: stale-service/);
  });

  it("requires exact managed processes and a non-empty app selection", () => {
    const contract = parseProfilePlanContract(source);
    const unsupported = buildProfileResolutionReport(config(), "/repo", "unsupported");
    contract.managedRuntime.services.allowed.push("mailhog");
    expect(() =>
      buildProfilePlanReport({ report: unsupported, contract, registry, contractPath: "plan.yml" }),
    ).toThrow(/managedRuntime.processes must equal \[web\]/);

    const empty = buildProfileResolutionReport(config(), "/repo", "empty");
    expect(() =>
      buildProfilePlanReport({
        report: empty,
        contract: parseProfilePlanContract(source),
        registry,
        contractPath: "plan.yml",
      }),
    ).toThrow(/must contain at least one app/);
  });

  it("rejects unknown keys, duplicate literals, aliases, and invalid binding keys", () => {
    expect(() =>
      parseProfilePlanContract(source.replace("version: 1", "version: 1\nextra: true")),
    ).toThrow(/unsupported keys: extra/);
    expect(() =>
      parseProfilePlanContract(
        source.replace("['--filter=api']", "['--filter=api', '--filter=api']"),
      ),
    ).toThrow(/must not contain duplicates/);
    expect(() =>
      parseProfilePlanContract(source.replace("filters: ['--filter=api']", "bad.key: ['x']")),
    ).toThrow(/binding key 'bad.key'/);
    expect(() =>
      parseProfilePlanContract(
        source
          .replace("allowed: [db]", "allowed: &deps [db]")
          .replace("allowed: [postgres, redis]", "allowed: *deps"),
      ),
    ).toThrow(/alias/i);
  });

  it("bounds the number of repository mappings", () => {
    const mappings = Array.from(
      { length: 257 },
      (_, index) =>
        `    app-${index}:\n      bindings:\n        filters: ['--filter=app-${index}']`,
    ).join("\n");
    const oversized = source.replace(
      / {2}mappings:\n[\s\S]*?dependencies:/,
      `  mappings:\n${mappings}\ndependencies:`,
    );

    expect(() => parseProfilePlanContract(oversized)).toThrow(
      /apps\.mappings exceeds the limit of 256/,
    );
  });
});

describe("resolveProfilePlan", () => {
  it("resolves a non-Git repository and rejects path escape and symlinks", () => {
    const repoPath = createRepository();

    const plan = resolveProfilePlan({ repo: repoPath, contract: "plan.yml" });
    expect(plan.profile).toBe("manage");
    expect(plan.bindings.filters).toEqual(["--filter=api", "--filter=web", "--filter=shared"]);
    expect(() => resolveProfilePlan({ repo: repoPath, contract: "../outside.yml" })).toThrow(
      /escapes the repository root/,
    );

    fs.symlinkSync(path.join(repoPath, "plan.yml"), path.join(repoPath, "linked-plan.yml"));
    expect(() => resolveProfilePlan({ repo: repoPath, contract: "linked-plan.yml" })).toThrow(
      /must be a regular file, not a symlink/,
    );

    fs.writeFileSync(path.join(repoPath, "large.yml"), "x".repeat(1024 * 1024 + 1));
    expect(() => resolveProfilePlan({ repo: repoPath, contract: "large.yml" })).toThrow(
      /1048576-byte limit/,
    );
  });

  it("atomically replaces an output symlink with mode 0600 without changing its target", async () => {
    const repoPath = createRepository();
    const sentinel = path.join(repoPath, "sentinel.txt");
    const output = path.join(repoPath, "output.json");
    fs.writeFileSync(sentinel, "unchanged\n", { encoding: "utf-8", mode: 0o644 });
    fs.symlinkSync(sentinel, output);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await runProfilePlanCommand({ repo: repoPath, contract: "plan.yml", output });
    } finally {
      stdout.mockRestore();
    }

    expect(fs.readFileSync(sentinel, "utf-8")).toBe("unchanged\n");
    expect(fs.lstatSync(output).isSymbolicLink()).toBe(false);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(output, "utf-8"))).toMatchObject({
      schemaVersion: 1,
      contractPath: "plan.yml",
      profile: "manage",
    });
  });
});

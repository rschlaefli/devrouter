import { describe, expect, it } from "vitest";
import { proveManagedCapacityPopulation } from "../capacity-population-proof";
import type { ManagedStopContainerSnapshot } from "../devpod-environment";
import type { ManagedStopBaseline } from "../managed-stop-baseline";

const repoPath = "/synthetic/repo";
const composeProject = "synthetic-project";
const endpoint = "unix:///synthetic/docker.sock";
const daemonId = "synthetic-daemon";
const composeDirectory = `${repoPath}/.devcontainer`;
const composeFiles = [`${composeDirectory}/compose.yml`, `${composeDirectory}/override.yml`];
const appId = "a".repeat(64);
const databaseId = "b".repeat(64);

function mount(Type: string, Source: string, Destination: string) {
  return { Type, Source, Destination };
}

function baselineContainer(
  id: string,
  service: string,
  mounts: ManagedStopBaseline["containers"][number]["mounts"],
) {
  return { id, service, configFiles: composeFiles, mounts };
}

const baseline: ManagedStopBaseline = {
  version: 1,
  provider: "devsy",
  context: "synthetic",
  providerId: "synthetic-provider",
  uid: "synthetic-uid",
  sourcePath: repoPath,
  sourceContainer: appId,
  endpoint,
  daemonId,
  sourceConfigSha256: "c".repeat(64),
  effectiveConfigSha256: "d".repeat(64),
  project: composeProject,
  primaryService: "app",
  requiredServices: ["app", "db"],
  allowedServices: ["app", "db"],
  composeDirectory,
  composeFiles,
  featureDirectory: `${composeDirectory}/features`,
  containers: [
    baselineContainer(appId, "app", [
      mount("bind", repoPath, "/workspaces/app"),
      mount("tmpfs", "", "/run/synthetic"),
    ]),
    baselineContainer(databaseId, "db", [mount("volume", "/synthetic/volume/db", "/var/lib/db")]),
  ],
};

function snapshot(
  id: string,
  service: string,
  running: boolean,
  mounts: ManagedStopContainerSnapshot["mounts"],
  configFiles = composeFiles,
): ManagedStopContainerSnapshot {
  return {
    id,
    state: {
      Status: running ? "running" : "exited",
      Running: running,
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    labels: {
      "com.docker.compose.project": composeProject,
      "com.docker.compose.service": service,
      "com.docker.compose.project.working_dir": composeDirectory,
      "com.docker.compose.project.config_files": configFiles.join(","),
      "com.docker.compose.config-hash": "hash",
    },
    mounts,
    networks: {},
  };
}

function population() {
  return [
    snapshot(
      appId,
      "app",
      true,
      [mount("tmpfs", "", "/run/synthetic"), mount("bind", repoPath, "/workspaces/app")],
      composeFiles,
    ),
    snapshot(
      databaseId,
      "db",
      false,
      [mount("volume", "/synthetic/volume/db", "/var/lib/db")],
      composeFiles,
    ),
  ];
}

function prove(
  containers = population(),
  overrides: Partial<Parameters<typeof proveManagedCapacityPopulation>[0]> = {},
) {
  return proveManagedCapacityPopulation({
    containers,
    baseline,
    repoPath,
    composeProject,
    daemonId,
    endpoint,
    ...overrides,
  });
}

describe("proveManagedCapacityPopulation", () => {
  it("accepts an exact retained population including stopped containers and normalizes order", () => {
    const observed = population();
    const before = structuredClone(observed);

    const result = prove(observed);

    expect(result.map((container) => container.id)).toEqual([appId, databaseId]);
    expect(result[0].mounts).toEqual(
      [mount("tmpfs", "", "/run/synthetic"), mount("bind", repoPath, "/workspaces/app")].sort(
        (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    );
    expect(result[0].labels["com.docker.compose.project.config_files"]).toBe(
      composeFiles.join(","),
    );
    expect(result[1].state.Status).toBe("exited");
    expect(observed).toEqual(before);
  });

  it("rejects reversed Compose config file order", () => {
    const observed = population();
    for (const container of observed) {
      container.labels["com.docker.compose.project.config_files"] = [...composeFiles]
        .reverse()
        .join(",");
    }
    expect(() => prove(observed)).toThrow();
  });

  it.each([
    ["daemon", { daemonId: "other-daemon" }],
    ["project", { composeProject: "other-project" }],
    ["endpoint", { endpoint: "unix:///other.sock" }],
    ["source", { repoPath: "/synthetic/other-repo" }],
  ] as const)("rejects mismatched retained %s identity", (_name, override) => {
    expect(() => prove(population(), override)).toThrow();
  });

  it.each([
    "missing",
    "extra",
    "replaced",
  ] as const)("rejects %s container population", (change) => {
    const observed = population();
    if (change === "missing") observed.pop();
    if (change === "extra") observed.push(snapshot("e".repeat(64), "worker", false, []));
    if (change === "replaced") observed[1] = snapshot("e".repeat(64), "db", false, []);
    expect(() => prove(observed)).toThrow();
  });

  it.each([
    "service",
    "config",
    "mount",
    "working_dir",
  ] as const)("rejects changed %s identity", (change) => {
    const observed = population();
    if (change === "service") observed[1].labels["com.docker.compose.service"] = "cache";
    if (change === "config") {
      observed[1].labels["com.docker.compose.project.config_files"] =
        `${composeDirectory}/changed.yml`;
    }
    if (change === "mount") observed[0].mounts[0].Destination = "/run/changed";
    if (change === "working_dir") {
      observed[0].labels["com.docker.compose.project.working_dir"] = "/synthetic/other";
    }
    expect(() => prove(observed)).toThrow();
  });

  it.each(["duplicate id", "duplicate service"] as const)("rejects %s attribution", (change) => {
    const observed = population();
    if (change === "duplicate id") observed[1].id = appId;
    if (change === "duplicate service") observed[1].labels["com.docker.compose.service"] = "app";
    expect(() => prove(observed)).toThrow();
  });

  it("rejects empty populations instead of inferring absence", () => {
    expect(() => prove([])).toThrow();
  });

  it("requires exactly one primary bind mount for the retained repository", () => {
    const observed = population();
    observed[0].mounts.push(mount("bind", repoPath, "/workspaces/other"));
    expect(() => prove(observed)).toThrow();
  });
});

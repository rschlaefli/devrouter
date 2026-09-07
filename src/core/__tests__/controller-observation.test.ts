import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  captureControllerEvidence,
  controllerBindingFingerprint,
  resolveControllerBinding,
} from "../controller-binding";
import { collectControllerObservation } from "../controller-observation";
import { runControllerProbe } from "../controller-probe";
import { observeControllerProcess } from "../controller-process-observation";
import { readHostRouteStateReadOnly } from "../host-routes";
import { readManagedRuntimeState } from "../managed-runtime-state";
import { buildProfileResolutionReport } from "../profile-resolution";
import { readReliabilityOperation } from "../reliability-operation-store";
import { applyWorkspace, loadRepoConfig } from "../repo-config";

vi.mock("../controller-binding", () => ({
  captureControllerEvidence: vi.fn(),
  controllerBindingFingerprint: vi.fn(),
  resolveControllerBinding: vi.fn(),
  readControllerEvidence: vi.fn(),
}));
vi.mock("../controller-probe", () => ({ runControllerProbe: vi.fn() }));
vi.mock("../controller-process-observation", () => ({ observeControllerProcess: vi.fn() }));
vi.mock("../host-routes", async (original) => ({
  ...(await original<typeof import("../host-routes")>()),
  readHostRouteStateReadOnly: vi.fn(),
}));
vi.mock("../managed-runtime-state", () => ({
  managedRuntimeStatePath: () => "/fixture/state.json",
  readManagedRuntimeState: vi.fn(),
}));
vi.mock("../profile-resolution", () => ({ buildProfileResolutionReport: vi.fn() }));
vi.mock("../reliability-operation-store", () => ({ readReliabilityOperation: vi.fn() }));
vi.mock("../repo-config", () => ({ loadRepoConfig: vi.fn(), applyWorkspace: vi.fn() }));
vi.mock("../router", async (original) => ({
  ...(await original<typeof import("../router")>()),
  isTLSEnabled: () => false,
}));

const environment = {
  id: "fixture",
  repoPath: "/fixture/checkout",
  workspace: "fixture",
  provider: "devsy" as const,
  providerId: "provider",
  profile: "full",
  fingerprint: "a".repeat(64),
};
const source = JSON.stringify({ service: "app", dockerComposeFile: "compose.yml" });
const hash = createHash("sha256").update(source).digest("hex");
let http: string;
let snapshots: Array<{
  id: string;
  state: {
    Running: boolean;
    Status: string;
    Paused: boolean;
    Restarting: boolean;
    Dead: boolean;
    StartedAt: string;
  };
  labels: Record<string, string>;
  mounts: Array<{ Type: string; Source: string; Destination: string }>;
  networks: Record<string, unknown>;
}>;
beforeEach(() => {
  vi.resetAllMocks();
  http = "200\tapplication/json";
  snapshots = [
    {
      id: "a".repeat(64),
      state: {
        Running: true,
        Status: "running",
        Paused: false,
        Restarting: false,
        Dead: false,
        StartedAt: "2026-09-08T00:00:00Z",
      },
      labels: {
        "com.docker.compose.project": "fixture",
        "com.docker.compose.service": "app",
        "com.docker.compose.project.working_dir": "/fixture/checkout/.devcontainer",
        "com.docker.compose.project.config_files": "/fixture/checkout/.devcontainer/compose.yml",
        "com.docker.compose.config-hash": "b".repeat(64),
      },
      mounts: [{ Type: "bind", Source: environment.repoPath, Destination: "/workspace" }],
      networks: {},
    },
  ];
  vi.mocked(resolveControllerBinding).mockResolvedValue(environment);
  vi.mocked(controllerBindingFingerprint).mockReturnValue(environment.fingerprint);
  vi.mocked(captureControllerEvidence).mockReturnValue({
    contents: ["owner", "config", "fixture", "state", source, source],
    unchanged: () => true,
  });
  vi.mocked(loadRepoConfig).mockReturnValue({ version: 1, apps: [] });
  vi.mocked(applyWorkspace).mockReturnValue({
    version: 1,
    apps: [
      {
        name: "web",
        host: "web.fixture.localhost",
        protocol: "http",
        runtime: "proxy",
        upstream: "fixture-web:3000",
        dependencies: [],
        readiness: { path: "/health", contentType: "application/json" },
      },
    ],
  });
  vi.mocked(buildProfileResolutionReport).mockReturnValue({
    schemaVersion: 1,
    repoPath: environment.repoPath,
    profile: "full",
    apps: ["web"],
    dependencies: [],
    readiness: ["web"],
    managedRuntime: { baseServices: [], profileServices: [], services: [], processes: ["web"] },
  });
  vi.mocked(readManagedRuntimeState).mockReturnValue({
    version: 1,
    repoPath: environment.repoPath,
    workspace: "fixture",
    devpodId: "provider",
    composeProject: "fixture",
    profile: "full",
    desired: { apps: ["web"], services: [], processes: ["web"] },
    sourceConfigSha256: hash,
    effectiveConfigSha256: hash,
    status: "ready",
    updatedAt: "2026-09-08T00:00:00Z",
  });
  vi.mocked(readReliabilityOperation).mockReturnValue({ revision: 1 } as ReturnType<
    typeof readReliabilityOperation
  >);
  vi.mocked(readHostRouteStateReadOnly).mockReturnValue([
    {
      repoPath: environment.repoPath,
      workspace: "fixture",
      name: "web",
      host: "web.fixture.localhost",
      mode: "proxy",
      upstreamHost: "fixture-web",
      port: 3000,
    } as ReturnType<typeof readHostRouteStateReadOnly>[number],
  ]);
  vi.mocked(observeControllerProcess).mockResolvedValue("123 456 fingerprint");
  vi.mocked(runControllerProbe).mockImplementation(async (command, args) => {
    if (command === "git") return "/fixture/.git/worktrees/checkout\n/fixture/.git\n";
    if (command === "curl") return http;
    if (command === "docker" && args[0] === "compose")
      return args.includes("--hash") ? `app ${"b".repeat(64)}` : "{}";
    if (command === "docker" && args[0] === "ps")
      return snapshots.map((value) => value.id).join("\n");
    if (command === "docker" && args[0] === "inspect")
      return snapshots.map((value) => JSON.stringify(value)).join("\n");
    throw new Error("Unexpected observation command");
  });
});

const collect = () =>
  collectControllerObservation(environment, ["runtime", "app:web"], new AbortController().signal);

it("observes application contract failure without losing independently healthy tooling", async () => {
  http = "500\tapplication/json";
  const result = await collect();
  expect(result.capabilities.map((value) => [value.infrastructure, value.application])).toEqual([
    ["healthy", "verified"],
    ["healthy", "unready"],
  ]);
  expect(result.stopped).toBe(false);
});

it("keeps missing or changed process evidence unknown without removing tooling readiness", async () => {
  vi.mocked(observeControllerProcess).mockRejectedValueOnce(new Error("marker unavailable"));
  expect((await collect()).capabilities.map((value) => value.application)).toEqual([
    "verified",
    "unverified",
  ]);
  expect(vi.mocked(runControllerProbe).mock.calls.some(([command]) => command === "curl")).toBe(
    false,
  );
  vi.mocked(observeControllerProcess)
    .mockResolvedValueOnce("123 456 before")
    .mockResolvedValueOnce("123 789 after");
  expect((await collect()).capabilities.map((value) => value.application)).toEqual([
    "verified",
    "unverified",
  ]);
});

it.each([
  "Paused",
  "Restarting",
  "Dead",
] as const)("does not report a %s container as ready or stopped", async (flag) => {
  snapshots[0].state[flag] = true;
  const result = await collect();
  expect(result.capabilities.every((value) => value.application === "unverified")).toBe(true);
  expect(result.stopped).toBe(false);
});

it("rejects a container restart occurring inside the observation batch", async () => {
  vi.mocked(observeControllerProcess).mockImplementation(async () => {
    snapshots[0].state.StartedAt = "2026-09-08T00:01:00Z";
    return "123 456 fingerprint";
  });
  await expect(collect()).rejects.toThrow("Observation runtime changed.");
});

it("rejects changed resolved Compose configuration before granting capabilities", async () => {
  snapshots[0].labels["com.docker.compose.config-hash"] = "c".repeat(64);
  await expect(collect()).rejects.toThrow("Observation Compose configuration changed.");
  expect(observeControllerProcess).not.toHaveBeenCalled();
});

it("reports stopped only when all exact containers and routes are stopped", async () => {
  snapshots[0].state.Running = false;
  snapshots[0].state.Status = "exited";
  expect((await collect()).stopped).toBe(false);
  vi.mocked(readHostRouteStateReadOnly).mockReturnValue([]);
  expect((await collect()).stopped).toBe(true);
  expect(observeControllerProcess).not.toHaveBeenCalled();
});

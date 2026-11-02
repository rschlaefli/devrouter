import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedRuntimeStatus } from "../../types";
import { collectRouterStatus } from "../status";

vi.mock("../docker", () => ({
  findContainerByName: vi.fn(async () => undefined),
  getCurrentDockerContext: vi.fn(() => "default"),
  networkExists: vi.fn(async () => true),
}));

vi.mock("../managed-runtime-status", () => ({
  collectManagedRuntimeStatus: vi.fn(),
}));

vi.mock("../managed-runtime-state", () => ({
  readManagedRuntimeState: vi.fn(),
}));

vi.mock("../repo-config", () => ({
  getRepoConfigPath: vi.fn((repoPath: string) => path.join(repoPath, ".devrouter.yml")),
  loadRuntimeConfig: vi.fn(),
  resolveRepoPath: vi.fn((repoPath?: string) => repoPath ?? process.cwd()),
}));

vi.mock("../router", () => ({
  areTLSCertsPresent: vi.fn(() => false),
  DEVNET_NAME: "devnet",
  getActiveTcpProtocols: vi.fn(() => []),
  getRouterFileLayout: vi.fn(() => ({ required: [], missing: [] })),
  isTLSConfigured: vi.fn(() => false),
  isTLSEnabled: vi.fn(() => false),
  ROUTER_CONTAINER_NAME: "devrouter-traefik",
  TCP_PROTOCOL_REGISTRY: {},
}));

import { type ManagedRuntimeState, readManagedRuntimeState } from "../managed-runtime-state";
import { collectManagedRuntimeStatus } from "../managed-runtime-status";
import { loadRuntimeConfig } from "../repo-config";

let repoPath: string;

const managedStatus: ManagedRuntimeStatus = {
  mode: "managed",
  status: "ready",
  profile: "chat,manage",
  activeProfile: "chat,manage",
  workspace: "feature",
  devpodId: "devpod-feature",
  composeProject: "feature-project",
  desired: {
    apps: ["api", "chat"],
    services: ["postgres", "litellm"],
    processes: ["backend", "chat"],
  },
  active: {
    apps: ["api", "chat"],
    services: ["litellm", "postgres"],
    processes: ["backend", "chat"],
  },
  serviceStatuses: {
    litellm: "healthy",
    postgres: "healthy",
  },
  baseServiceStatuses: {},
  processStatuses: {
    backend: "running",
    chat: "running",
  },
  drift: [],
  sourceConfigSha256: "a".repeat(64),
  effectiveConfigSha256: "b".repeat(64),
};

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-status-test-"));
  fs.writeFileSync(path.join(repoPath, ".devrouter.yml"), "version: 1\napps: []\n", "utf-8");
  vi.mocked(loadRuntimeConfig).mockReturnValue({
    config: { version: 1, apps: [] },
    workspace: "feature",
    profile: "chat,manage",
    resolvedProfile: {
      apps: ["api", "chat"],
      devcontainerServices: ["litellm", "postgres"],
      processes: ["backend", "chat"],
    },
  });
  vi.mocked(collectManagedRuntimeStatus).mockReturnValue(managedStatus);
  vi.mocked(readManagedRuntimeState).mockReturnValue(undefined);
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("collectRouterStatus", () => {
  it.each([
    0, 1,
  ])("recommends exact-checkout startup for a managed profile with %i apps", async (appCount) => {
    const checkout = path.join(repoPath, "pilot's checkout $HOME");
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, ".devrouter.yml"), "version: 1\napps: []\n");
    const apps = Array.from({ length: appCount }, () => ({
      name: "web",
      protocol: "http" as const,
      runtime: "proxy" as const,
      host: "web.localhost",
      upstream: "web:3000",
      dependencies: [],
    }));
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: { version: 1, apps },
      workspace: "feature",
      profile: "full",
    });
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue({ ...managedStatus, status: "stopped" });

    const status = await collectRouterStatus(checkout);
    const command = status.insights.nextSteps
      .map((step) => step.match(/\bdevrouter ensure .*$/)?.[0])
      .find(Boolean);
    expect(command).toBeDefined();
    const argv = execFileSync(
      "/bin/sh",
      ["-c", `devrouter() { printf '%s\\0' "$@"; }\n${command}`],
      {
        encoding: "utf8",
      },
    )
      .split("\0")
      .slice(0, -1);
    expect(argv).toEqual(["ensure", checkout]);
    expect(status.insights.nextSteps.some((step) => /\bdev app (?:run|add)\b/.test(step))).toBe(
      false,
    );
  });

  it("keeps the exact checkout in both unwound mount recovery commands", async () => {
    const checkout = path.join(repoPath, "pilot's checkout $HOME");
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, ".devrouter.yml"), "version: 1\napps: []\n");
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue({
      ...managedStatus,
      mountNesting: {
        status: "unwound",
        checked: [],
        unwound: [{ destination: "/workspace/deps", source: "deps", nestedWithin: "/workspace" }],
      },
    });
    const status = await collectRouterStatus(checkout);
    const suggestion = status.insights.nextSteps.find((step) => /\bdevrouter stop\b/.test(step));
    const commands = suggestion?.match(/\bdevrouter (?:stop|ensure) .*?(?= and then | to |$)/g);
    expect(commands).toBeDefined();
    const argv = execFileSync(
      "/bin/sh",
      ["-c", ["devrouter() { printf '%s\\0' \"$@\"; }", ...commands!].join("\n")],
      { encoding: "utf8" },
    )
      .split("\0")
      .slice(0, -1);
    expect(argv).toEqual(["stop", checkout, "ensure", checkout]);
  });

  it("retains app startup guidance for a legacy repository", async () => {
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: {
        version: 1,
        apps: [
          {
            name: "web",
            protocol: "http",
            runtime: "proxy",
            host: "web.localhost",
            upstream: "web:3000",
            dependencies: [],
          },
        ],
      },
      workspace: undefined,
      profile: "full",
    });
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue({
      ...managedStatus,
      mode: "legacy",
      status: "legacy",
    });

    const status = await collectRouterStatus(repoPath);
    expect(status.insights.nextSteps.some((step) => /\bdev app run\b/.test(step))).toBe(true);
    expect(status.insights.nextSteps.some((step) => /\bdevrouter ensure\b/.test(step))).toBe(false);
  });

  it("attaches the values-free managed runtime status to a valid repository", async () => {
    const status = await collectRouterStatus(repoPath);

    expect(status.repo?.managedRuntime).toEqual(managedStatus);
    expect(collectManagedRuntimeStatus).toHaveBeenCalledWith({
      repoPath,
      workspace: "feature",
      config: { version: 1, apps: [] },
      profile: "chat,manage",
      resolvedProfile: {
        apps: ["api", "chat"],
        devcontainerServices: ["litellm", "postgres"],
        processes: ["backend", "chat"],
      },
    });
  });

  it("preserves an explicit legacy runtime status without inspecting Docker resources", async () => {
    const legacyStatus: ManagedRuntimeStatus = {
      mode: "legacy",
      status: "legacy",
      profile: "full",
      desired: { apps: [], services: [], processes: [] },
      active: { apps: [], services: [], processes: [] },
      serviceStatuses: {},
      baseServiceStatuses: {},
      processStatuses: {},
      drift: [],
    };
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      config: { version: 1, apps: [] },
      workspace: undefined,
      profile: "full",
      resolvedProfile: undefined,
    });
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue(legacyStatus);

    const status = await collectRouterStatus(repoPath);

    expect(status.repo?.managedRuntime).toEqual(legacyStatus);
    expect(collectManagedRuntimeStatus).toHaveBeenCalledWith({
      repoPath,
      workspace: undefined,
      config: { version: 1, apps: [] },
      profile: "full",
      resolvedProfile: undefined,
    });
  });

  it("uses the last active managed profile when status has no explicit selection", async () => {
    const managedConfig = {
      version: 1 as const,
      managedRuntime: {
        devcontainer: { baseServices: ["postgres"], profileServices: ["litellm"] },
        processes: ["chat"],
      },
      apps: [],
    };
    const activeState: ManagedRuntimeState = {
      version: 1,
      repoPath,
      workspace: "feature",
      devpodId: "devpod-feature",
      composeProject: "feature-project",
      profile: "ai",
      desired: { apps: [], services: ["litellm"], processes: ["chat"] },
      sourceConfigSha256: "a".repeat(64),
      effectiveConfigSha256: "b".repeat(64),
      status: "ready",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    const defaultRuntime = {
      config: managedConfig,
      workspace: "feature",
      profile: "full",
      resolvedProfile: {
        apps: ["*"],
        devcontainerServices: ["*"],
        processes: ["*"],
      },
    };
    const activeRuntime = {
      config: managedConfig,
      workspace: "feature",
      profile: "ai",
      resolvedProfile: {
        apps: [],
        devcontainerServices: ["litellm"],
        processes: ["chat"],
      },
    };
    vi.mocked(loadRuntimeConfig)
      .mockReset()
      .mockReturnValueOnce(defaultRuntime)
      .mockReturnValueOnce(activeRuntime);
    vi.mocked(readManagedRuntimeState).mockReturnValue(activeState);

    await collectRouterStatus(repoPath);

    expect(loadRuntimeConfig).toHaveBeenNthCalledWith(2, repoPath, "feature", "ai");
    expect(collectManagedRuntimeStatus).toHaveBeenCalledWith({
      repoPath,
      workspace: "feature",
      config: managedConfig,
      profile: "ai",
      resolvedProfile: activeRuntime.resolvedProfile,
    });
  });
});

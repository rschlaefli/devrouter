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
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("collectRouterStatus", () => {
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
});

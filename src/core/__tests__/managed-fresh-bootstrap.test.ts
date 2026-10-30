import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDevcontainerPlan } from "../devcontainer-profile";
import {
  assertFreshBootstrapRequest,
  createFreshBootstrap,
  verifyFreshBootstrapMounts,
  verifyFreshVolume,
} from "../managed-fresh-bootstrap";

const evidence = vi.hoisted(() => ({
  attempt: undefined as unknown,
  retained: undefined as unknown,
  registration: undefined as unknown,
  source: {} as Record<string, unknown>,
  providerVersion: "1.19.0",
}));
vi.mock("../devsy-agent", () => ({
  requireReadyDevsyAgent: () => ({ version: evidence.providerVersion }),
}));
vi.mock("../reliability-operation-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reliability-operation-store")>()),
  readReliabilityOperation: () => ({ freshBootstrap: evidence.attempt }),
}));
vi.mock("../managed-runtime-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-runtime-state")>()),
  readManagedRuntimeState: () => evidence.retained,
}));
vi.mock("../devsy-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../devsy-workspaces")>()),
  listDevsyWorkspaces: () => [],
  selectDevsyWorkspace: () => evidence.registration,
}));
vi.mock("../repo-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repo-config")>()),
  loadRepoConfig: () => ({
    managedRuntime: {
      devcontainer: {
        freshBootstrap: {
          command: ["initialize"],
          dataVolumes: ["pgdata"],
          sharedCaches: [],
        },
      },
    },
  }),
}));
vi.mock("../devcontainer-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../devcontainer-config")>()),
  readDevcontainerConfig: () => ({ source: evidence.source }),
}));

beforeEach(() => {
  evidence.attempt = undefined;
  evidence.retained = undefined;
  evidence.registration = undefined;
  evidence.source = {};
  evidence.providerVersion = "1.19.0";
});

describe("fresh initialization admission", () => {
  const identity = { repoPath: "/synthetic", workspace: null, provider: "devsy" as const };
  it.each([
    "1.19.0",
    "1.24.0",
    "1.23.0",
    "1.24.1",
    "1.25.0",
  ])("admits only explicitly qualified provider versions: %s", (version) => {
    evidence.providerVersion = version;
    const reachedPlan = new Error("synthetic plan boundary");
    const plan = vi.fn(() => {
      throw reachedPlan;
    });
    const bootstrap = createFreshBootstrap({
      identity,
      plan,
      profile: "default",
      variant: "default",
      apps: [],
      processes: [],
      onCaptured: vi.fn(),
    });
    expect(() => bootstrap.prepare("synthetic")).toThrow();
    expect(plan).toHaveBeenCalledTimes(["1.19.0", "1.24.0"].includes(version) ? 1 : 0);
  });
  it("admits an explicitly requested fresh context and leaves preserving startup alone", () => {
    expect(() => assertFreshBootstrapRequest(identity, { initializeNew: true })).not.toThrow();
    evidence.attempt = { stage: "failed" };
    expect(() => assertFreshBootstrapRequest(identity, {})).not.toThrow();
  });
  it.each([
    "claimed",
    "initializing",
    "failed",
    "initialized",
    "ready",
  ])("refuses replay after %s even if registration and runtime records disappear", (stage) => {
    evidence.attempt = { stage };
    expect(() => assertFreshBootstrapRequest(identity, { initializeNew: true })).toThrow();
  });
  it.each(["retained", "registration"] as const)("requires positive absence of %s", (key) => {
    evidence[key] = {};
    expect(() => assertFreshBootstrapRequest(identity, { initializeNew: true })).toThrow();
  });
  it("refuses repair and unsupported providers", () => {
    expect(() =>
      assertFreshBootstrapRequest(identity, { initializeNew: true, repair: true }),
    ).toThrow();
    expect(() =>
      assertFreshBootstrapRequest({ ...identity, provider: "devpod" }, { initializeNew: true }),
    ).toThrow();
  });
  it.each([
    { remoteEnv: { PATH: "/custom" } },
    { userEnvProbe: "none" },
    { secrets: { SYNTHETIC: {} } },
    { features: { synthetic: {} } },
    { onCreateCommand: ["initialize"] },
    { updateContentCommand: ["initialize"] },
    { postStartCommand: ["start"] },
  ])("refuses unqualified execution or hook context %#", (source) => {
    evidence.source = source;
    expect(() => assertFreshBootstrapRequest(identity, { initializeNew: true })).toThrow();
  });
});

const volume = () => ({
  Name: "synthetic-project_pgdata",
  Driver: "local",
  Scope: "local",
  CreatedAt: "2026-01-01T00:00:00Z",
  Mountpoint: "/var/lib/docker/volumes/synthetic-project_pgdata/_data",
  Options: null,
  Labels: {
    "com.docker.compose.project": "synthetic-project",
    "com.docker.compose.volume": "pgdata",
  },
});

describe("fresh initialization mount boundary", () => {
  it("allows only the primary service's same-path exact Git common directory outside a linked checkout", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-fresh-mount-")));
    try {
      const repo = path.join(root, "checkout");
      const common = path.join(root, "common.git");
      fs.mkdirSync(repo);
      fs.mkdirSync(common);
      const plan = { desiredServices: ["app"], primaryService: "app" } as ManagedDevcontainerPlan;
      const declaration = { command: ["initialize"], dataVolumes: [], sharedCaches: [] };
      const workspace = { token: "synthetic", gitCommonDir: common };
      const mount = { type: "bind", source: common, target: common };
      const model = { services: { app: { volumes: [mount] } } };
      expect(() =>
        verifyFreshBootstrapMounts(repo, plan, model, declaration, workspace),
      ).not.toThrow();
      expect(() => verifyFreshBootstrapMounts(repo, plan, model, declaration)).toThrow();
      mount.target = "/unrelated";
      expect(() => verifyFreshBootstrapMounts(repo, plan, model, declaration, workspace)).toThrow();
      mount.target = common;
      mount.source = root;
      expect(() => verifyFreshBootstrapMounts(repo, plan, model, declaration, workspace)).toThrow();
      mount.source = common;
      plan.primaryService = "another-service";
      expect(() => verifyFreshBootstrapMounts(repo, plan, model, declaration, workspace)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fresh data-volume evidence", () => {
  it("accepts a newly observed exact local project volume", () => {
    expect(() =>
      verifyFreshVolume(volume(), "pgdata", "synthetic-project", [], false),
    ).not.toThrow();
  });

  it("refuses retained contents even when the volume has current ownership labels", () => {
    const data = volume();
    const prior = [createHash("sha256").update(data.Name).digest("hex")];
    expect(() => verifyFreshVolume(data, "pgdata", "synthetic-project", prior, false)).toThrow();
    expect(() => verifyFreshVolume(data, "pgdata", "synthetic-project", prior, true)).not.toThrow();
  });

  it.each([
    { Driver: "remote" },
    { Scope: "global" },
    { CreatedAt: "unavailable" },
    { Mountpoint: "relative" },
    { Options: { type: "none", device: "/retained-data", o: "bind" } },
    { Options: "unavailable" },
    {
      Labels: {
        "com.docker.compose.project": "another-project",
        "com.docker.compose.volume": "pgdata",
      },
    },
    {
      Labels: {
        "com.docker.compose.project": "synthetic-project",
        "com.docker.compose.volume": "another-key",
      },
    },
  ])("refuses unqualified, foreign or retained-backed storage %#", (patch) => {
    expect(() =>
      verifyFreshVolume({ ...volume(), ...patch }, "pgdata", "synthetic-project", [], false),
    ).toThrow();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGlobalToolChecks } from "../tool-diagnostics";

const spawnSyncMock = vi.fn();
const runtimeState = vi.hoisted(() => ({
  resolution: {
    runtime: "devpod" as "devpod" | "devsy",
    source: "auto-detect" as
      | "override"
      | "env"
      | "path-owner"
      | "machine-config"
      | "auto-detect"
      | "default",
  },
  config: {} as Record<string, unknown>,
  inspection: { exists: false, config: {}, problems: [] as string[] },
  requestedRepoPath: undefined as string | undefined,
  ownershipProblem: undefined as string | undefined,
  agent: {
    state: "missing" as "ready" | "missing" | "stale" | "invalid",
    source: "managed" as "managed" | "explicit",
    reason: "the selected source is missing",
    installedVersion: "1.16.2",
    asset: { name: "devsy-linux-arm64" },
  },
}));

vi.mock("../devsy-agent", () => ({
  DEVSY_AGENT_SETUP_COMMAND: "devrouter setup --yes --workspace-runtime devsy",
  inspectDevsyAgent: vi.fn(() => runtimeState.agent),
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("../workspace-runtime", () => {
  class WorkspaceRuntimeOwnershipError extends Error {}
  return {
    WorkspaceRuntimeOwnershipError,
    resolveWorkspaceRuntimeDetailed: (repoPath?: string) => {
      runtimeState.requestedRepoPath = repoPath;
      if (repoPath && runtimeState.ownershipProblem) {
        throw new WorkspaceRuntimeOwnershipError(runtimeState.ownershipProblem);
      }
      return runtimeState.resolution;
    },
    readWorkspaceRuntimeConfig: () => runtimeState.config,
    inspectWorkspaceRuntimeConfig: () => runtimeState.inspection,
  };
});

let tmpDir: string;

function writePackageJson(packageManager = "pnpm@11.6.0"): void {
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({
      packageManager,
      engines: { node: ">=1" },
    }),
    "utf-8",
  );
}

function result(status: number, stdout = "", stderr = ""): unknown {
  return { status, stdout, stderr };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-tool-diagnostics-test-"));
  runtimeState.resolution = { runtime: "devpod", source: "auto-detect" };
  runtimeState.requestedRepoPath = undefined;
  runtimeState.ownershipProblem = undefined;
  runtimeState.config = {};
  runtimeState.inspection = { exists: false, config: {}, problems: [] };
  runtimeState.agent = {
    state: "missing",
    source: "managed",
    reason: "the selected source is missing",
    installedVersion: "1.16.2",
    asset: { name: "devsy-linux-arm64" },
  };
  spawnSyncMock.mockImplementation((command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "docker compose version") {
      return result(0, "Docker Compose version v2.39.0\n");
    }
    if (key === "mkcert -version") {
      return result(0, "v1.4.4\n");
    }
    if (key === "devpod version") {
      return result(0, "0.7.0\n");
    }
    if (key === "pnpm --version") {
      return result(0, "11.6.0\n");
    }
    if (key === "brew --version") {
      return result(0, "Homebrew 4.5.0\n");
    }
    return result(1, "", "missing");
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("buildGlobalToolChecks", () => {
  it("reports required global tools as ok when they are reachable", () => {
    writePackageJson();

    const checks = buildGlobalToolChecks(tmpDir);

    expect(checks.map((check) => [check.id, check.level])).toEqual([
      ["global.docker-compose", "ok"],
      ["global.mkcert", "ok"],
      ["global.devpod", "ok"],
      ["global.workspace-runtime-config", "ok"],
      ["global.node-toolchain", "ok"],
    ]);
  });

  it("reports actionable remediation when external tools are missing", () => {
    writePackageJson();
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "brew --version") {
        return result(0, "Homebrew 4.5.0\n");
      }
      return result(1, "", `${key} missing`);
    });

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("global.docker-compose")?.level).toBe("error");
    expect(byId.get("global.docker-compose")?.suggestion).toContain("Compose v2");
    expect(byId.get("global.mkcert")?.level).toBe("warn");
    expect(byId.get("global.mkcert")?.suggestion).toBe("Install mkcert: brew install mkcert");
    expect(byId.get("global.devpod")?.level).toBe("warn");
    expect(byId.get("global.devpod")?.suggestion).toContain("brew install devpod");
    expect(byId.get("global.node-toolchain")?.level).toBe("warn");
    expect(byId.get("global.node-toolchain")?.suggestion).toContain("pnpm@11.6.0");
  });

  it("probes Devsy with its --version flag when it is the active runtime", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "machine-config" };
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "devsy --version") {
        return result(0, "v1.16.2\n");
      }
      if (key === "pnpm --version") {
        return result(0, "11.6.0\n");
      }
      if (key === "brew --version") {
        return result(0, "Homebrew 4.5.0\n");
      }
      return result(1, "", "missing");
    });

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("global.devpod")?.level).toBe("ok");
    expect(byId.get("global.devpod")?.summary).toBe(
      "Devsy is the active workspace runtime (source: machine-config).",
    );
    expect(byId.get("global.devsy-agent")).toMatchObject({
      level: "error",
      summary: "Managed Devsy agent source is missing.",
      suggestion: "Run: devrouter setup --yes --workspace-runtime devsy",
    });
    expect(byId.get("global.devsy-agent")?.details).not.toContain("/");
  });

  it.each([
    ["ready", "ok", "Devsy agent source is ready."],
    ["missing", "error", "Managed Devsy agent source is missing."],
    ["stale", "error", "Devsy agent source is stale for this Devrouter release."],
    ["invalid", "error", "Devsy agent source is invalid."],
  ] as const)("reports the Devsy agent %s state without paths", (state, level, summary) => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "machine-config" };
    runtimeState.agent.state = state;
    runtimeState.agent.reason = `fixture ${state}`;

    const check = buildGlobalToolChecks(tmpDir).find((entry) => entry.id === "global.devsy-agent");

    expect(check).toMatchObject({ level, summary });
    expect(JSON.stringify(check)).not.toContain(tmpDir);
  });

  it("requires an invalid explicit override to be fixed or unset", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "machine-config" };
    runtimeState.agent = {
      state: "invalid",
      source: "explicit",
      reason: "the selected source has an unexpected digest",
      installedVersion: "1.16.2",
      asset: { name: "devsy-linux-arm64" },
    };

    const check = buildGlobalToolChecks(tmpDir).find((entry) => entry.id === "global.devsy-agent");
    expect(check?.suggestion).toBe(
      "Fix or unset DEVSY_AGENT_BINARY, then run: devrouter setup --yes --workspace-runtime devsy",
    );
  });

  it("warns about a configured Devsy inactivity timeout while DevPod is active", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devpod", source: "auto-detect" };
    runtimeState.config = { devsyInactivityTimeout: "30m" };
    runtimeState.inspection = {
      exists: true,
      config: { devsyInactivityTimeout: "30m" },
      problems: [],
    };

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("global.workspace-runtime-config")?.level).toBe("warn");
    expect(byId.get("global.workspace-runtime-config")?.details).toContain(
      "devsyInactivityTimeout is configured but the active workspace runtime is DevPod",
    );
  });

  it("resolves the workspace runtime for the inspected checkout path", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "path-owner" };
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "devsy --version") {
        return result(0, "v1.16.2\n");
      }
      if (key === "pnpm --version") {
        return result(0, "11.6.0\n");
      }
      if (key === "brew --version") {
        return result(0, "Homebrew 4.5.0\n");
      }
      return result(1, "", "missing");
    });

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(runtimeState.requestedRepoPath).toBe(tmpDir);
    expect(byId.get("global.devpod")?.level).toBe("ok");
    expect(byId.get("global.devpod")?.summary).toBe(
      "Devsy is the active workspace runtime (source: path-owner).",
    );
  });

  it("does not warn about a Devsy timeout for a path-owned DevPod checkout", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devpod", source: "path-owner" };
    runtimeState.config = { devsyInactivityTimeout: "30m" };
    runtimeState.inspection = {
      exists: true,
      config: { devsyInactivityTimeout: "30m" },
      problems: [],
    };

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(runtimeState.requestedRepoPath).toBe(tmpDir);
    expect(byId.get("global.workspace-runtime-config")?.level).toBe("ok");
  });

  it("reports ambiguous checkout ownership without hiding the configured runtime tool", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "machine-config" };
    runtimeState.ownershipProblem = "Both DevPod and Devsy claim this checkout.";
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "devsy --version") return result(0, "v1.16.2\n");
      if (key === "pnpm --version") return result(0, "11.6.0\n");
      return result(1, "", "missing");
    });

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("repo.workspace-runtime-ownership")?.level).toBe("error");
    expect(byId.get("repo.workspace-runtime-ownership")?.details).toContain(
      "Both DevPod and Devsy",
    );
    expect(byId.get("global.devpod")?.summary).toBe(
      "Devsy is configured, but checkout ownership is unresolved.",
    );
  });

  it("warns about invalid persisted preference content", () => {
    writePackageJson();
    runtimeState.inspection = {
      exists: true,
      config: {},
      problems: ["runtime='docker' is not a supported workspace runtime."],
    };

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("global.workspace-runtime-config")?.level).toBe("warn");
    expect(byId.get("global.workspace-runtime-config")?.details).toContain(
      "runtime='docker' is not a supported workspace runtime.",
    );
  });
});

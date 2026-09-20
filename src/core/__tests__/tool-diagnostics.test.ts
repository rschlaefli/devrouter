import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCliPathCheck, buildGlobalToolChecks } from "../tool-diagnostics";

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
    state: "missing",
    source: "managed",
    reason: "the selected source is missing",
    installedVersion: "1.16.2",
    asset: { name: "devsy-linux-arm64" },
  } as {
    state: "ready" | "missing" | "stale" | "invalid";
    source: "managed" | "explicit" | "host";
    reason: string;
    installedVersion?: string;
    asset?: { name: string };
    drift?: { installed: string; supported: string };
  },
}));

vi.mock("../devsy-agent", async (importOriginal) => ({
  ...(await importOriginal()),
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
  vi.unstubAllEnvs();
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
      ["global.cli-path", "ok"],
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
      summary: "No verified Devsy agent is cached for the installed Devsy version.",
      suggestion: "Run: devrouter setup --yes --workspace-runtime devsy",
    });
    expect(byId.get("global.devsy-agent")?.details).not.toContain("/");
  });

  it("disables Devsy telemetry only while running diagnostic probes", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "machine-config" };
    vi.stubEnv("DEVSY_DISABLE_TELEMETRY", "operator-choice");
    const observedTelemetryValues: Array<string | undefined> = [];
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (command === "devsy") {
        observedTelemetryValues.push(process.env.DEVSY_DISABLE_TELEMETRY);
      }
      if (key === "devsy --version") return result(0, "v1.16.2\n");
      if (key === "pnpm --version") return result(0, "11.6.0\n");
      if (key === "brew --version") return result(0, "Homebrew 4.5.0\n");
      return result(1, "", "missing");
    });

    buildGlobalToolChecks(tmpDir);

    expect(observedTelemetryValues).toEqual(["true"]);
    expect(process.env.DEVSY_DISABLE_TELEMETRY).toBe("operator-choice");
  });

  it.each([
    ["ready", "ok", "Devsy agent source is ready."],
    ["missing", "error", "No verified Devsy agent is cached for the installed Devsy version."],
    ["stale", "error", "The installed Devsy version is outside the supported range."],
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

  it("warns, without blocking, when the host CLI is newer than the verified pin", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "machine-config" };
    runtimeState.agent = {
      state: "ready",
      source: "host",
      reason:
        "no verified Devsy 1.19.0 agent manifest is recorded yet; the host CLI governs its own agent",
      installedVersion: "1.19.0",
      drift: { installed: "1.19.0", supported: "1.16.2" },
    };

    const check = buildGlobalToolChecks(tmpDir).find((entry) => entry.id === "global.devsy-agent");

    expect(check).toMatchObject({ level: "warn" });
    expect(check?.summary).toBe(
      "Devsy 1.19.0 governs its own agent; Devrouter injects no agent for it.",
    );
    expect(check?.suggestion).toContain("devrouter setup --yes --workspace-runtime devsy");
    expect(JSON.stringify(check)).not.toContain(tmpDir);
  });

  it("repairs a stale explicit source by replacing the unsupported Devsy CLI", () => {
    writePackageJson();
    runtimeState.resolution = { runtime: "devsy", source: "machine-config" };
    runtimeState.agent = {
      state: "stale",
      source: "explicit",
      reason: "installed Devsy 1.16.2-beta.1 is not supported by this Devrouter release",
      installedVersion: "1.16.2-beta.1",
      asset: { name: "devsy-linux-arm64" },
    };

    const check = buildGlobalToolChecks(tmpDir).find((entry) => entry.id === "global.devsy-agent");
    expect(check?.suggestion).toBe(
      "Install a supported Devsy release (>=1.16.2 <2.0.0) for a supported host, then run: devrouter setup --yes --workspace-runtime devsy",
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

function writeFakeInstall(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(dir, "devrouter");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf-8");
  fs.chmodSync(executable, 0o755);
  return fs.realpathSync(executable);
}

describe("buildCliPathCheck", () => {
  it("skips the comparison for an unstamped build without probing PATH", () => {
    const bin = path.join(tmpDir, "bin");
    writeFakeInstall(bin);
    const probeVersion = vi.fn(() => "9.9.9");

    const check = buildCliPathCheck({
      runningVersion: "0.0.0-dev",
      pathValue: bin,
      probeVersion,
    });

    expect(check).toMatchObject({ id: "global.cli-path", level: "ok" });
    expect(check.details).toContain("comparison=skipped");
    expect(probeVersion).not.toHaveBeenCalled();
  });

  it("warns when another install on PATH is newer than the running CLI", () => {
    const newerBin = path.join(tmpDir, "bin-newer");
    writeFakeInstall(newerBin);
    const runningBin = path.join(tmpDir, "bin-running");
    const running = writeFakeInstall(runningBin);

    const check = buildCliPathCheck({
      pathValue: [newerBin, runningBin].join(path.delimiter),
      runningEntry: running,
      runningVersion: "0.0.79",
      probeVersion: (executable) =>
        executable === path.join(newerBin, "devrouter") ? "0.0.80" : "0.0.79",
    });

    expect(check).toMatchObject({ id: "global.cli-path", level: "warn" });
    expect(check.summary).toContain("0.0.80");
    expect(check.summary).toContain("0.0.79");
    expect(check.suggestion).toContain("npm install -g @devrouter/cli@0.0.80");
    expect(check.details).toContain("(running)");
  });

  it("warns when the shell resolves a different install than the running CLI", () => {
    const shellBin = path.join(tmpDir, "bin-shell");
    writeFakeInstall(shellBin);
    const runningBin = path.join(tmpDir, "bin-running");
    const running = writeFakeInstall(runningBin);

    const check = buildCliPathCheck({
      pathValue: [shellBin, runningBin].join(path.delimiter),
      runningEntry: running,
      runningVersion: "0.0.79",
      probeVersion: () => "0.0.77",
    });

    expect(check).toMatchObject({ id: "global.cli-path", level: "warn" });
    expect(check.summary).toContain("resolves to a different install");
    expect(check.summary).toContain("0.0.77");
    expect(check.suggestion).toContain("npm install -g @devrouter/cli@0.0.79");
  });

  it("warns when the shell-resolved install cannot report its version", () => {
    const shellBin = path.join(tmpDir, "bin-shell");
    writeFakeInstall(shellBin);

    const check = buildCliPathCheck({
      pathValue: shellBin,
      runningEntry: path.join(tmpDir, "missing", "devrouter"),
      runningVersion: "0.0.79",
      probeVersion: () => undefined,
    });

    expect(check).toMatchObject({ id: "global.cli-path", level: "warn" });
    expect(check.details).toContain("unknown");
  });

  it("reads the version line from a probe that exits non-zero outside a repo", () => {
    const shellBin = path.join(tmpDir, "bin-shell");
    writeFakeInstall(shellBin);
    const runningBin = path.join(tmpDir, "bin-running");
    const running = writeFakeInstall(runningBin);
    spawnSyncMock.mockImplementation((command: string) =>
      command === path.join(shellBin, "devrouter")
        ? result(1, "Installed CLI version: 0.0.70\n", "Error: Missing .devrouter.yml")
        : result(0, "Installed CLI version: 0.0.79\n"),
    );

    const check = buildCliPathCheck({
      pathValue: [shellBin, runningBin].join(path.delimiter),
      runningEntry: running,
      runningVersion: "0.0.79",
    });

    expect(check).toMatchObject({ id: "global.cli-path", level: "warn" });
    expect(check.summary).toContain("0.0.70");
  });

  it("stays silent when every install on PATH matches the running CLI", () => {
    const firstBin = path.join(tmpDir, "bin-a");
    writeFakeInstall(firstBin);
    const secondBin = path.join(tmpDir, "bin-b");
    const running = writeFakeInstall(secondBin);

    const check = buildCliPathCheck({
      pathValue: [firstBin, secondBin].join(path.delimiter),
      runningEntry: running,
      runningVersion: "0.0.79",
      probeVersion: () => "0.0.79",
    });

    expect(check).toMatchObject({ id: "global.cli-path", level: "ok" });
    expect(check.summary).toBe("Devrouter installs on PATH match the running CLI.");
  });

  it("counts a symlinked executable once", () => {
    const realBin = path.join(tmpDir, "bin-real");
    const running = writeFakeInstall(realBin);
    const aliasBin = path.join(tmpDir, "bin-alias");
    fs.mkdirSync(aliasBin, { recursive: true });
    fs.symlinkSync(running, path.join(aliasBin, "devrouter"));

    const check = buildCliPathCheck({
      pathValue: [realBin, aliasBin].join(path.delimiter),
      runningEntry: running,
      runningVersion: "0.0.79",
      probeVersion: () => "0.0.79",
    });

    expect(check.level).toBe("ok");
    expect(check.details).toContain(realBin);
    expect(check.details).not.toContain(aliasBin);
  });

  it("reports when no devrouter executable is on PATH", () => {
    const emptyBin = path.join(tmpDir, "bin-empty");
    fs.mkdirSync(emptyBin, { recursive: true });

    const check = buildCliPathCheck({
      pathValue: emptyBin,
      runningVersion: "0.0.79",
      probeVersion: () => undefined,
    });

    expect(check).toMatchObject({ id: "global.cli-path", level: "ok" });
    expect(check.summary).toBe("No devrouter executable is on PATH.");
  });
});

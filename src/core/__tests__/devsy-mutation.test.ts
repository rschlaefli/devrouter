import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DevsyStartPostconditionError,
  deleteOwnedDevsyWorkspace,
  startDevsyWorkspace,
  stopOwnedDevsyWorkspace,
} from "../devsy-mutation";
import { withFileLockSync } from "../file-lock";

const paths = vi.hoisted(() => ({ home: "/tmp/devrouter-devsy-mutation-test" }));

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../router", () => ({ DEVROUTER_HOME: paths.home }));
vi.mock("../file-lock", () => ({
  withFileLock: vi.fn(async (_path: string, _options: unknown, operation: () => Promise<unknown>) =>
    operation(),
  ),
  withFileLockSync: vi.fn((_path: string, _options: unknown, operation: () => unknown) =>
    operation(),
  ),
  createStderrWaitReporter: vi.fn(() => () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockDevsyUp();
});

const owned = { id: "feature", source: { localFolder: "/repo/feature" } };

function listResult(workspaces: unknown[] = [owned]) {
  return { status: 0, stdout: JSON.stringify(workspaces), stderr: "" } as never;
}

function mockDevsyUp(options: { status?: number; stderr?: string | Buffer } = {}): void {
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    const stderr = new PassThrough();
    Object.assign(child, { stderr });
    queueMicrotask(() => {
      if (options.stderr) {
        stderr.write(
          Buffer.isBuffer(options.stderr) ? options.stderr : Buffer.from(options.stderr),
        );
      }
      stderr.end();
      child.emit("close", options.status ?? 0, null);
    });
    return child;
  });
}

describe("Devsy mutation adapter", () => {
  it("uses one bounded lock path and skips the provider when the owner is absent", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "[]", stderr: "" } as never);

    expect(stopOwnedDevsyWorkspace("feature", "/repo/feature")).toEqual({ status: "absent" });
    expect(deleteOwnedDevsyWorkspace("feature", "/repo/feature")).toEqual({ status: "absent" });

    expect(withFileLockSync).toHaveBeenNthCalledWith(
      1,
      `${paths.home}/devsy-mutation.lock`,
      {
        activity: "Devsy stop",
        target: "'/repo/feature'",
        waitMs: 1_800_000,
        fair: true,
        onWait: expect.any(Function),
      },
      expect.any(Function),
    );
    expect(withFileLockSync).toHaveBeenNthCalledWith(
      2,
      `${paths.home}/devsy-mutation.lock`,
      {
        activity: "Devsy delete",
        target: "'/repo/feature'",
        waitMs: 1_800_000,
        fair: true,
        onWait: expect.any(Function),
      },
      expect.any(Function),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "devsy",
      expect.arrayContaining(["stop"]),
      expect.anything(),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "devsy",
      expect.arrayContaining(["delete"]),
      expect.anything(),
    );
  });

  it("stops an owned workspace and revalidates ownership", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      if (command === "devsy" && (args as string[])[0] === "workspace") {
        if ((args as string[])[1] === "list") {
          listCalls += 1;
          return listResult(listCalls === 1 ? [owned] : [owned]);
        }
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(stopOwnedDevsyWorkspace("feature", "/repo/feature")).toEqual({ status: "changed" });
    expect(spawnSync).toHaveBeenCalledWith("devsy", ["workspace", "stop", "feature"], {
      encoding: "utf-8",
    });
  });

  it("delete ignores a not-found stale registration only with exact proof", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls < 4 ? [owned] : []);
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "status") {
        return {
          status: 0,
          stdout: JSON.stringify({ id: "feature", state: "NotFound" }),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(deleteOwnedDevsyWorkspace("feature", "/repo/feature")).toEqual({ status: "changed" });
    expect(vi.mocked(spawnSync).mock.calls.map(([, args]) => args)).toEqual([
      ["workspace", "list", "--result-format", "json", "--skip-pro"],
      ["workspace", "delete", "feature", "--ignore-not-found"],
      ["workspace", "list", "--result-format", "json", "--skip-pro"],
      ["workspace", "status", "feature", "--result-format", "json"],
      ["workspace", "list", "--result-format", "json", "--skip-pro"],
      ["workspace", "delete", "feature", "--force", "--ignore-not-found"],
      ["workspace", "list", "--result-format", "json", "--skip-pro"],
    ]);
  });

  it("fails closed on a still-running workspace after delete", () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult();
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "status") {
        return {
          status: 0,
          stdout: JSON.stringify({ id: "feature", state: "Running" }),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => deleteOwnedDevsyWorkspace("feature", "/repo/feature")).toThrow("runtime=running");
    expect(spawnSync).not.toHaveBeenCalledWith(
      "devsy",
      ["workspace", "delete", "feature", "--force", "--ignore-not-found"],
      expect.anything(),
    );
  });
});

describe("startDevsyWorkspace", () => {
  it("starts with a stable id and workspace env, then revalidates ownership", async () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace") {
        if (argv[1] === "list") return listResult();
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    const id = await startDevsyWorkspace({
      repoPath: "/repo/feature",
      devsyId: "feature",
      devcontainerPath: ".devcontainer/devcontainer.devrouter.json",
      workspace: { token: "feature", gitCommonDir: "/repo/.git" },
    });

    expect(id).toBe("feature");
    const upCall = vi
      .mocked(spawn)
      .mock.calls.find(([command, args]) => command === "devsy" && (args as string[])[1] === "up");
    expect(upCall?.[1]).toEqual([
      "workspace",
      "up",
      "/repo/feature",
      "--id",
      "feature",
      "--devcontainer",
      ".devcontainer/devcontainer.devrouter.json",
      "--ide-launch",
      "skip",
      "--workspace-env",
      "WORKSPACE=feature",
      "--workspace-env",
      "DEVROUTER_WORKSPACE=feature",
    ]);
    const upOptions = upCall?.[2] as { env?: Record<string, string | undefined> } | undefined;
    const upEnv = upOptions?.env ?? {};
    expect(upEnv).toMatchObject({
      WORKSPACE: "feature",
      DEVROUTER_WORKSPACE: "feature",
      DEVROUTER_GIT_COMMON_DIR: "/repo/.git",
      DEVCONTAINER_COMPOSE_OVERLAY: "docker-compose.devrouter.yml",
    });
  });

  it("passes --recreate and cleans workspace env without a workspace", async () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult();
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await startDevsyWorkspace({
      repoPath: "/repo/feature",
      devsyId: "feature",
      recreate: true,
      quiet: true,
    });

    const upCall = vi
      .mocked(spawn)
      .mock.calls.find(([command, args]) => command === "devsy" && (args as string[])[1] === "up");
    expect(upCall?.[1]).toEqual([
      "workspace",
      "up",
      "/repo/feature",
      "--id",
      "feature",
      "--ide-launch",
      "skip",
      "--recreate",
    ]);
    const options = upCall?.[2] as { env?: Record<string, string | undefined> } | undefined;
    const env = options?.env ?? {};
    expect(env).not.toHaveProperty("WORKSPACE");
    expect(env).not.toHaveProperty("DEVROUTER_WORKSPACE");
    expect(env).not.toHaveProperty("DEVROUTER_GIT_COMMON_DIR");
    expect(env).not.toHaveProperty("DEVCONTAINER_COMPOSE_OVERLAY");
    expect((upCall?.[2] as { stdio?: unknown } | undefined)?.stdio).toEqual(["inherit", 2, "pipe"]);
  });

  it("forwards the configured inactivity timeout as a provider option", async () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult();
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await startDevsyWorkspace({
      repoPath: "/repo/feature",
      devsyId: "feature",
      inactivityTimeout: "30m",
    });

    const upCall = vi
      .mocked(spawn)
      .mock.calls.find(([command, args]) => command === "devsy" && (args as string[])[1] === "up");
    expect(upCall?.[1]).toEqual([
      "workspace",
      "up",
      "/repo/feature",
      "--id",
      "feature",
      "--ide-launch",
      "skip",
      "--provider-option",
      "INACTIVITY_TIMEOUT=30m",
    ]);
  });

  it("fails when the provider does not attach the workspace after startup", async () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return { status: 0, stdout: "[]", stderr: "" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" }),
    ).rejects.toThrow(DevsyStartPostconditionError);
  });

  it("reports a failed start as possibly started when exact ownership appears", async () => {
    mockDevsyUp({ status: 1, stderr: "inject agent: agent binary not found" });
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls === 1 ? [] : [owned]);
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" }),
    ).rejects.toThrow(DevsyStartPostconditionError);
  });

  it("keeps an ordinary start error when exact absence is proved", async () => {
    mockDevsyUp({ status: 1, stderr: "provider failed" });
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult([]);
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      await startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DevsyStartPostconditionError);
    expect((failure as Error).message).toContain("devsy workspace up failed");
  });

  it("appends agent-acquisition remediation only for the known failure", async () => {
    mockDevsyUp({ status: 1, stderr: "inject agent: agent binary not found" });
    let listCalls = 0;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let replayed = "";
    stderrWrite.mockImplementation((chunk) => {
      replayed += String(chunk);
      return true;
    });
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls === 1 ? [] : []);
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      await startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).toContain("DEVSY_AGENT_BINARY");
    expect(replayed).toContain("inject agent: agent binary not found");
    stderrWrite.mockRestore();
    const upCall = vi
      .mocked(spawn)
      .mock.calls.find(([command, args]) => command === "devsy" && (args as string[])[1] === "up");
    expect(upCall && (upCall[2] as { stdio?: unknown }).stdio).toEqual([
      "inherit",
      "inherit",
      "pipe",
    ]);
  });

  it("replays Devsy stderr after a successful start", async () => {
    mockDevsyUp({ stderr: "provider ready\n" });
    let replayed = "";
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      replayed += String(chunk);
      return true;
    });
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult();
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    try {
      await startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } finally {
      stderrWrite.mockRestore();
    }

    expect(replayed).toContain("provider ready");
  });

  it("forwards verbose stderr while retaining the trailing remediation signal", async () => {
    const output = Buffer.concat([
      Buffer.alloc(1_100_000, 0x78),
      Buffer.from("\ninject agent: agent binary not found\n"),
    ]);
    mockDevsyUp({ status: 1, stderr: output });
    let forwardedBytes = 0;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      forwardedBytes += Buffer.byteLength(chunk);
      return true;
    });
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult([]);
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    try {
      await expect(
        startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" }),
      ).rejects.toThrow("DEVSY_AGENT_BINARY");
    } finally {
      stderrWrite.mockRestore();
    }

    expect(forwardedBytes).toBe(output.length);
  });

  it("keeps the unknown-failure message free of remediation", async () => {
    mockDevsyUp({ status: 1, stderr: "provider failed" });
    let listCalls = 0;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls === 1 ? [] : []);
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      await startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    } finally {
      stderrWrite.mockRestore();
    }

    expect((failure as Error).message).not.toContain("DEVSY_AGENT_BINARY");
  });

  it("carries the remediation through the possibly-started classification", async () => {
    mockDevsyUp({ status: 1, stderr: "inject agent: agent binary not found" });
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls === 1 ? [] : [owned]);
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      await startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DevsyStartPostconditionError);
    expect((failure as Error).message).toContain("DEVSY_AGENT_BINARY");
  });

  it("fails closed when ownership cannot be read after a failed start", async () => {
    mockDevsyUp({ status: 1, stderr: "provider failed" });
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listCalls === 1
          ? listResult([])
          : ({ status: 1, stdout: "", stderr: "registry unavailable" } as never);
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" }),
    ).rejects.toThrow(DevsyStartPostconditionError);
  });

  it("fails closed when ownership conflicts after a failed start", async () => {
    mockDevsyUp({ status: 1, stderr: "provider failed" });
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(
          listCalls === 1 ? [] : [{ id: "feature", source: { localFolder: "/repo/other" } }],
        );
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" }),
    ).rejects.toThrow(DevsyStartPostconditionError);
  });
});

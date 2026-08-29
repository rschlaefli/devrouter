import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DevsyStartPostconditionError,
  deleteOwnedDevsyWorkspace,
  startDevsyWorkspace,
  stopOwnedDevsyWorkspace,
} from "../devsy-mutation";
import { withFileLockSync } from "../file-lock";

const paths = vi.hoisted(() => ({ home: "/tmp/devrouter-devsy-mutation-test" }));

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../router", () => ({ DEVROUTER_HOME: paths.home }));
vi.mock("../file-lock", () => ({
  withFileLockSync: vi.fn((_path: string, _options: unknown, operation: () => unknown) =>
    operation(),
  ),
  createStderrWaitReporter: vi.fn(() => () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const owned = { id: "feature", source: { localFolder: "/repo/feature" } };

function listResult(workspaces: unknown[] = [owned]) {
  return { status: 0, stdout: JSON.stringify(workspaces), stderr: "" } as never;
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
        waitMs: 600_000,
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
        waitMs: 600_000,
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
  it("starts with a stable id and workspace env, then revalidates ownership", () => {
    let sawUp = false;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace") {
        if (argv[1] === "list") return listResult();
        if (argv[1] === "up") sawUp = true;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    const id = startDevsyWorkspace({
      repoPath: "/repo/feature",
      devsyId: "feature",
      devcontainerPath: ".devcontainer/devcontainer.devrouter.json",
      workspace: { token: "feature", gitCommonDir: "/repo/.git" },
    });

    expect(id).toBe("feature");
    expect(sawUp).toBe(true);
    const upCall = vi
      .mocked(spawnSync)
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

  it("passes --recreate and cleans workspace env without a workspace", () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult();
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    startDevsyWorkspace({
      repoPath: "/repo/feature",
      devsyId: "feature",
      recreate: true,
      quiet: true,
    });

    const upCall = vi
      .mocked(spawnSync)
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
  });

  it("forwards the configured inactivity timeout as a provider option", () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult();
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    startDevsyWorkspace({
      repoPath: "/repo/feature",
      devsyId: "feature",
      inactivityTimeout: "30m",
    });

    const upCall = vi
      .mocked(spawnSync)
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

  it("fails when the provider does not attach the workspace after startup", () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return { status: 0, stdout: "[]", stderr: "" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" })).toThrow(
      DevsyStartPostconditionError,
    );
  });

  it("reports a failed start as possibly started when exact ownership appears", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls === 1 ? [] : [owned]);
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "up") {
        return { status: 1, stdout: "", stderr: "inject agent: agent binary not found" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" })).toThrow(
      DevsyStartPostconditionError,
    );
  });

  it("keeps an ordinary start error when exact absence is proved", () => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return listResult([]);
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "up") {
        return { status: 1, stdout: "", stderr: "provider failed" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DevsyStartPostconditionError);
    expect((failure as Error).message).toContain("devsy workspace up failed");
  });

  it("appends agent-acquisition remediation only for the known failure", () => {
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
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "up") {
        return { status: 1, stdout: "", stderr: "inject agent: agent binary not found" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    }

    expect((failure as Error).message).toContain("DEVSY_AGENT_BINARY");
    expect(replayed).toContain("inject agent: agent binary not found");
    stderrWrite.mockRestore();
    const upCall = vi
      .mocked(spawnSync)
      .mock.calls.find(([command, args]) => command === "devsy" && (args as string[])[1] === "up");
    expect(upCall && (upCall[2] as { stdio?: unknown }).stdio).toEqual([
      "inherit",
      "inherit",
      "pipe",
    ]);
  });

  it("keeps the unknown-failure message free of remediation", () => {
    let listCalls = 0;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls === 1 ? [] : []);
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "up") {
        return { status: 1, stdout: "", stderr: "provider failed" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    } finally {
      stderrWrite.mockRestore();
    }

    expect((failure as Error).message).not.toContain("DEVSY_AGENT_BINARY");
  });

  it("carries the remediation through the possibly-started classification", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(listCalls === 1 ? [] : [owned]);
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "up") {
        return { status: 1, stdout: "", stderr: "inject agent: agent binary not found" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    let failure: unknown;
    try {
      startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DevsyStartPostconditionError);
    expect((failure as Error).message).toContain("DEVSY_AGENT_BINARY");
  });

  it("fails closed when ownership cannot be read after a failed start", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listCalls === 1
          ? listResult([])
          : ({ status: 1, stdout: "", stderr: "registry unavailable" } as never);
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "up") {
        return { status: 1, stdout: "", stderr: "provider failed" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" })).toThrow(
      DevsyStartPostconditionError,
    );
  });

  it("fails closed when ownership conflicts after a failed start", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return listResult(
          listCalls === 1 ? [] : [{ id: "feature", source: { localFolder: "/repo/other" } }],
        );
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "up") {
        return { status: 1, stdout: "", stderr: "provider failed" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => startDevsyWorkspace({ repoPath: "/repo/feature", devsyId: "feature" })).toThrow(
      DevsyStartPostconditionError,
    );
  });
});

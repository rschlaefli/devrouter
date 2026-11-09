import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRunningWorkspaceContainer } from "../devpod-environment";
import { devsyExec, devsyExecOutcome } from "../devsy-exec";
import { revalidateDevsyExecProof } from "../devsy-exec-proof";
import { listDevsyWorkspaces, selectDevsyWorkspace } from "../devsy-workspaces";
import type { ExecutionOutcomeError } from "../execution-outcome";
import { withWorkspaceLifecycleLock } from "../workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../devpod-environment", () => ({ resolveRunningWorkspaceContainer: vi.fn() }));
vi.mock("../devsy-exec-proof", () => ({ revalidateDevsyExecProof: vi.fn() }));
vi.mock("../devsy-mutation", () => ({
  withMutationLock: (_activity: string, _target: string, operation: () => unknown) => operation(),
}));
vi.mock("../devsy-workspaces", () => ({
  listDevsyWorkspaces: vi.fn(),
  selectDevsyWorkspace: vi.fn(),
}));
vi.mock("../workspace", () => ({
  sameWorkspacePath: (left: string, right: string) => left === right,
  withWorkspaceLifecycleLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}));

function mockExecExit(code: number | null, signal: string | null = null): void {
  const child = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(child as never);
  queueMicrotask(() => {
    child.emit("close", code, signal);
  });
}

let devsyHome: string;
const previousDevsyHome = process.env.DEVSY_HOME;

/** Writes the provider result Devsy resolves its container workspace folder from. */
function writeWorkspaceResult(id: string, result: Record<string, unknown>): void {
  const directory = path.join(devsyHome, "contexts", "default", "workspaces", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "workspace_result.json"), JSON.stringify(result));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as never);
  devsyHome = fs.mkdtempSync(path.join(os.tmpdir(), "devsy-exec-"));
  process.env.DEVSY_HOME = devsyHome;
});

afterEach(() => {
  if (previousDevsyHome === undefined) delete process.env.DEVSY_HOME;
  else process.env.DEVSY_HOME = previousDevsyHome;
  fs.rmSync(devsyHome, { recursive: true, force: true });
});

describe("devsyExec", () => {
  it("selects the exact path-owned workspace and forwards the remote exit code", async () => {
    const workspaces = [
      { id: "guessed-name", source: { localFolder: "/other" } },
      { id: "actual-id", source: { localFolder: "/repo" } },
    ];
    vi.mocked(listDevsyWorkspaces).mockReturnValue(workspaces);
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspaces[1]);
    mockExecExit(3);

    await expect(devsyExec("/repo", ["pnpm", "seed"])).resolves.toBe(3);

    expect(selectDevsyWorkspace).toHaveBeenCalledWith(workspaces, "/repo");
    expect(withWorkspaceLifecycleLock).toHaveBeenCalledWith("/repo", expect.any(Function));
    expect(spawn).toHaveBeenCalledWith(
      "devsy",
      ["workspace", "exec", "--result-format", "plain", "actual-id", "--", "pnpm", "seed"],
      { stdio: "inherit" },
    );
  });

  it("fails without execution when the exact workspace is absent", async () => {
    vi.mocked(listDevsyWorkspaces).mockReturnValue([]);
    vi.mocked(selectDevsyWorkspace).mockReturnValue(undefined);

    await expect(devsyExec("/repo", ["pnpm", "seed"])).rejects.toThrow("devrouter ensure /repo");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails without execution for an empty command", async () => {
    await expect(devsyExec("/repo", [])).rejects.toThrow("No command provided");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("maps a missing spawn to a rejection", async () => {
    vi.mocked(listDevsyWorkspaces).mockReturnValue([
      { id: "actual-id", source: { localFolder: "/repo" } },
    ]);
    vi.mocked(selectDevsyWorkspace).mockReturnValue({
      id: "actual-id",
      source: { localFolder: "/repo" },
    });
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as never);
    queueMicrotask(() => child.emit("error", new Error("ENOENT")));

    await expect(devsyExec("/repo", ["pnpm", "seed"])).rejects.toThrow("devsy exec failed");
  });

  it("keeps a numeric provider result when close also reports a signal", async () => {
    const workspace = { id: "actual-id", source: { localFolder: "/repo" } };
    vi.mocked(listDevsyWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    mockExecExit(3, "SIGTERM");

    await expect(devsyExecOutcome("/repo", ["pnpm", "seed"])).resolves.toEqual({
      status: "completed",
      exitCode: 3,
      transport: { exitCode: 3, signal: "SIGTERM" },
    });
  });

  it("reports missing local completion as unknown instead of exit 1", async () => {
    const workspace = { id: "actual-id", source: { localFolder: "/repo" } };
    vi.mocked(listDevsyWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    mockExecExit(null, "SIGTERM");

    await expect(devsyExecOutcome("/repo", ["pnpm", "seed"])).resolves.toEqual({
      status: "completion-unknown",
      exitCode: null,
      transport: { exitCode: null, signal: "SIGTERM" },
    });

    mockExecExit(null);
    await expect(devsyExec("/repo", ["pnpm", "seed"])).rejects.toMatchObject({
      name: "ExecutionOutcomeError",
      outcome: {
        status: "completion-unknown",
        exitCode: null,
        transport: { exitCode: null, signal: null },
      },
    } satisfies Partial<ExecutionOutcomeError>);
  });
});

describe("retained Devsy execution", () => {
  const proof = {
    repoPath: "/repo",
    id: "actual-id",
    uid: "uid",
    context: "default",
    providerName: "docker",
    endpoint: "unix:///fixture.sock",
    daemon: "daemon",
    containerId: "a".repeat(64),
    workspacePath: "/workspace",
  };
  it("does not launch when identity revalidation fails", async () => {
    vi.mocked(selectDevsyWorkspace).mockReturnValue({
      id: proof.id,
      source: { localFolder: "/repo" },
    });
    vi.mocked(revalidateDevsyExecProof).mockImplementationOnce(() => {
      throw new Error("identity changed");
    });
    await expect(devsyExecOutcome("/repo", ["tool"], proof)).rejects.toMatchObject({
      outcome: { status: "not-started", exitCode: null },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("keeps named-workspace semantics, context and literal command arguments", async () => {
    writeWorkspaceResult(proof.id, { MergedConfig: { workspaceFolder: proof.workspacePath } });
    vi.mocked(selectDevsyWorkspace).mockReturnValue({
      id: proof.id,
      source: { localFolder: "/repo" },
    });
    mockExecExit(7);
    await expect(devsyExecOutcome("/repo", ["tool", "a b"], proof)).resolves.toMatchObject({
      exitCode: 7,
    });
    expect(revalidateDevsyExecProof).toHaveBeenCalledWith("/repo", proof);
    expect(spawn).toHaveBeenCalledWith(
      "devsy",
      [
        "workspace",
        "exec",
        "--result-format",
        "plain",
        "--context",
        "default",
        "actual-id",
        "--",
        "tool",
        "a b",
      ],
      { stdio: "inherit" },
    );
  });

  it("runs on the proven primary when Devsy has no merged configuration", async () => {
    writeWorkspaceResult(proof.id, { MergedConfig: null, Error: "postCreate failed" });
    vi.mocked(selectDevsyWorkspace).mockReturnValue({
      id: proof.id,
      context: "default",
      source: { localFolder: "/repo" },
    });
    mockExecExit(5);
    await expect(devsyExecOutcome("/repo", ["tool", "a b"], proof)).resolves.toMatchObject({
      status: "completed",
      exitCode: 5,
    });
    expect(revalidateDevsyExecProof).toHaveBeenCalledWith("/repo", proof);
    const [binary, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(binary).toBe("docker");
    expect(args.slice(0, 2)).toEqual(["--host", proof.endpoint]);
    expect(args.slice(-3)).toEqual([proof.containerId, "tool", "a b"]);
    expect(args[args.indexOf("--workdir") + 1]).toBe(proof.workspacePath);
  });
});

describe("Devsy workspace folder fallback", () => {
  const workspace = { id: "actual-id", context: "default", source: { localFolder: "/repo" } };
  const primary = { id: "b".repeat(64), workspacePath: "/workspaces/real" };

  it("execs in the container mount when Devsy recorded no merged configuration", async () => {
    writeWorkspaceResult(workspace.id, { MergedConfig: null, Error: "postCreate failed" });
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue(primary);
    mockExecExit(4);

    await expect(devsyExec("/repo", ["pnpm", "seed"])).resolves.toBe(4);

    expect(withWorkspaceLifecycleLock).toHaveBeenCalledWith("/repo", expect.any(Function));
    const [binary, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(binary).toBe("docker");
    expect(args[0]).toBe("exec");
    expect(args).toContain("-i");
    expect(args[args.indexOf("--workdir") + 1]).toBe("/workspaces/real");
    expect(args.slice(-3)).toEqual([primary.id, "pnpm", "seed"]);
  });

  it("execs in the container mount when it differs from Devsy's recorded folder", async () => {
    writeWorkspaceResult(workspace.id, { MergedConfig: { workspaceFolder: "/workspaces/stale" } });
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue(primary);
    mockExecExit(0);

    await devsyExec("/repo", ["ls"]);

    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("docker");
  });

  it("keeps the Devsy path when its recorded folder is the mount", async () => {
    writeWorkspaceResult(workspace.id, {
      MergedConfig: { workspaceFolder: primary.workspacePath },
    });
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue(primary);
    mockExecExit(0);

    await devsyExec("/repo", ["ls"]);

    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("devsy");
  });

  it("keeps the Devsy path when no single running primary container is provable", async () => {
    writeWorkspaceResult(workspace.id, { MergedConfig: null });
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockImplementation(() => {
      throw new Error("Expected one running workspace app container");
    });
    mockExecExit(0);

    await devsyExec("/repo", ["ls"]);

    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("devsy");
  });

  function metadataLabel(entries: unknown[]) {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify(JSON.stringify(entries)),
    } as never);
  }
  function directCall() {
    const [binary, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    return { binary, args };
  }

  it("applies the last remoteUser and merged remoteEnv from the container metadata", async () => {
    writeWorkspaceResult(workspace.id, { MergedConfig: null });
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue(primary);
    metadataLabel([
      { remoteUser: "first", remoteEnv: { A: "1" } },
      { remoteUser: "node", remoteEnv: { B: "2", C: "${x}" } },
    ]);
    mockExecExit(0);
    await devsyExec("/repo", ["ls"]);
    const { args } = directCall();
    expect(args[args.indexOf("--user") + 1]).toBe("node");
    expect(args).toEqual(expect.arrayContaining(["--env", "A=1", "B=2"]));
    expect(args.join(" ")).not.toContain("C=");
  });

  it("uses the merged configuration's remoteUser when Devsy recorded one", async () => {
    writeWorkspaceResult(workspace.id, {
      MergedConfig: { workspaceFolder: "/workspaces/stale", remoteUser: "vscode" },
    });
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue(primary);
    mockExecExit(0);
    await devsyExec("/repo", ["ls"]);
    const { args } = directCall();
    expect(args[args.indexOf("--user") + 1]).toBe("vscode");
  });

  it("refuses the fallback when a declared remote user cannot be resolved", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devsy-exec-repo-"));
    fs.mkdirSync(path.join(repo, ".devcontainer"));
    fs.writeFileSync(
      path.join(repo, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ remoteUser: "${localEnv:USER}" }),
    );
    writeWorkspaceResult(workspace.id, { MergedConfig: null });
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue(primary);
    try {
      await expect(devsyExec(repo, ["ls"])).rejects.toThrow("Cannot resolve the remote user");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ["no recorded result", undefined],
    ["unparseable result", "{"],
    ["merged config without a folder", JSON.stringify({ MergedConfig: {} })],
  ])("keeps the Devsy path without positive evidence (%s)", async (_name, content) => {
    if (content !== undefined) {
      const directory = path.join(devsyHome, "contexts", "default", "workspaces", workspace.id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "workspace_result.json"), content);
    }
    vi.mocked(selectDevsyWorkspace).mockReturnValue(workspace);
    vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue(primary);
    mockExecExit(0);
    await devsyExec("/repo", ["ls"]);
    expect(directCall().binary).toBe("devsy");
  });
});

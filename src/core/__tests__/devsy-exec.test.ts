import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { devsyExec, devsyExecOutcome } from "../devsy-exec";
import { revalidateDevsyExecProof } from "../devsy-exec-proof";
import { listDevsyWorkspaces, selectDevsyWorkspace } from "../devsy-workspaces";
import type { ExecutionOutcomeError } from "../execution-outcome";
import { withWorkspaceLifecycleLock } from "../workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
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

beforeEach(() => {
  vi.clearAllMocks();
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
});

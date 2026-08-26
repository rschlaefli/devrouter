import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { devsyExec } from "../devsy-exec";
import { listDevsyWorkspaces, selectDevsyWorkspace } from "../devsy-workspaces";
import { withWorkspaceLifecycleLock } from "../workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
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

function mockExecExit(code: number): void {
  const child = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(child as never);
  queueMicrotask(() => {
    child.emit("close", code, null);
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
});

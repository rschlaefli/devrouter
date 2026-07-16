import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRunningWorkspaceContainer } from "../devpod-environment";
import { devpodExec, quotePosixArg } from "../devpod-exec";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "../devpod-workspaces";
import { withWorkspaceLifecycleLock } from "../workspace";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:crypto", () => ({ randomUUID: vi.fn(() => "fixed-uuid") }));
vi.mock("../devpod-workspaces", () => ({
  listDevpodWorkspaces: vi.fn(),
  selectDevpodWorkspace: vi.fn(),
}));
vi.mock("../workspace", () => ({
  sameWorkspacePath: (left: string, right: string) => left === right,
  withWorkspaceLifecycleLock: vi.fn(async (_path: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}));
vi.mock("../devpod-environment", () => ({ resolveRunningWorkspaceContainer: vi.fn() }));

const STATUS_MARKER = "__DEVROUTER_EXIT_fixed-uuid__:";

function mockExecExit(code: number, stderr: string | Buffer[] = `${STATUS_MARKER}${code}\n`): void {
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
  };
  child.stderr = new PassThrough();
  vi.mocked(spawn).mockReturnValue(child as never);
  queueMicrotask(() => {
    if (Array.isArray(stderr)) {
      for (const chunk of stderr) child.stderr.write(chunk);
    } else if (stderr) {
      child.stderr.write(stderr);
    }
    child.stderr.end();
    child.emit("close", code, null);
  });
}

beforeEach(() => {
  vi.mocked(resolveRunningWorkspaceContainer).mockReturnValue({
    id: "container",
    workspacePath: "/workspaces/custom",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("quotePosixArg", () => {
  it.each([
    ["plain", "'plain'"],
    ["two words", "'two words'"],
    ["it's", `'it'"'"'s'`],
    ["$HOME; rm -rf /", "'$HOME; rm -rf /'"],
    ["line one\nline two", "'line one\nline two'"],
    ["", "''"],
  ])("quotes %j as one literal POSIX argument", (input, expected) => {
    expect(quotePosixArg(input)).toBe(expected);
  });
});

describe("devpodExec", () => {
  it("selects the exact path-owned DevPod and disables forwarding", async () => {
    const workspaces = [
      { id: "guessed-name", source: { localFolder: "/other" } },
      { id: "actual-id", source: { localFolder: "/repo" } },
    ];
    vi.mocked(listDevpodWorkspaces).mockReturnValue(workspaces);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspaces[1]);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"actual-id","state":"Running"}',
      stderr: "",
    } as never);
    mockExecExit(0);

    await expect(devpodExec("/repo", ["node", "script with spaces.js"])).resolves.toBe(0);

    expect(selectDevpodWorkspace).toHaveBeenCalledWith(workspaces, "/repo");
    expect(withWorkspaceLifecycleLock).toHaveBeenCalledWith("/repo", expect.any(Function));
    expect(spawnSync).toHaveBeenCalledWith("devpod", ["status", "actual-id", "--output", "json"], {
      encoding: "utf-8",
    });
    expect(spawn).toHaveBeenCalledWith(
      "devpod",
      [
        "--log-output",
        "raw",
        "ssh",
        "actual-id",
        "--agent-forwarding=false",
        "--gpg-agent-forwarding=false",
        "--start-services=false",
        "--workdir",
        "/workspaces/custom",
        "--command",
        "'node' 'script with spaces.js'; __devrouter_status=$?; printf '__DEVROUTER_EXIT_fixed-uuid__:%s\\n' \"$__devrouter_status\" >&2; exit 0",
      ],
      { stdio: ["inherit", "inherit", "pipe"] },
    );
  });

  it("fails without execution when the exact DevPod is absent", async () => {
    vi.mocked(listDevpodWorkspaces).mockReturnValue([]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(undefined);

    await expect(devpodExec("/repo", ["pnpm", "seed"])).rejects.toThrow("devrouter ensure /repo");

    expect(spawnSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["Stopped", "Busy"])("fails without execution when status is %s", async (state) => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ id: "repo", state }),
      stderr: "",
    } as never);

    await expect(devpodExec("/repo", ["pnpm", "seed"])).rejects.toThrow("devrouter ensure /repo");

    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed on duplicate exact-path DevPods", async () => {
    vi.mocked(listDevpodWorkspaces).mockReturnValue([
      { id: "one", source: { localFolder: "/repo" } },
      { id: "two", source: { localFolder: "/repo" } },
    ]);
    vi.mocked(selectDevpodWorkspace).mockImplementation(() => {
      throw new Error("Multiple DevPod workspaces reference '/repo'");
    });

    await expect(devpodExec("/repo", ["pnpm", "seed"])).rejects.toThrow(
      "Multiple DevPod workspaces",
    );
    expect(spawnSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("recovers the remote exit status while streaming DevPod stderr", async () => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"repo","state":"Running"}',
      stderr: "",
    } as never);
    const writes: Buffer[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    });
    mockExecExit(0, `fatal tunnel: Process exited with status 99\n${STATUS_MARKER}7\n`);

    await expect(devpodExec("/repo", ["sh", "-lc", "exit 7"])).resolves.toBe(7);

    expect(Buffer.concat(writes)).toEqual(
      Buffer.from("fatal tunnel: Process exited with status 99\n"),
    );
  });

  it("ignores exit-like text from a successful command", async () => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"repo","state":"Running"}',
      stderr: "",
    } as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockExecExit(0, `user output: Process exited with status 91\n${STATUS_MARKER}0\n`);

    await expect(devpodExec("/repo", ["echo", "Process exited with status 91"])).resolves.toBe(0);
  });

  it("preserves user stderr that has no newline before the status marker", async () => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"repo","state":"Running"}',
      stderr: "",
    } as never);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockExecExit(0, `partial user stderr${STATUS_MARKER}0\n`);

    await expect(devpodExec("/repo", ["printf", "partial user stderr"])).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(Buffer.from("partial user stderr"));
  });

  it("preserves split UTF-8 and streams all but the marker candidate suffix", async () => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"repo","state":"Running"}',
      stderr: "",
    } as never);
    const writes: Buffer[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    });
    const userOutput = Buffer.from("progress 50% 🚀 no newline", "utf-8");
    const rocketStart = userOutput.indexOf(Buffer.from("🚀"));
    const marker = Buffer.from(`${STATUS_MARKER}0\n`);
    mockExecExit(0, [
      userOutput.subarray(0, rocketStart + 1),
      userOutput.subarray(rocketStart + 1),
      marker.subarray(0, 9),
      marker.subarray(9),
    ]);

    await expect(devpodExec("/repo", ["progress"])).resolves.toBe(0);
    expect(Buffer.concat(writes)).toEqual(userOutput);
  });

  it("filters DevPod's missing-exit-status diagnostic after the recovered status", async () => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"repo","state":"Running"}',
      stderr: "",
    } as never);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockExecExit(0, [
      Buffer.from(`${STATUS_MARKER}7\nError tunneling to container: wait: remote command `),
      Buffer.from("exited without exit status or exit signal\n"),
    ]);

    await expect(devpodExec("/repo", ["sh", "-lc", "exit 7"])).resolves.toBe(7);
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves the same diagnostic when it came from command stderr", async () => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"repo","state":"Running"}',
      stderr: "",
    } as never);
    const writes: Buffer[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    });
    const diagnostic =
      "Error tunneling to container: wait: remote command exited without exit status or exit signal\n";
    mockExecExit(0, `${diagnostic}${STATUS_MARKER}0\n`);

    await expect(devpodExec("/repo", ["printf", diagnostic])).resolves.toBe(0);
    expect(Buffer.concat(writes)).toEqual(Buffer.from(diagnostic));
  });

  it("fails when the invocation-specific status marker is missing", async () => {
    const workspace = { id: "repo", source: { localFolder: "/repo" } };
    vi.mocked(listDevpodWorkspaces).mockReturnValue([workspace]);
    vi.mocked(selectDevpodWorkspace).mockReturnValue(workspace);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '{"id":"repo","state":"Running"}',
      stderr: "",
    } as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockExecExit(1, "transport failed\n");

    await expect(devpodExec("/repo", ["pnpm", "seed"])).rejects.toThrow(
      "did not report its exit status",
    );
  });

  it("rejects an empty command before inspecting provider state", async () => {
    await expect(devpodExec("/repo", [])).rejects.toThrow("No command provided");
    expect(listDevpodWorkspaces).not.toHaveBeenCalled();
  });
});

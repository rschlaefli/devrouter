import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DevpodStartPostconditionError,
  deleteOwnedDevpodWorkspace,
  startDevpodWorkspace,
  stopOwnedDevpodWorkspace,
} from "../devpod-mutation";
import { withFileLockSync } from "../file-lock";
import { resetWorkspaceRuntimeCaches } from "../workspace-runtime";

const paths = vi.hoisted(() => ({ home: "/tmp/devrouter-global-mutation-test" }));
const childProcessMocks = vi.hoisted(() => ({ devsySpawn: vi.fn() }));
const temporaryHomes: string[] = [];
let previousWorkspaceRuntime: string | undefined;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: ((command: string, ...args: unknown[]) =>
      command === "devsy"
        ? childProcessMocks.devsySpawn(command, ...args)
        : Reflect.apply(original.spawn, undefined, [command, ...args])) as typeof original.spawn,
    spawnSync: vi.fn(),
  };
});
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
  previousWorkspaceRuntime = process.env.DEVROUTER_WORKSPACE_RUNTIME;
  process.env.DEVROUTER_WORKSPACE_RUNTIME = "devpod";
  vi.clearAllMocks();
  mockDevsyStart();
  resetWorkspaceRuntimeCaches();
});

afterEach(() => {
  if (previousWorkspaceRuntime === undefined) delete process.env.DEVROUTER_WORKSPACE_RUNTIME;
  else process.env.DEVROUTER_WORKSPACE_RUNTIME = previousWorkspaceRuntime;
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function startMutationProcess(home: string, activity: string, waitForRelease: boolean) {
  const fixture = path.join(__dirname, "fixtures", "hold-devpod-mutation.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixture, activity, waitForRelease ? "wait" : "continue"],
    {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let resolveAttempting!: () => void;
  let resolveEntered!: () => void;
  const attempting = new Promise<void>((resolve) => {
    resolveAttempting = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  child.stdout.on("data", (chunk) => {
    const output = String(chunk);
    if (output.includes("attempting")) resolveAttempting();
    if (output.includes("entered")) resolveEntered();
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mutation fixture exited ${code}: ${stderr}`));
    });
  });
  return { child, attempting, entered, exited };
}

function mockDevsyStart(options: { status?: number; stderr?: string } = {}): void {
  childProcessMocks.devsySpawn.mockImplementation(() => {
    const child = new EventEmitter();
    const stderr = new PassThrough();
    Object.assign(child, { stderr });
    queueMicrotask(() => {
      if (options.stderr) stderr.write(Buffer.from(options.stderr));
      stderr.end();
      child.emit("close", options.status ?? 0, null);
    });
    return child;
  });
}

async function waitForQueueTicket(home: string, pid: number): Promise<void> {
  const directory = path.join(home, ".config", "devrouter");
  const pidField = `.${String(pid).padStart(10, "0")}.`;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    if (
      names.some(
        (name) => name.startsWith("devpod-mutation.lock.queue.") && name.includes(pidField),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`mutation fixture PID ${pid} did not join the provider queue`);
}

describe("machine-global DevPod mutation boundary", () => {
  it("normalizes a possibly-started Devsy failure for workspace rollback", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "devsy";
    resetWorkspaceRuntimeCaches();
    mockDevsyStart({ status: 1, stderr: "agent injection failed" });
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        listCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify(
            listCalls === 1 ? [] : [{ id: "feature", source: { localFolder: "/repo/feature" } }],
          ),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await expect(
      startDevpodWorkspace({ repoPath: "/repo/feature", devpodId: "feature" }),
    ).rejects.toThrow(DevpodStartPostconditionError);
  });

  it("uses one bounded lock path for action-specific APIs", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "[]", stderr: "" } as never);

    expect(stopOwnedDevpodWorkspace("a", "/repo-a")).toEqual({ status: "absent" });
    expect(deleteOwnedDevpodWorkspace("b", "/repo-b")).toEqual({ status: "absent" });

    expect(withFileLockSync).toHaveBeenNthCalledWith(
      1,
      `${paths.home}/devpod-mutation.lock`,
      {
        activity: "DevPod stop",
        target: "'/repo-a'",
        waitMs: 1_800_000,
        fair: true,
        onWait: expect.any(Function),
      },
      expect.any(Function),
    );
    expect(withFileLockSync).toHaveBeenNthCalledWith(
      2,
      `${paths.home}/devpod-mutation.lock`,
      {
        activity: "DevPod delete",
        target: "'/repo-b'",
        waitMs: 1_800_000,
        fair: true,
        onWait: expect.any(Function),
      },
      expect.any(Function),
    );
  });

  it("revalidates exact ownership before and after deletion", () => {
    let deleted = false;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        return {
          status: 0,
          stdout: deleted
            ? "[]"
            : JSON.stringify([{ id: "feature", source: { localFolder: "/repo/feature" } }]),
          stderr: "",
        } as never;
      }
      if (command === "devpod" && argv[0] === "delete") {
        deleted = true;
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(deleteOwnedDevpodWorkspace("feature", "/repo/feature")).toEqual({ status: "changed" });
    expect(spawnSync).toHaveBeenCalledWith("devpod", ["delete", "feature", "--ignore-not-found"], {
      encoding: "utf-8",
    });
  });

  it("fails when an id is reassigned before post-delete proof", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        listCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "feature",
              source: { localFolder: listCalls === 1 ? "/repo/feature" : "/other/feature" },
            },
          ]),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => deleteOwnedDevpodWorkspace("feature", "/repo/feature")).toThrow(
      "do not have one exact owner",
    );
  });

  it("force-deletes stale registration only after exact NotFound proof and revalidation", () => {
    let forceDeleted = false;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy") {
        return { status: 1, stdout: "", stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "list") {
        return {
          status: 0,
          stdout: forceDeleted
            ? "[]"
            : JSON.stringify([{ id: "feature", source: { localFolder: "/repo/feature" } }]),
          stderr: "",
        } as never;
      }
      if (command === "devpod" && argv[0] === "delete") {
        if (argv.includes("--force")) forceDeleted = true;
        return { status: 0, stdout: "", stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "status") {
        return {
          status: 0,
          stdout: JSON.stringify({ id: "feature", provider: "docker", state: "NotFound" }),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(deleteOwnedDevpodWorkspace("feature", "/repo/feature")).toEqual({ status: "changed" });
    expect(vi.mocked(spawnSync).mock.calls.map(([, args]) => args)).toEqual([
      ["list", "--output", "json", "--skip-pro"],
      ["delete", "feature", "--ignore-not-found"],
      ["list", "--output", "json", "--skip-pro"],
      ["status", "feature", "--output", "json", "--timeout", "5s"],
      ["list", "--output", "json", "--skip-pro"],
      ["delete", "feature", "--force", "--ignore-not-found"],
      ["list", "--output", "json", "--skip-pro"],
    ]);
  });

  it.each([
    ["Busy", "busy"],
    ["Running", "running"],
    ["Stopped", "stopped"],
    ["Future", "unknown"],
  ])("fails closed for %s runtime before force deletion", (state, expected) => {
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify([{ id: "feature", source: { localFolder: "/repo/feature" } }]),
          stderr: "",
        } as never;
      }
      if (command === "devpod" && argv[0] === "status") {
        return {
          status: 0,
          stdout: JSON.stringify({ id: "feature", state }),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => deleteOwnedDevpodWorkspace("feature", "/repo/feature")).toThrow(
      `runtime=${expected}`,
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      ["delete", "feature", "--force", "--ignore-not-found"],
      expect.anything(),
    );
  });

  it("fails closed when ownership changes after NotFound proof", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        listCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "feature",
              source: { localFolder: listCalls < 3 ? "/repo/feature" : "/other/feature" },
            },
          ]),
          stderr: "",
        } as never;
      }
      if (command === "devpod" && argv[0] === "status") {
        return {
          status: 0,
          stdout: JSON.stringify({ id: "feature", state: "NotFound" }),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => deleteOwnedDevpodWorkspace("feature", "/repo/feature")).toThrow(
      "do not have one exact owner",
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "devpod",
      ["delete", "feature", "--force", "--ignore-not-found"],
      expect.anything(),
    );
  });

  it("does not call the provider when the exact owner is absent", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "[]", stderr: "" } as never);

    expect(stopOwnedDevpodWorkspace("feature", "/repo/feature")).toEqual({ status: "absent" });
    expect(spawnSync).not.toHaveBeenCalledWith("devpod", ["stop", "feature"], expect.anything());
  });

  it("serializes mutation processes from different repositories in arrival order", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-mutation-home-"));
    temporaryHomes.push(home);
    const first = startMutationProcess(home, "DevPod start", true);
    await first.attempting;
    await first.entered;

    const second = startMutationProcess(home, "DevPod delete", true);
    await second.attempting;
    await waitForQueueTicket(home, second.child.pid as number);
    const third = startMutationProcess(home, "DevPod stop", false);
    await third.attempting;
    await waitForQueueTicket(home, third.child.pid as number);
    const contention = await Promise.race([
      second.entered.then(() => "entered" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(contention).toBe("blocked");

    first.child.stdin.end();
    await Promise.all([first.exited, second.entered]);
    const overtaking = await Promise.race([
      third.entered.then(() => "entered" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(overtaking).toBe("blocked");

    second.child.stdin.end();
    await Promise.all([second.exited, third.entered, third.exited]);
  });
});

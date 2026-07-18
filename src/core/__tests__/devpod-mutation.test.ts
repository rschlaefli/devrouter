import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteOwnedDevpodWorkspace, stopOwnedDevpodWorkspace } from "../devpod-mutation";
import { withFileLockSync } from "../file-lock";

const paths = vi.hoisted(() => ({ home: "/tmp/devrouter-global-mutation-test" }));
const temporaryHomes: string[] = [];

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
vi.mock("../router", () => ({ DEVROUTER_HOME: paths.home }));
vi.mock("../file-lock", () => ({
  withFileLockSync: vi.fn((_path: string, _options: unknown, operation: () => unknown) =>
    operation(),
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
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

describe("machine-global DevPod mutation boundary", () => {
  it("uses one bounded lock path for action-specific APIs", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "[]", stderr: "" } as never);

    expect(stopOwnedDevpodWorkspace("a", "/repo-a")).toEqual({ status: "absent" });
    expect(deleteOwnedDevpodWorkspace("b", "/repo-b")).toEqual({ status: "absent" });

    expect(withFileLockSync).toHaveBeenNthCalledWith(
      1,
      `${paths.home}/devpod-mutation.lock`,
      { activity: "DevPod stop", target: "'/repo-a'", waitMs: 60_000 },
      expect.any(Function),
    );
    expect(withFileLockSync).toHaveBeenNthCalledWith(
      2,
      `${paths.home}/devpod-mutation.lock`,
      { activity: "DevPod delete", target: "'/repo-b'", waitMs: 60_000 },
      expect.any(Function),
    );
  });

  it("revalidates exact ownership before and after deletion", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        listCalls += 1;
        return {
          status: 0,
          stdout:
            listCalls === 1
              ? JSON.stringify([{ id: "feature", source: { localFolder: "/repo/feature" } }])
              : "[]",
          stderr: "",
        } as never;
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

  it("does not call the provider when the exact owner is absent", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "[]", stderr: "" } as never);

    expect(stopOwnedDevpodWorkspace("feature", "/repo/feature")).toEqual({ status: "absent" });
    expect(spawnSync).not.toHaveBeenCalledWith("devpod", ["stop", "feature"], expect.anything());
  });

  it("serializes mutation processes from different repositories machine-wide", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-mutation-home-"));
    temporaryHomes.push(home);
    const first = startMutationProcess(home, "DevPod start", true);
    await first.attempting;
    await first.entered;

    const second = startMutationProcess(home, "DevPod delete", false);
    await second.attempting;
    const contention = await Promise.race([
      second.entered.then(() => "entered" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(contention).toBe("blocked");

    first.child.stdin.end();
    await Promise.all([first.exited, second.entered, second.exited]);
  });
});

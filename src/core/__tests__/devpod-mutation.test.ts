import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDevpodMutationLockSync } from "../devpod-mutation";
import { withFileLockSync } from "../file-lock";

const paths = vi.hoisted(() => ({ home: "/tmp/devrouter-global-mutation-test" }));
const temporaryHomes: string[] = [];

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

describe("machine-global DevPod mutation lock", () => {
  it("uses one bounded lock path for different repositories", () => {
    expect(withDevpodMutationLockSync("DevPod start", "/repo-a", () => "a")).toBe("a");
    expect(withDevpodMutationLockSync("DevPod delete", "/repo-b", () => "b")).toBe("b");

    expect(withFileLockSync).toHaveBeenNthCalledWith(
      1,
      `${paths.home}/devpod-mutation.lock`,
      {
        activity: "DevPod start",
        target: "'/repo-a'",
        waitMs: 60_000,
      },
      expect.any(Function),
    );
    expect(withFileLockSync).toHaveBeenNthCalledWith(
      2,
      `${paths.home}/devpod-mutation.lock`,
      {
        activity: "DevPod delete",
        target: "'/repo-b'",
        waitMs: 60_000,
      },
      expect.any(Function),
    );
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

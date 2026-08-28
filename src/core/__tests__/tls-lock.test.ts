import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function startTLSLockProcess(home: string, waitForRelease: boolean) {
  const fixture = path.join(__dirname, "fixtures", "hold-tls-certificate-lock.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixture, waitForRelease ? "wait" : "continue"],
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
      else reject(new Error(`TLS lock fixture exited ${code}: ${stderr}`));
    });
  });
  return { child, attempting, entered, exited };
}

describe("machine-global TLS certificate boundary", () => {
  it("serializes certificate operations from separate processes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-tls-home-"));
    temporaryHomes.push(home);
    const first = startTLSLockProcess(home, true);
    await first.attempting;
    await first.entered;

    const second = startTLSLockProcess(home, false);
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

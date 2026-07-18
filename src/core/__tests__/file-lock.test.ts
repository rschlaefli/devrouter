import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLockSync } from "../file-lock";

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-file-lock-"));
  lockPath = path.join(tmpDir, "test.lock");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("file lock ownership", () => {
  it("stores only a non-sensitive process-birth verifier", () => {
    withFileLockSync(lockPath, { activity: "inspect" }, () => {
      const [, encodedBirth] = fs.readFileSync(lockPath, "utf-8").trim().split(":");
      const processBirth = Buffer.from(encodedBirth, "base64url").toString("utf-8");

      expect(processBirth).toMatch(/^(proc:[0-9]+|ps:[a-f0-9]{64})$/);
    });
  });

  it("does not displace the same live process instance", () => {
    withFileLockSync(lockPath, { activity: "outer" }, () => {
      expect(() =>
        withFileLockSync(lockPath, { activity: "inner", waitMs: 0 }, () => undefined),
      ).toThrow(`inner is already running (PID ${process.pid})`);
    });
  });

  it("keeps legacy pid:uuid records conservative while the PID is live", () => {
    fs.writeFileSync(lockPath, `${process.pid}:legacy-owner\n`, "utf-8");

    expect(() =>
      withFileLockSync(lockPath, { activity: "legacy", waitMs: 0 }, () => undefined),
    ).toThrow(`legacy is already running (PID ${process.pid})`);
  });

  it("keeps malformed three-field records conservative while the PID is live", () => {
    const malformedBirth = Buffer.from("not-a-process-birth").toString("base64url");
    fs.writeFileSync(lockPath, `${process.pid}:${malformedBirth}:not-a-uuid\n`, "utf-8");

    expect(() =>
      withFileLockSync(lockPath, { activity: "malformed", waitMs: 0 }, () => undefined),
    ).toThrow(`malformed is already running (PID ${process.pid})`);
  });

  it("reclaims a lock when its live PID belongs to a different process birth", () => {
    const differentBirth = Buffer.from("proc:definitely-not-this-process").toString("base64url");
    fs.writeFileSync(
      lockPath,
      `${process.pid}:${differentBirth}:00000000-0000-4000-8000-000000000000\n`,
      "utf-8",
    );

    const result = withFileLockSync(lockPath, { activity: "pid reuse" }, () => "acquired");

    expect(result).toBe("acquired");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

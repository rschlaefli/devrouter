import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LockWaitProgress,
  processBirthIdentity,
  processBirthIdentityWithCause,
  withFileLockSync,
} from "../file-lock";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: "Sat Aug 30 00:00:00 2026 node\n",
    stderr: "",
  } as never);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-file-lock-"));
  lockPath = path.join(tmpDir, "test.lock");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("file lock ownership", () => {
  it("stores only a non-sensitive process-birth verifier", () => {
    withFileLockSync(lockPath, { activity: "inspect" }, () => {
      const [, encodedBirth, , acquiredAtMs] = fs.readFileSync(lockPath, "utf-8").trim().split(":");
      const processBirth = Buffer.from(encodedBirth, "base64url").toString("utf-8");

      expect(processBirth).toMatch(/^(proc:[0-9]+|ps:[a-f0-9]{64})$/);
      expect(Number(acquiredAtMs)).toBeGreaterThan(0);
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([
    ["failed", { status: 1, stdout: "", stderr: "raw ps stderr" }],
    ["empty", { status: 0, stdout: "", stderr: "" }],
  ])("fails closed when procfs is unavailable and ps output is %s", (_case, psResult) => {
    const existingLock = "existing-lock-bytes\n";
    fs.writeFileSync(lockPath, existingLock, "utf-8");
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) => {
      if (String(file).startsWith("/proc/")) {
        throw Object.assign(new Error("procfs unavailable"), { code: "EACCES" });
      }
      return readFileSync(file, ...(args as [never]));
    }) as typeof fs.readFileSync);
    vi.mocked(spawnSync).mockReturnValue(psResult as never);
    const callback = vi.fn();

    let thrown: unknown;
    try {
      withFileLockSync(lockPath, { activity: "permission", fair: true }, callback);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("raw ps stderr");
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(existingLock);
    expect(
      fs
        .readdirSync(tmpDir)
        .filter((name) => name.includes(".candidate") || name.includes(".queue.")),
    ).toEqual([]);
  });

  it("does not displace the same live process instance", () => {
    withFileLockSync(lockPath, { activity: "outer" }, () => {
      expect(() =>
        withFileLockSync(lockPath, { activity: "inner", waitMs: 0 }, () => undefined),
      ).toThrow(
        `inner is already running (PID ${process.pid}, held for 0s); gave up after waiting 0s`,
      );
    });
  });

  it("describes the denied process inspection in the acquisition error", () => {
    const existingLock = "existing-lock-bytes\n";
    fs.writeFileSync(lockPath, existingLock, "utf-8");
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) => {
      if (String(file).startsWith("/proc/")) {
        throw Object.assign(new Error("procfs unavailable"), { code: "EACCES" });
      }
      return readFileSync(file, ...(args as [never]));
    }) as typeof fs.readFileSync);
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "raw ps stderr",
    } as never);

    expect(() => withFileLockSync(lockPath, { activity: "permission" }, () => undefined)).toThrow(
      /could not determine process identity for permission lock at .*: .*ps exited with status 1.*LC_ALL=C ps -o lstart=.*fail-closed/,
    );
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(existingLock);
  });

  it("reports the failing ps stage without echoing raw stderr", () => {
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) => {
      if (String(file).startsWith("/proc/")) {
        throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
      }
      return readFileSync(file, ...(args as [never]));
    }) as typeof fs.readFileSync);
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "raw ps stderr",
    } as never);

    const result = processBirthIdentityWithCause(process.pid);

    expect(result.identity).toBeUndefined();
    expect(result.cause).toContain("ps exited with status 1");
    expect(result.cause).not.toContain("raw ps stderr");
  });

  it("reports the ps spawn error code as the cause", () => {
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) => {
      if (String(file).startsWith("/proc/")) {
        throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
      }
      return readFileSync(file, ...(args as [never]));
    }) as typeof fs.readFileSync);
    vi.mocked(spawnSync).mockReturnValue({
      error: Object.assign(new Error("spawn ps EACCES"), { code: "EACCES" }),
      status: null,
      stdout: "",
      stderr: "",
    } as never);

    const result = processBirthIdentityWithCause(process.pid);

    expect(result.identity).toBeUndefined();
    expect(result.cause).toContain("ps spawn failed (EACCES)");
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

  it("reclaims a stale lock record that carries an acquisition timestamp", () => {
    const differentBirth = Buffer.from("proc:definitely-not-this-process").toString("base64url");
    fs.writeFileSync(
      lockPath,
      `${process.pid}:${differentBirth}:00000000-0000-4000-8000-000000000000:1700000000000\n`,
      "utf-8",
    );

    const result = withFileLockSync(lockPath, { activity: "timestamped reuse" }, () => "acquired");

    expect(result).toBe("acquired");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps a timestamped legacy record conservative while the PID is live", () => {
    fs.writeFileSync(lockPath, `${process.pid}:legacy-owner:1700000000000\n`, "utf-8");

    expect(() =>
      withFileLockSync(lockPath, { activity: "legacy timestamp", waitMs: 0 }, () => undefined),
    ).toThrow(/legacy timestamp is already running \(PID [0-9]+\); gave up after waiting 0s/);
  });

  it("reports throttled wait progress while a live holder blocks acquisition", () => {
    const progress: LockWaitProgress[] = [];
    withFileLockSync(lockPath, { activity: "outer" }, () => {
      expect(() =>
        withFileLockSync(
          lockPath,
          {
            activity: "inner",
            // Each poll verifies the holder birth via a ps subprocess, so
            // iterations can take longer than the poll interval.
            waitMs: 500,
            progressIntervalMs: 20,
            onWait: (item) => progress.push(item),
          },
          () => undefined,
        ),
      ).toThrow();
    });

    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0].holderPid).toBe(process.pid);
    expect(progress[0].holderHeldMs).toBeDefined();
    expect(progress[0].holderHeldMs).toBeLessThan(10_000);
    expect(progress[progress.length - 1].waitingMs).toBeGreaterThan(progress[0].waitingMs);
  });

  it("bounds portable process-birth checks while waiting on one live owner", () => {
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) => {
      if (String(file).startsWith("/proc/")) {
        throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
      }
      return readFileSync(file, ...(args as [never]));
    }) as typeof fs.readFileSync);

    withFileLockSync(lockPath, { activity: "outer" }, () => {
      expect(() =>
        withFileLockSync(lockPath, { activity: "inner", waitMs: 160 }, () => undefined),
      ).toThrow();
    });

    const psCalls = vi.mocked(spawnSync).mock.calls.filter(([command]) => command === "ps");
    expect(psCalls.length).toBeGreaterThan(0);
    expect(psCalls.length).toBeLessThanOrEqual(4);
  });

  it("reports a stable queue position while an earlier fair waiter leads", () => {
    const progress: LockWaitProgress[] = [];
    withFileLockSync(lockPath, { activity: "outer" }, () => {
      expect(() =>
        withFileLockSync(
          lockPath,
          {
            activity: "inner",
            fair: true,
            waitMs: 80,
            progressIntervalMs: 20,
            onWait: (item) => progress.push(item),
          },
          () => undefined,
        ),
      ).toThrow();
    });

    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress.every((item) => item.queuePosition === 1)).toBe(true);
    expect(progress.every((item) => item.waitingOn === "lock")).toBe(true);
  });

  it.each([
    "live",
    "missing",
    "unreadable",
    "malformed",
    "changed",
  ])("distinguishes the first waiter from %s holder evidence without changing the queue", (evidence) => {
    const progress: LockWaitProgress[] = [];
    const callback = vi.fn();
    const leaderPid = process.ppid;
    const birth = processBirthIdentity(leaderPid);
    expect(birth).toBeDefined();
    const ticket = `${lockPath}.queue.0000000000000.${leaderPid}.earlier`;
    const leader = `${leaderPid}:${Buffer.from(birth!).toString("base64url")}:00000000-0000-4000-8000-000000000000\n`;
    withFileLockSync(lockPath, { activity: "outer" }, () => {
      fs.writeFileSync(ticket, leader);
      const holderBytes = fs.readFileSync(lockPath, "utf-8");
      const read = fs.readFileSync.bind(fs);
      let reads = 0;
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file, ...args) => {
        if (file === lockPath) {
          reads += 1;
          if (evidence === "missing" || evidence === "unreadable")
            throw Object.assign(new Error("unavailable"), {
              code: evidence === "missing" ? "ENOENT" : "EACCES",
            });
          if (evidence === "malformed" || (evidence === "changed" && reads % 2 === 0))
            return "invalid owner";
        }
        return read(file, ...(args as [never]));
      }) as typeof fs.readFileSync);
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 10));
      try {
        expect(() =>
          withFileLockSync(
            lockPath,
            {
              activity: "inner",
              fair: true,
              waitMs: 100,
              progressIntervalMs: 1,
              onWait: (item) => progress.push(item),
            },
            callback,
          ),
        ).toThrow();
      } finally {
        clock.mockRestore();
        spy.mockRestore();
      }
      expect(callback).not.toHaveBeenCalled();
      expect(progress.length).toBeGreaterThan(0);
      for (const item of progress) {
        expect(item.queuePosition).toBe(2);
        expect(item.queueLeaderPid).toBe(leaderPid);
        expect(item.holderPid).toBe(evidence === "live" ? process.pid : undefined);
        expect(item.holderHeldMs !== undefined).toBe(evidence === "live");
        expect(item.remainingWaitMs).toBeGreaterThan(0);
        expect(item.remainingWaitMs).toBeLessThan(100);
      }
      expect(fs.readFileSync(lockPath, "utf-8")).toBe(holderBytes);
      expect(fs.readFileSync(ticket, "utf-8")).toBe(leader);
      expect(fs.readdirSync(tmpDir).filter((name) => name.includes(".queue."))).toEqual([
        path.basename(ticket),
      ]);
    });
  });

  it("reclaims dead and malformed fair-queue leaders before acquisition", () => {
    const deadTicket = `${lockPath}.queue.0000000000000.0999999999.dead`;
    const malformedTicket = `${lockPath}.queue.0000000000001.${String(process.pid).padStart(10, "0")}.malformed`;
    const deadBirth = Buffer.from("proc:1").toString("base64url");
    fs.writeFileSync(
      deadTicket,
      `999999999:${deadBirth}:00000000-0000-4000-8000-000000000000\n`,
      "utf-8",
    );
    fs.writeFileSync(malformedTicket, `${process.pid}:legacy-owner\n`, "utf-8");

    const result = withFileLockSync(lockPath, { activity: "fair", fair: true }, () => "acquired");

    expect(result).toBe("acquired");
    expect(fs.existsSync(deadTicket)).toBe(false);
    expect(fs.existsSync(malformedTicket)).toBe(false);
  });

  it("does not report progress before the progress interval elapses", () => {
    const progress: LockWaitProgress[] = [];
    withFileLockSync(lockPath, { activity: "outer" }, () => {
      expect(() =>
        withFileLockSync(
          lockPath,
          { activity: "inner", waitMs: 40, onWait: (item) => progress.push(item) },
          () => undefined,
        ),
      ).toThrow();
    });

    expect(progress).toHaveLength(0);
  });

  it("includes held and waited durations in the contention error", () => {
    withFileLockSync(lockPath, { activity: "outer" }, () => {
      expect(() =>
        withFileLockSync(lockPath, { activity: "inner", waitMs: 30 }, () => undefined),
      ).toThrow(/held for [0-9]+s.*gave up after waiting [0-9]+s/);
    });
  });
});

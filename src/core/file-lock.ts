import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

type FileLockOptions = {
  activity: string;
  target?: string;
  waitMs?: number;
};

type LockState = { kind: "live"; pid: number } | { kind: "reclaimed" } | { kind: "retry" };

type LockOwner = {
  pid: number;
  processBirth?: string;
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processBirthIdentity(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd >= 0) {
      const fields = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      if (startTime) return `proc:${startTime}`;
    }
  } catch {
    // macOS and other non-procfs hosts use the portable ps fallback below.
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], {
    encoding: "utf-8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
  return startedAt ? `ps:${startedAt}` : undefined;
}

function parseLockOwner(value: string): LockOwner | undefined {
  const fields = value.split(":");
  const pid = Number(fields[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  // 0.0.34 and earlier wrote pid:uuid. Keep those records conservative: a live
  // PID remains live because the old record has no process-birth proof.
  if (
    fields.length !== 3 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fields[2])
  ) {
    return { pid };
  }
  try {
    const processBirth = Buffer.from(fields[1], "base64url").toString("utf-8");
    const canonical = Buffer.from(processBirth).toString("base64url");
    return canonical === fields[1] && /^(proc|ps):/.test(processBirth)
      ? { pid, processBirth }
      : { pid };
  } catch {
    return { pid };
  }
}

function isLockOwnerLive(owner: LockOwner): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (!owner.processBirth) return true;
  const currentBirth = processBirthIdentity(owner.pid);
  return currentBirth === undefined || currentBirth === owner.processBirth;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function tryReclaimStaleLock(lockPath: string, staleLinkPath: string): LockState {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "retry" };
    }
    throw error;
  }

  try {
    const owner = parseLockOwner(fs.readFileSync(fd, "utf-8").trim());
    if (owner && isLockOwnerLive(owner)) {
      return { kind: "live", pid: owner.pid };
    }

    const staleStat = fs.fstatSync(fd);
    if (staleStat.nlink !== 1) {
      return { kind: "retry" };
    }

    try {
      fs.linkSync(lockPath, staleLinkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "retry" };
      }
      throw error;
    }

    try {
      let currentStat: fs.Stats;
      try {
        currentStat = fs.statSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "retry" };
        }
        throw error;
      }
      if (!sameFile(staleStat, currentStat) || currentStat.nlink !== 2) {
        return { kind: "retry" };
      }
      fs.rmSync(lockPath);
      return { kind: "reclaimed" };
    } finally {
      fs.rmSync(staleLinkPath, { force: true });
    }
  } finally {
    fs.closeSync(fd);
  }
}

function acquireFileLock(lockPath: string, options: FileLockOptions): string {
  const processBirth = processBirthIdentity(process.pid);
  if (!processBirth) {
    throw new Error(`could not determine process identity for ${options.activity} lock`);
  }
  const ownerId = randomUUID();
  const owner = `${process.pid}:${Buffer.from(processBirth).toString("base64url")}:${ownerId}`;
  const candidatePath = `${lockPath}.${process.pid}.${ownerId}.candidate`;
  const staleLinkPath = `${candidatePath}.stale`;
  const deadline = Date.now() + (options.waitMs ?? 0);
  let reclaimAttempts = 0;
  fs.writeFileSync(candidatePath, `${owner}\n`, { encoding: "utf-8", flag: "wx" });

  try {
    for (;;) {
      try {
        fs.linkSync(candidatePath, lockPath);
        return owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const state = tryReclaimStaleLock(lockPath, staleLinkPath);
      if (state.kind === "reclaimed") {
        continue;
      }
      if (state.kind === "live") {
        if (Date.now() >= deadline) {
          const target = options.target ? ` for ${options.target}` : "";
          throw new Error(`${options.activity} is already running${target} (PID ${state.pid})`);
        }
        sleepSync(20);
        continue;
      }

      reclaimAttempts += 1;
      if (reclaimAttempts >= 3 && Date.now() >= deadline) {
        throw new Error(`could not acquire ${options.activity} lock`);
      }
      if (options.waitMs) {
        sleepSync(20);
      }
    }
  } finally {
    fs.rmSync(candidatePath, { force: true });
    fs.rmSync(staleLinkPath, { force: true });
  }
}

function releaseFileLock(lockPath: string, owner: string): void {
  try {
    if (fs.readFileSync(lockPath, "utf-8").trim() === owner) {
      fs.rmSync(lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function withFileLockSync<T>(
  lockPath: string,
  options: FileLockOptions,
  operation: () => T,
): T {
  const owner = acquireFileLock(lockPath, options);
  try {
    return operation();
  } finally {
    releaseFileLock(lockPath, owner);
  }
}

export async function withFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = acquireFileLock(lockPath, options);
  try {
    return await operation();
  } finally {
    releaseFileLock(lockPath, owner);
  }
}

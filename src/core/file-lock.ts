import { randomUUID } from "node:crypto";
import fs from "node:fs";

type FileLockOptions = {
  activity: string;
  target?: string;
  waitMs?: number;
};

type LockState = { kind: "live"; pid: number } | { kind: "reclaimed" } | { kind: "retry" };

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
  } catch {
    return false;
  }
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
    const owner = fs.readFileSync(fd, "utf-8").trim();
    const ownerPid = Number(owner.split(":", 1)[0]);
    if (isProcessAlive(ownerPid)) {
      return { kind: "live", pid: ownerPid };
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
  const owner = `${process.pid}:${randomUUID()}`;
  const candidatePath = `${lockPath}.${owner}.candidate`;
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

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type FileLockOptions = {
  activity: string;
  target?: string;
  waitMs?: number;
  /** Called at most once per progress interval while blocked on a live holder. */
  onWait?: (progress: LockWaitProgress) => void;
  /** Progress interval for onWait. Defaults to 10 seconds. */
  progressIntervalMs?: number;
  /** Preserve arrival order for long-running machine-global provider mutations. */
  fair?: boolean;
};

export type LockWaitProgress = {
  waitingMs: number;
  holderPid: number;
  holderHeldMs?: number;
  queuePosition?: number;
  waitingOn?: "lock" | "queue";
};

type LockState =
  | { kind: "live"; pid: number; acquiredAtMs?: number }
  | { kind: "reclaimed" }
  | { kind: "retry" };

const DEFAULT_WAIT_PROGRESS_INTERVAL_MS = 10_000;

const CANONICAL_OWNER_RE =
  /^[0-9]+:[A-Za-z0-9_-]+:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LockOwner = {
  pid: number;
  processBirth?: string;
};

type FairQueueState = {
  leaderPid: number;
  position: number;
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
  return startedAt ? `ps:${createHash("sha256").update(startedAt).digest("hex")}` : undefined;
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

/**
 * Parse a lock record into its owner plus optional acquisition timestamp.
 * Records written by this version append an epoch-milliseconds field to a
 * canonical pid:birth:uuid owner. Anything else keeps the pre-timestamp
 * parsing, which stays live-conservative for legacy and malformed content.
 */
function parseLockRecord(value: string): {
  owner: LockOwner | undefined;
  acquiredAtMs?: number;
} {
  const trimmed = value.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon >= 0 && CANONICAL_OWNER_RE.test(trimmed.slice(0, lastColon))) {
    const tail = Number(trimmed.slice(lastColon + 1));
    if (Number.isInteger(tail) && tail > 0) {
      return { owner: parseLockOwner(trimmed.slice(0, lastColon)), acquiredAtMs: tail };
    }
  }
  return { owner: parseLockOwner(trimmed) };
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

function inspectFairQueue(lockPath: string, ownTicketPath: string): FairQueueState {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.queue.`;

  for (;;) {
    const names = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .sort();
    const ownName = path.basename(ownTicketPath);
    const position = names.indexOf(ownName);
    if (position < 0) {
      throw new Error("provider mutation queue ticket disappeared before acquisition");
    }

    const leaderPath = path.join(directory, names[0]);
    let leader: LockOwner | undefined;
    try {
      leader = parseLockOwner(fs.readFileSync(leaderPath, "utf-8").trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (leader && isLockOwnerLive(leader)) {
      return { leaderPid: leader.pid, position: position + 1 };
    }

    // Queue records are written through an atomic rename. A malformed or dead
    // leader therefore cannot belong to an in-flight writer and is safe to
    // remove so the next live waiter can advance.
    fs.rmSync(leaderPath, { force: true });
  }
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
    const record = parseLockRecord(fs.readFileSync(fd, "utf-8"));
    if (record.owner && isLockOwnerLive(record.owner)) {
      return { kind: "live", pid: record.owner.pid, acquiredAtMs: record.acquiredAtMs };
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
  const enqueuedAtMs = Date.now();
  const queueTicketPath = `${lockPath}.queue.${String(enqueuedAtMs).padStart(13, "0")}.${String(process.pid).padStart(10, "0")}.${ownerId}`;
  const queueCandidatePath = `${queueTicketPath}.candidate`;
  const deadline = Date.now() + (options.waitMs ?? 0);
  const waitStartedAt = Date.now();
  const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_WAIT_PROGRESS_INTERVAL_MS;
  let lastProgressAt = waitStartedAt;
  let reclaimAttempts = 0;
  fs.writeFileSync(candidatePath, `${owner}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
  if (options.fair) {
    fs.writeFileSync(queueCandidatePath, `${owner}\n`, { encoding: "utf-8", flag: "wx" });
    fs.renameSync(queueCandidatePath, queueTicketPath);
  }

  try {
    for (;;) {
      let queueState: FairQueueState | undefined;
      if (options.fair) {
        queueState = inspectFairQueue(lockPath, queueTicketPath);
      }

      if (queueState && queueState.position > 1) {
        const now = Date.now();
        if (now >= deadline) {
          const target = options.target ? ` for ${options.target}` : "";
          const waitedSeconds = Math.round((now - waitStartedAt) / 1000);
          throw new Error(
            `${options.activity} is still queued${target} (position ${queueState.position}, ahead PID ${queueState.leaderPid}); gave up after waiting ${waitedSeconds}s`,
          );
        }
        if (options.onWait && now - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = now;
          options.onWait({
            waitingMs: now - waitStartedAt,
            holderPid: queueState.leaderPid,
            queuePosition: queueState.position,
            waitingOn: "queue",
          });
        }
        sleepSync(20);
        continue;
      }

      const acquiredAtMs = Date.now();
      const record = `${owner}:${acquiredAtMs}`;
      fs.writeFileSync(candidatePath, `${record}\n`, "utf-8");
      try {
        fs.linkSync(candidatePath, lockPath);
        if (options.fair) fs.rmSync(queueTicketPath, { force: true });
        return record;
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
        const now = Date.now();
        if (now >= deadline) {
          const target = options.target ? ` for ${options.target}` : "";
          const waitedSeconds = Math.round((now - waitStartedAt) / 1000);
          const heldSeconds =
            state.acquiredAtMs !== undefined
              ? `, held for ${Math.round((now - state.acquiredAtMs) / 1000)}s`
              : "";
          throw new Error(
            `${options.activity} is already running${target} (PID ${state.pid}${heldSeconds}); gave up after waiting ${waitedSeconds}s`,
          );
        }
        if (options.onWait && now - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = now;
          options.onWait({
            waitingMs: now - waitStartedAt,
            holderPid: state.pid,
            holderHeldMs:
              state.acquiredAtMs !== undefined ? Math.max(0, now - state.acquiredAtMs) : undefined,
            queuePosition: queueState?.position,
            waitingOn: "lock",
          });
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
    fs.rmSync(queueCandidatePath, { force: true });
    fs.rmSync(queueTicketPath, { force: true });
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

/** Build an onWait reporter that prints one throttled stderr line per wait. */
export function createStderrWaitReporter(
  activity: string,
  target: string,
): (progress: LockWaitProgress) => void {
  return (progress) => {
    const heldSeconds =
      progress.holderHeldMs !== undefined
        ? `, held for ${Math.round(progress.holderHeldMs / 1000)}s`
        : "";
    const status =
      progress.waitingOn === "queue"
        ? `waiting in provider queue position ${progress.queuePosition} led by PID ${progress.holderPid}`
        : progress.queuePosition !== undefined && progress.queuePosition > 1
          ? `waiting in provider queue position ${progress.queuePosition}; provider lock held by PID ${progress.holderPid}${heldSeconds}`
          : `waiting for the provider lock held by PID ${progress.holderPid}${heldSeconds}`;
    process.stderr.write(
      `${activity} for ${target}: ${status}; waited ${Math.round(progress.waitingMs / 1000)}s so far\n`,
    );
  };
}

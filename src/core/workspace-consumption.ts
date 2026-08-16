import fs from "node:fs";
import path from "node:path";
import {
  inspectWorkspaceContainers,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import type { WorkspaceCleanupSize } from "./workspace-cleanup";

const DEFAULT_DEADLINE_MS = 10000;

// 512 is the traditional block size `st_blocks` is expressed in on every
// platform Node runs on (POSIX historically defines it this way regardless
// of the filesystem's actual allocation unit), matching what `du` reports.
const BLOCK_SIZE_BYTES = 512;

type QueuedDirectory = { dirPath: string; entries: fs.Dirent[] };

/**
 * Measures the on-disk footprint of a worktree the way `du -sk` would:
 * allocated blocks rather than apparent byte length, directory inodes
 * included, hardlinks counted once, symlink targets not followed. A single
 * `stat.size` figure understates real usage because filesystems allocate
 * whole blocks per file (small files, and there are thousands of them in a
 * typical `node_modules` tree, round up); `stat.blocks * 512` was verified
 * against `du -sk` on a real 6519-file worktree and matched exactly, while
 * summing `stat.size` came out 10% low.
 *
 * Any failure that prevents a trustworthy total — a missing root, a
 * permission error at any depth, or exceeding `deadlineMs` — returns
 * `unknown` rather than a partial sum. A partial total reads as "less to
 * reclaim than there really is", which is the same misleading signal as
 * reporting zero, so it is discarded rather than surfaced. `du` prints what
 * it managed to read and warns on stderr; this report has no second channel
 * for that warning, only `status`, so a walk that could not see the whole
 * tree says so there.
 *
 * The one skipped case is a path that vanished between reading a directory
 * and stating its entry. That is an ordinary race on a worktree with a dev
 * server or build running, and those blocks really are gone.
 */
export function measureWorktreeConsumption(
  worktreePath: string,
  options?: { deadlineMs?: number },
): WorkspaceCleanupSize {
  const deadlineMs = options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const startedAt = Date.now();

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(worktreePath);
  } catch (error) {
    return { status: "unknown", reason: describeError(error, worktreePath) };
  }

  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(worktreePath, { withFileTypes: true });
  } catch (error) {
    return { status: "unknown", reason: describeError(error, worktreePath) };
  }

  // Hardlinked files (nlink > 1) must be counted once, matching `du`; track
  // seen inodes on the (device, inode) pair since inode numbers are only
  // unique within a single device.
  const seenInodes = new Set<string>();
  let bytes = 0;
  let timedOut = false;
  let unreadableReason: string | null = null;

  const accumulate = (stat: fs.Stats): void => {
    if (stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      if (seenInodes.has(key)) return;
      seenInodes.add(key);
    }
    bytes += stat.blocks * BLOCK_SIZE_BYTES;
  };

  // Checked once per entry: measured at 5.1 vs 5.2 microseconds per entry on a
  // 7869-entry worktree, so the clock read disappears next to the lstat every
  // entry already pays.
  const deadlineExceeded = (): boolean => Date.now() - startedAt >= deadlineMs;

  accumulate(rootStat);

  // Explicit stack rather than recursion: worktrees contain deep
  // `node_modules` trees and recursion risks a stack overflow.
  const stack: QueuedDirectory[] = [{ dirPath: worktreePath, entries: rootEntries }];

  while (stack.length > 0 && !timedOut && !unreadableReason) {
    const { dirPath, entries } = stack.pop() as QueuedDirectory;

    for (const entry of entries) {
      if (deadlineExceeded()) {
        timedOut = true;
        break;
      }

      const entryPath = path.join(dirPath, entry.name);
      let entryStat: fs.Stats;
      try {
        entryStat = fs.lstatSync(entryPath);
      } catch (error) {
        if (vanishedMidWalk(error)) continue;
        unreadableReason = describeIncompleteWalk(error);
        break;
      }
      accumulate(entryStat);

      // Symlinked directories are not descended into: `du` without `-L`
      // counts only the symlink's own blocks, never the target's.
      if (!entryStat.isDirectory()) continue;

      let childEntries: fs.Dirent[];
      try {
        childEntries = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch (error) {
        if (vanishedMidWalk(error)) continue;
        unreadableReason = describeIncompleteWalk(error);
        break;
      }
      stack.push({ dirPath: entryPath, entries: childEntries });
    }
  }

  if (timedOut) {
    return { status: "unknown", reason: `exceeded deadline of ${deadlineMs}ms` };
  }
  if (unreadableReason) {
    return { status: "unknown", reason: unreadableReason };
  }
  return { status: "measured", bytes };
}

/**
 * A path present in a directory listing but gone by the time it is stated.
 * Its blocks are genuinely freed, so skipping it keeps the total honest;
 * treating the race as a failure would turn any worktree with a running
 * build into a permanent `unknown`.
 */
function vanishedMidWalk(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** The message already names the offending path, so it is not repeated. */
function describeIncompleteWalk(error: unknown): string {
  return `could not read every path inside the worktree: ${(error as Error)?.message ?? String(error)}`;
}

export type WorkspaceContainerConsumption = {
  containerWritable: WorkspaceCleanupSize;
  imageShared: WorkspaceCleanupSize;
};

/**
 * Measures the Docker footprint attributable to each of `worktreePaths` in two
 * passes: one plain inspect of every container to decide attribution, then a
 * second inspect of only the attributed IDs with `--size`. Sizing costs the
 * daemon a filesystem walk per container, so asking for it up front would
 * charge the report for every unrelated container on the machine.
 *
 * Attribution is `workspaceAppContainers()`, the same exact-identity predicate
 * `ensure` and `exec` use: the one container whose compose project working
 * directory is the worktree's `.devcontainer` and that bind-mounts the worktree
 * itself. Sibling services of that compose project — a database, a cache — do
 * not bind-mount the worktree and are therefore excluded, so both figures
 * describe the app container alone rather than the whole compose project.
 *
 * A worktree with no attributed container is a measured zero, not an unknown —
 * "this workspace has no container" is a real answer, and reporting it as
 * unknown would hide the most reclaimable-looking rows behind a caveat.
 *
 * Throws when Docker itself cannot be reached; the caller decides how that
 * degrades, since it is a report-wide condition rather than a per-row one.
 */
export function measureContainerConsumption(
  worktreePaths: string[],
  dependencies?: { inspect?: typeof inspectWorkspaceContainers },
): Map<string, WorkspaceContainerConsumption> {
  const byWorktree = new Map<string, WorkspaceContainerConsumption>();
  // A report with no managed workspaces has nothing to attribute, and listing
  // every container on the machine to discover that costs a real inspect pass.
  if (worktreePaths.length === 0) return byWorktree;

  const inspect = dependencies?.inspect ?? inspectWorkspaceContainers;
  const containers = inspect();
  const attributedIds = new Set<string>();
  for (const worktreePath of worktreePaths) {
    for (const container of workspaceAppContainers(containers, worktreePath)) {
      attributedIds.add(container.id);
    }
  }
  const sized =
    attributedIds.size === 0 ? [] : inspect({ withSize: true, ids: Array.from(attributedIds) });

  for (const worktreePath of worktreePaths) {
    byWorktree.set(worktreePath, summarizeContainers(workspaceAppContainers(sized, worktreePath)));
  }
  return byWorktree;
}

function summarizeContainers(
  containers: WorkspaceContainerSnapshot[],
): WorkspaceContainerConsumption {
  let writable = 0;
  let shared = 0;
  for (const container of containers) {
    const { sizeRw, sizeRootFs } = container;
    // A daemon that declines to report sizes yields null through the template's
    // `index` accessor. `SizeRootFs` is the writable layer plus the image
    // layers beneath it, so a root smaller than the writable layer means the
    // pair cannot be trusted to split into reclaimable and shared halves.
    if (
      typeof sizeRw !== "number" ||
      typeof sizeRootFs !== "number" ||
      !Number.isFinite(sizeRw) ||
      !Number.isFinite(sizeRootFs) ||
      sizeRootFs < sizeRw
    ) {
      const unknown: WorkspaceCleanupSize = {
        status: "unknown",
        reason: `container ${container.id.slice(0, 12)} reported no usable size`,
      };
      return { containerWritable: unknown, imageShared: unknown };
    }
    writable += sizeRw;
    shared += sizeRootFs - sizeRw;
  }
  return {
    containerWritable: { status: "measured", bytes: writable },
    imageShared: { status: "measured", bytes: shared },
  };
}

function describeError(error: unknown, worktreePath: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `worktree path '${worktreePath}' does not exist`;
  if (code === "EACCES" || code === "EPERM") {
    return `permission denied reading worktree path '${worktreePath}'`;
  }
  return `could not stat worktree path '${worktreePath}': ${(error as Error)?.message ?? String(error)}`;
}

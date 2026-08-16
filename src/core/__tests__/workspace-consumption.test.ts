import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { inspectWorkspaceContainers, WorkspaceContainerSnapshot } from "../devpod-environment";
import { measureContainerConsumption, measureWorktreeConsumption } from "../workspace-consumption";

const ALPHA = "/checkouts/trees/alpha";
const BETA = "/checkouts/trees/beta";

let dirPath: string;

beforeEach(() => {
  dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-consumption-"));
  dirPath = fs.realpathSync.native(dirPath);
});

afterEach(() => {
  fs.rmSync(dirPath, { recursive: true, force: true });
});

describe("measureWorktreeConsumption", () => {
  it("measures a known directory tree in allocated blocks, not apparent size", () => {
    fs.mkdirSync(path.join(dirPath, "nested"));
    fs.writeFileSync(path.join(dirPath, "a.txt"), "a".repeat(1000));
    fs.writeFileSync(path.join(dirPath, "nested", "b.txt"), "b".repeat(2000));

    // Independently compute the expected total straight from lstat blocks
    // (the same domain fact the implementation relies on) so this test does
    // not just re-assert the implementation's own logic back at itself.
    const expected =
      blocksFor(dirPath) +
      blocksFor(path.join(dirPath, "nested")) +
      blocksFor(path.join(dirPath, "a.txt")) +
      blocksFor(path.join(dirPath, "nested", "b.txt"));

    const result = measureWorktreeConsumption(dirPath);
    expect(result.status).toBe("measured");
    expect((result as { status: "measured"; bytes: number }).bytes).toBe(expected);
    expect((result as { status: "measured"; bytes: number }).bytes).toBeGreaterThan(0);
  });

  it("returns unknown, not zero bytes, for a nonexistent path", () => {
    const missingPath = path.join(dirPath, "does-not-exist");
    const result = measureWorktreeConsumption(missingPath);
    expect(result.status).toBe("unknown");
  });

  it("discards a partial sum and returns unknown when the deadline is exceeded", () => {
    fs.writeFileSync(path.join(dirPath, "a.txt"), "a".repeat(1000));
    fs.writeFileSync(path.join(dirPath, "b.txt"), "b".repeat(1000));

    const result = measureWorktreeConsumption(dirPath, { deadlineMs: 0 });
    expect(result.status).toBe("unknown");
  });

  it("counts a hardlinked file once, not twice", () => {
    const originalPath = path.join(dirPath, "original.txt");
    const linkedPath = path.join(dirPath, "linked.txt");
    fs.writeFileSync(originalPath, "x".repeat(4096));
    fs.linkSync(originalPath, linkedPath);

    const expected = blocksFor(dirPath) + blocksFor(originalPath);

    const result = measureWorktreeConsumption(dirPath);
    expect(result.status).toBe("measured");
    expect((result as { status: "measured"; bytes: number }).bytes).toBe(expected);
  });

  it("treats an empty directory as a legitimate measurement, not an error", () => {
    const emptyPath = path.join(dirPath, "empty");
    fs.mkdirSync(emptyPath);

    const result = measureWorktreeConsumption(emptyPath);
    expect(result.status).toBe("measured");
    expect((result as { status: "measured"; bytes: number }).bytes).toBe(blocksFor(emptyPath));
  });
});

describe("measureContainerConsumption", () => {
  it("splits each worktree's containers into reclaimable writable and shared image bytes", () => {
    const inspect = stubInspect([
      container({ id: "alpha1", worktreePath: ALPHA, sizeRw: 1000, sizeRootFs: 5000 }),
      container({ id: "beta1", worktreePath: BETA, sizeRw: 20, sizeRootFs: 20 }),
    ]);

    expect(measureContainerConsumption([ALPHA, BETA], { inspect })).toEqual(
      new Map([
        [
          ALPHA,
          {
            containerWritable: { status: "measured", bytes: 1000 },
            imageShared: { status: "measured", bytes: 4000 },
          },
        ],
        [
          // A container whose root is entirely its own writable layer shares
          // nothing; zero here is a measurement, not a missing figure.
          BETA,
          {
            containerWritable: { status: "measured", bytes: 20 },
            imageShared: { status: "measured", bytes: 0 },
          },
        ],
      ]),
    );
  });

  it("excludes a compose sibling that carries the workspace label but never mounts the worktree", () => {
    // A dependency service of the same compose project — a database, say —
    // shares the app container's `working_dir` label but bind-mounts no
    // worktree, so it stays outside this workspace's figures and is never
    // even sized.
    const sibling: WorkspaceContainerSnapshot = {
      ...container({ id: "alphaDb", worktreePath: ALPHA, sizeRw: 999, sizeRootFs: 999_999 }),
      mounts: [{ Type: "volume", Source: "pgdata", Destination: "/var/lib/postgresql/data" }],
    };
    const inspect = stubInspect([
      container({ id: "alpha1", worktreePath: ALPHA, sizeRw: 1000, sizeRootFs: 5000 }),
      sibling,
    ]);

    expect(measureContainerConsumption([ALPHA], { inspect })).toEqual(
      new Map([
        [
          ALPHA,
          {
            containerWritable: { status: "measured", bytes: 1000 },
            imageShared: { status: "measured", bytes: 4000 },
          },
        ],
      ]),
    );
    expect(inspect).toHaveBeenLastCalledWith({ withSize: true, ids: ["alpha1"] });
  });

  it("reports a worktree with no container as measured zero rather than unknown", () => {
    const inspect = stubInspect([
      container({ id: "beta1", worktreePath: BETA, sizeRw: 20, sizeRootFs: 20 }),
    ]);

    expect(measureContainerConsumption([ALPHA], { inspect })).toEqual(
      new Map([
        [
          ALPHA,
          {
            containerWritable: { status: "measured", bytes: 0 },
            imageShared: { status: "measured", bytes: 0 },
          },
        ],
      ]),
    );
    // Nothing was attributed, so the expensive sizing pass is skipped entirely.
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("reports unknown when the daemon declines to size an attributed container", () => {
    const inspect = stubInspect([
      container({ id: "alpha1", worktreePath: ALPHA, sizeRw: null, sizeRootFs: null }),
    ]);

    const alpha = measureContainerConsumption([ALPHA], { inspect }).get(ALPHA);
    expect(alpha?.containerWritable).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("alpha1"),
    });
    expect(alpha?.imageShared.status).toBe("unknown");
  });

  it("reports unknown when a root filesystem smaller than its writable layer makes the split incoherent", () => {
    const inspect = stubInspect([
      container({ id: "alpha1", worktreePath: ALPHA, sizeRw: 5000, sizeRootFs: 1000 }),
    ]);

    const alpha = measureContainerConsumption([ALPHA], { inspect }).get(ALPHA);
    expect(alpha?.containerWritable.status).toBe("unknown");
    // Never a negative shared figure derived from the impossible pair.
    expect(alpha?.imageShared.status).toBe("unknown");
  });

  it("never reaches Docker at all when the report has no managed workspaces", () => {
    const inspect = stubInspect([
      container({ id: "beta1", worktreePath: BETA, sizeRw: 20, sizeRootFs: 20 }),
    ]);

    expect(measureContainerConsumption([], { inspect }).size).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("lets a Docker failure reach the caller instead of reporting zero bytes", () => {
    const inspect = vi.fn(() => {
      throw new Error("docker ps failed: Cannot connect to the Docker daemon");
    }) as unknown as typeof inspectWorkspaceContainers;

    expect(() => measureContainerConsumption([ALPHA], { inspect })).toThrow(
      /Cannot connect to the Docker daemon/,
    );
  });
});

function stubInspect(snapshots: WorkspaceContainerSnapshot[]) {
  // Mirrors the real two-phase call: the first pass reports no sizes at all,
  // and only the ids named in the sized pass come back carrying them.
  return vi.fn((options?: { withSize?: boolean; ids?: string[] }) => {
    if (!options?.withSize) {
      return snapshots.map(({ sizeRw, sizeRootFs, ...rest }) => rest);
    }
    return snapshots.filter((snapshot) => options.ids?.includes(snapshot.id));
  }) as unknown as typeof inspectWorkspaceContainers;
}

function container(options: {
  id: string;
  worktreePath: string;
  sizeRw: number | null;
  sizeRootFs: number | null;
}): WorkspaceContainerSnapshot {
  return {
    id: options.id,
    state: { Running: true },
    labels: {
      "com.docker.compose.project.working_dir": path.join(options.worktreePath, ".devcontainer"),
    },
    mounts: [{ Type: "bind", Source: options.worktreePath, Destination: "/workspaces/app" }],
    networks: {},
    sizeRw: options.sizeRw,
    sizeRootFs: options.sizeRootFs,
  };
}

function blocksFor(entryPath: string): number {
  return fs.lstatSync(entryPath).blocks * 512;
}

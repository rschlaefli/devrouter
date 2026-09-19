import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fileLock from "../file-lock";
import {
  claimHarnessContinuation,
  HARNESS_CONTINUATION_MAX_ENTRIES,
  HARNESS_CONTINUATION_TTL_MS,
  harnessContinuationPath,
  readHarnessContinuations,
  settleHarnessContinuation,
} from "../harness-continuation";

vi.mock("../router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../router")>();
  const actualFs = await import("node:fs");
  const actualOs = await import("node:os");
  const actualPath = await import("node:path");
  const root = actualFs.mkdtempSync(actualPath.join(actualOs.tmpdir(), "harness-continuation-"));
  actualFs.chmodSync(root, 0o700);
  return { ...actual, DEVROUTER_HOME: root };
});

vi.mock("../file-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../file-lock")>();
  return {
    ...actual,
    withFileLockSync: vi.fn((_path: string, _options: unknown, operation: () => unknown) =>
      operation(),
    ),
  };
});

const SHA = "a".repeat(64);

function claimInput(toolUseId: string, nowMs?: number) {
  return {
    toolUseId,
    payloadSha256: SHA,
    phase: "stopping",
    budgetMs: 30_000,
    ...(nowMs === undefined ? {} : { nowMs }),
  };
}

describe("harness continuation ledger", () => {
  let tmpDir: string;

  function checkout(name: string): string {
    const root = path.join(tmpDir, name);
    fs.mkdirSync(root, { recursive: true });
    return fs.realpathSync(root);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-continuation-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(fileLock.withFileLockSync).mockImplementation(
      (_path: string, _options: unknown, operation: () => unknown) => operation() as never,
    );
  });

  it("claims a gated call and records it durably with private permissions", () => {
    const root = checkout("repo");
    expect(claimHarnessContinuation(root, claimInput("toolu_1"))).toEqual({
      kind: "claimed",
      recorded: true,
    });

    const file = harnessContinuationPath(root);
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readHarnessContinuations(root)).toMatchObject([
      {
        toolUseId: "toolu_1",
        payloadSha256: SHA,
        state: "waiting",
        phase: "stopping",
        budgetMs: 30_000,
      },
    ]);
  });

  it("replays an existing tool call instead of claiming it again", () => {
    const root = checkout("repo");
    claimHarnessContinuation(root, claimInput("toolu_1", 1_000));
    const replay = claimHarnessContinuation(root, claimInput("toolu_1", 2_000));

    expect(replay).toMatchObject({
      kind: "replay",
      entry: { toolUseId: "toolu_1", state: "waiting", claimedAtMs: 1_000 },
    });
    expect(readHarnessContinuations(root, 2_000)).toHaveLength(1);
  });

  it("settles a waiting claim once and preserves the first decision", () => {
    const root = checkout("repo");
    claimHarnessContinuation(root, claimInput("toolu_1", 1_000));
    settleHarnessContinuation(root, "toolu_1", { state: "granted", waitedMs: 6_000, nowMs: 7_000 });
    settleHarnessContinuation(root, "toolu_1", { state: "refused", nowMs: 8_000 });

    expect(readHarnessContinuations(root, 8_000)).toMatchObject([
      { state: "granted", waitedMs: 6_000, settledAtMs: 7_000 },
    ]);
  });

  it("does not create an entry when settling an unknown tool call", () => {
    const root = checkout("repo");
    settleHarnessContinuation(root, "toolu_missing", { state: "interrupted" });
    expect(fs.existsSync(harnessContinuationPath(root))).toBe(false);
  });

  it("expires entries after the retention window", () => {
    const root = checkout("repo");
    claimHarnessContinuation(root, claimInput("toolu_1", 1_000));
    const expired = claimHarnessContinuation(
      root,
      claimInput("toolu_1", 1_000 + HARNESS_CONTINUATION_TTL_MS + 1),
    );

    expect(expired).toEqual({ kind: "claimed", recorded: true });
    expect(readHarnessContinuations(root, 1_000 + HARNESS_CONTINUATION_TTL_MS + 2)).toHaveLength(1);
  });

  it("keeps only the newest entries within the bound", () => {
    const root = checkout("repo");
    for (let index = 0; index < HARNESS_CONTINUATION_MAX_ENTRIES + 6; index += 1) {
      claimHarnessContinuation(root, claimInput(`toolu_${index}`, 1_000 + index));
    }

    const entries = readHarnessContinuations(root, 2_000);
    expect(entries).toHaveLength(HARNESS_CONTINUATION_MAX_ENTRIES);
    expect(entries[0]?.toolUseId).toBe("toolu_6");
    expect(claimHarnessContinuation(root, claimInput("toolu_0", 2_000))).toEqual({
      kind: "claimed",
      recorded: true,
    });
  });

  it("treats unsafe or foreign evidence as absent", () => {
    const symlinked = checkout("symlink");
    const symlinkFile = harnessContinuationPath(symlinked);
    fs.mkdirSync(path.dirname(symlinkFile), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, "elsewhere.json"), symlinkFile);
    expect(claimHarnessContinuation(symlinked, claimInput("toolu_1"))).toEqual({
      kind: "claimed",
      recorded: true,
    });

    const loose = checkout("loose");
    const looseFile = harnessContinuationPath(loose);
    fs.mkdirSync(path.dirname(looseFile), { recursive: true });
    fs.writeFileSync(looseFile, JSON.stringify([{ toolUseId: "toolu_1" }]), { mode: 0o644 });
    expect(readHarnessContinuations(loose)).toEqual([]);
    expect(claimHarnessContinuation(loose, claimInput("toolu_1"))).toEqual({
      kind: "claimed",
      recorded: true,
    });

    const garbage = checkout("garbage");
    const garbageFile = harnessContinuationPath(garbage);
    fs.mkdirSync(path.dirname(garbageFile), { recursive: true });
    fs.writeFileSync(garbageFile, "{not json", { mode: 0o600 });
    expect(claimHarnessContinuation(garbage, claimInput("toolu_1"))).toEqual({
      kind: "claimed",
      recorded: true,
    });
  });

  it("keys evidence by the checkout's comparable real path", () => {
    const first = checkout("first");
    const second = checkout("second");
    claimHarnessContinuation(first, claimInput("toolu_1"));
    expect(harnessContinuationPath(first)).not.toBe(harnessContinuationPath(second));
    expect(claimHarnessContinuation(second, claimInput("toolu_1"))).toEqual({
      kind: "claimed",
      recorded: true,
    });
  });

  it("claims without blocking when the ledger cannot be locked", () => {
    const root = checkout("repo");
    const lock = vi.mocked(fileLock.withFileLockSync);
    lock.mockImplementationOnce(() => {
      throw new Error("lock unavailable");
    });
    expect(claimHarnessContinuation(root, claimInput("toolu_1"))).toEqual({
      kind: "claimed",
      recorded: false,
    });
    expect(fs.existsSync(harnessContinuationPath(root))).toBe(false);
  });

  it("creates the ledger directory before taking the lock", () => {
    const root = checkout("repo");
    const file = harnessContinuationPath(root);
    const lock = vi.mocked(fileLock.withFileLockSync);
    lock.mockImplementationOnce((lockPath: string, _options: unknown, operation: () => unknown) => {
      expect(fs.existsSync(path.dirname(lockPath))).toBe(true);
      return operation() as never;
    });
    expect(claimHarnessContinuation(root, claimInput("toolu_1"))).toEqual({
      kind: "claimed",
      recorded: true,
    });
    expect(fs.existsSync(file)).toBe(true);
  });
});

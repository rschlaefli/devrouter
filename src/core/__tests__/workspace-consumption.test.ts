import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measureWorktreeConsumption } from "../workspace-consumption";

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

function blocksFor(entryPath: string): number {
  return fs.lstatSync(entryPath).blocks * 512;
}

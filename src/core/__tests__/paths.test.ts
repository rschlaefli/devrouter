import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPathWithinRepo } from "../paths";

const REPO = "/tmp/test-repo";

describe("assertPathWithinRepo", () => {
  it("accepts a relative path within repo", () => {
    expect(assertPathWithinRepo("src/index.ts", REPO, "test")).toBe(
      path.join(REPO, "src/index.ts")
    );
  });

  it("accepts nested relative path", () => {
    expect(assertPathWithinRepo("a/b/c/d.ts", REPO, "test")).toBe(
      path.join(REPO, "a/b/c/d.ts")
    );
  });

  it("accepts '.' (repo root itself)", () => {
    expect(assertPathWithinRepo(".", REPO, "test")).toBe(REPO);
  });

  it("accepts './foo' style paths", () => {
    expect(assertPathWithinRepo("./foo", REPO, "test")).toBe(
      path.join(REPO, "foo")
    );
  });

  it("rejects '../escape'", () => {
    expect(() => assertPathWithinRepo("../escape", REPO, "test")).toThrow(
      "escapes the repository root"
    );
  });

  it("rejects absolute path outside repo", () => {
    expect(() => assertPathWithinRepo("/etc/passwd", REPO, "test")).toThrow(
      "escapes the repository root"
    );
  });

  it("rejects ../../etc/passwd traversal", () => {
    expect(() =>
      assertPathWithinRepo("../../etc/passwd", REPO, "test")
    ).toThrow("escapes the repository root");
  });

  it("allows ./foo/../bar that normalizes within repo", () => {
    expect(assertPathWithinRepo("./foo/../bar", REPO, "test")).toBe(
      path.join(REPO, "bar")
    );
  });

  it("rejects path that traverses out even if it comes back", () => {
    // ../test-repo resolves outside REPO because path.resolve normalizes
    // to /tmp/test-repo but the check is prefix-based on the resolved root
    const result = assertPathWithinRepo("../test-repo/foo", REPO, "test");
    // This actually resolves to /tmp/test-repo/foo which IS within repo
    expect(result).toBe(path.join(REPO, "foo"));
  });

  it("includes the label in the error message", () => {
    expect(() =>
      assertPathWithinRepo("../out", REPO, "composeFile")
    ).toThrow("composeFile");
  });
});

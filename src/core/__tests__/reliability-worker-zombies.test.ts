import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerGroupAbsent } from "../reliability-worker";

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform !== "linux")("worker groups with unreaped Linux children", () => {
  function observe(stats: Record<string, string | Error>) {
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.spyOn(fs, "readdirSync").mockReturnValue(
      Object.keys(stats) as unknown as ReturnType<typeof fs.readdirSync>,
    );
    vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
      const result = stats[String(file).split("/")[2]];
      if (result instanceof Error) throw result;
      return result;
    });
  }

  it("recognizes a group whose only remaining child is a zombie", () => {
    observe({ "101": "101 (docker (exec)) Z 1 100 100 0", "200": "200 (node) S 1 200 200 0" });
    expect(workerGroupAbsent(100)).toBe(true);
  });

  it.each(["S", "R", "D", "T"])("keeps a group with a %s child fenced", (state) => {
    observe({ "101": "101 (docker) Z 1 100 100 0", "102": `102 (node) ${state} 1 100 100 0` });
    expect(workerGroupAbsent(100)).toBe(false);
  });

  it("does not infer cessation from an unreadable process", () => {
    observe({
      "101": "101 (docker) Z 1 100 100 0",
      "102": Object.assign(new Error(), { code: "EACCES" }),
    });
    expect(workerGroupAbsent(100)).toBe(false);
  });

  it("allows a process that disappeared during observation", () => {
    observe({
      "101": "101 (docker) Z 1 100 100 0",
      "102": Object.assign(new Error(), { code: "ENOENT" }),
    });
    expect(workerGroupAbsent(100)).toBe(true);
  });

  it.each([
    "invalid",
    "101 (docker) Z 1 invalid",
    "101 (docker) unknown 1 100",
  ])("rejects malformed process evidence: %s", (stat) => {
    observe({ "101": stat });
    expect(workerGroupAbsent(100)).toBe(false);
  });

  it("keeps unknown groups fenced when the signal probe still finds them", () => {
    observe({ "200": "200 (node) S 1 200 200 0" });
    expect(workerGroupAbsent(100)).toBe(false);
  });

  it("preserves the absent-group signal result", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(), { code: "ESRCH" });
    });
    expect(workerGroupAbsent(100)).toBe(true);
  });

  it("does not mistake a denied signal probe for absence", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(), { code: "EPERM" });
    });
    expect(workerGroupAbsent(100)).toBe(false);
  });
});

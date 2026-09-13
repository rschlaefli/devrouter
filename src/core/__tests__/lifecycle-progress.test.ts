import { describe, expect, it } from "vitest";
import {
  installLifecycleProgressSender,
  isLifecycleProgressPhase,
  lifecycleProgressSnapshot,
  reportLifecycleProgress,
} from "../lifecycle-progress";

describe("lifecycle progress", () => {
  it("accepts only protocol stages and reports no inferred liveness", () => {
    expect(isLifecycleProgressPhase("preparation")).toBe(true);
    for (const input of ["constructor", "__proto__", "arbitrary argv", {}, null, 1])
      expect(isLifecycleProgressPhase(input)).toBe(false);
    expect(lifecycleProgressSnapshot("preparation", 100, 150)).toEqual({
      type: "lifecycle-progress",
      phase: "preparation",
      role: "repository-preparation",
      elapsedMs: 50,
      evidence: "recent",
      liveness: "unknown",
    });
  });

  it("reports unknown before a receipt and stale at the exact age boundary", () => {
    expect(lifecycleProgressSnapshot(undefined, undefined, 1)).toMatchObject({
      phase: "unknown",
      role: "unknown",
      elapsedMs: null,
      evidence: "unknown",
    });
    expect(lifecycleProgressSnapshot("readiness", 10, 30_009).evidence).toBe("recent");
    expect(lifecycleProgressSnapshot("readiness", 10, 30_010).evidence).toBe("stale");
    expect(lifecycleProgressSnapshot("readiness", 10, 5).elapsedMs).toBe(0);
  });

  it("bounds pending delivery to one send and the latest phase", () => {
    const sent: unknown[] = [];
    const done: (() => void)[] = [];
    const stop = installLifecycleProgressSender((message, callback) => {
      sent.push(message);
      done.push(callback);
    });
    try {
      reportLifecycleProgress("validation");
      reportLifecycleProgress("preparation");
      reportLifecycleProgress("provider");
      expect(sent).toEqual([{ lifecycleProgress: "validation" }]);
      done[0]();
      expect(sent).toEqual([
        { lifecycleProgress: "validation" },
        { lifecycleProgress: "provider" },
      ]);
      stop();
      done[1]();
      reportLifecycleProgress("readiness");
      expect(sent).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("isolates a throwing transport without retaining a pending send", () => {
    let calls = 0;
    const stop = installLifecycleProgressSender(() => {
      calls += 1;
      throw new Error("unavailable");
    });
    try {
      expect(() => reportLifecycleProgress("stop")).not.toThrow();
      expect(() => reportLifecycleProgress("route-removal")).not.toThrow();
      expect(calls).toBe(2);
    } finally {
      stop();
    }
  });
});

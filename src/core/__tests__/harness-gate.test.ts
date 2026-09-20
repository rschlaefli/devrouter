import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findHarnessGateRepoRoot,
  HARNESS_GATE_DEFAULT_BUDGET_MS,
  HARNESS_GATE_MAX_BUDGET_MS,
  isTransitionalHarnessPhase,
  parseHarnessGateBudget,
  readHarnessGateObservation,
  waitForHarnessGate,
} from "../harness-gate";

type Observation = ReturnType<typeof readHarnessGateObservation>;

function createClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function scriptedObservations(script: Observation[]): () => Observation {
  let index = 0;
  return () => {
    const observation = script[index];
    index = Math.min(index + 1, script.length - 1);
    return observation;
  };
}

describe("waitForHarnessGate", () => {
  it.each([
    "idle",
    "stable",
  ] as const)("allows without waiting when the phase is %s", async (phase) => {
    const clock = createClock();
    const sleep = [] as number[];

    const decision = await waitForHarnessGate({
      observe: () => ({ phase }),
      budgetMs: 5_000,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
        await clock.sleep(ms);
      },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      reason: "settled",
      waitedMs: 0,
      observations: 1,
      observedPhase: phase,
    });
    expect(sleep).toEqual([]);
  });

  it("defers each transitional phase until the phase settles", async () => {
    const clock = createClock();
    const sleep: number[] = [];

    const decision = await waitForHarnessGate({
      observe: scriptedObservations([
        { phase: "starting" },
        { phase: "verifying" },
        { phase: "stable" },
      ]),
      budgetMs: 30_000,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
        await clock.sleep(ms);
      },
    });

    expect(sleep).toEqual([2_000, 2_000]);
    expect(decision).toMatchObject({
      decision: "deferred-allow",
      reason: "settled-after-wait",
      waitedMs: 4_000,
      observations: 3,
      observedPhase: "stable",
    });
  });

  it("does not charge the first observation to the wait budget", async () => {
    const clock = createClock();
    const sleep: number[] = [];
    let first = true;

    const decision = await waitForHarnessGate({
      observe: () => {
        if (first) {
          first = false;
          // A cold hook process resolves the checkout's identity before it can
          // read a phase; that setup is not part of the wait.
          clock.advance(5_000);
          return { phase: "starting" };
        }
        return { phase: "stable" };
      },
      budgetMs: 4_000,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
        await clock.sleep(ms);
      },
    });

    expect(sleep).toEqual([2_000]);
    expect(decision).toMatchObject({
      decision: "deferred-allow",
      reason: "settled-after-wait",
      waitedMs: 2_000,
      observations: 2,
      observedPhase: "stable",
    });
  });

  it("refuses once at the deadline when the transition outlasts the budget", async () => {
    const clock = createClock();
    const sleep: number[] = [];

    const decision = await waitForHarnessGate({
      observe: () => ({ phase: "stopping" }),
      budgetMs: 5_000,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
        await clock.sleep(ms);
      },
    });

    // The final partial interval is spent instead of refused, so the wait ends
    // on the granted budget rather than one interval short of it.
    expect(sleep).toEqual([2_000, 2_000, 1_000]);
    expect(decision).toMatchObject({
      decision: "refuse",
      reason: "budget-exhausted",
      waitedMs: 5_000,
      observations: 4,
      observedPhase: "stopping",
    });
  });

  it("refuses after a single observation with a zero budget", async () => {
    const clock = createClock();
    const sleep: number[] = [];

    const decision = await waitForHarnessGate({
      observe: () => ({ phase: "queued" }),
      budgetMs: 0,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
      },
    });

    expect(sleep).toEqual([]);
    expect(decision).toMatchObject({
      decision: "refuse",
      reason: "budget-exhausted",
      waitedMs: 0,
      observations: 1,
    });
  });

  it("reports unknown evidence as unavailable instead of settled", async () => {
    const clock = createClock();

    const decision = await waitForHarnessGate({
      observe: () => ({ phase: "unknown", detail: "evidence-unavailable" }),
      budgetMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(decision).toMatchObject({
      decision: "allow",
      reason: "evidence-unavailable",
      observedPhase: "unknown",
    });
  });

  it("waits the remaining partial interval before refusing", async () => {
    const clock = createClock();
    const sleep: number[] = [];

    const decision = await waitForHarnessGate({
      observe: () => ({ phase: "stopping" }),
      budgetMs: 1_500,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
        await clock.sleep(ms);
      },
    });

    expect(sleep).toEqual([1_500]);
    expect(decision).toMatchObject({
      decision: "refuse",
      reason: "budget-exhausted",
      waitedMs: 1_500,
      observations: 2,
    });
  });

  it("still observes the phase when a settle lands on the deadline", async () => {
    const clock = createClock();
    const sleep: number[] = [];
    const observe = scriptedObservations([{ phase: "stopping" }, { phase: "idle" }]);

    const decision = await waitForHarnessGate({
      observe,
      budgetMs: 1_500,
      pollIntervalMs: 2_000,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
        await clock.sleep(ms);
      },
    });

    expect(sleep).toEqual([1_500]);
    expect(decision).toMatchObject({
      decision: "deferred-allow",
      reason: "settled-after-wait",
      waitedMs: 1_500,
      observedPhase: "idle",
    });
  });

  it("spends a budget that is not a multiple of the interval without overrunning it", async () => {
    const clock = createClock();
    const sleep: number[] = [];

    const decision = await waitForHarnessGate({
      observe: () => ({ phase: "recovering" }),
      budgetMs: 5_000,
      pollIntervalMs: 3_000,
      now: clock.now,
      sleep: async (ms) => {
        sleep.push(ms);
        await clock.sleep(ms);
      },
    });

    expect(sleep).toEqual([3_000, 2_000]);
    expect(sleep.reduce((total, ms) => total + ms, 0)).toBe(5_000);
    expect(decision).toMatchObject({
      decision: "refuse",
      reason: "budget-exhausted",
      waitedMs: 5_000,
      observations: 3,
    });
  });

  it("marks exactly the in-flight phases as transitional", () => {
    for (const phase of ["queued", "starting", "verifying", "recovering", "stopping"] as const) {
      expect(isTransitionalHarnessPhase(phase)).toBe(true);
    }
    for (const phase of ["idle", "stable", "unknown"] as const) {
      expect(isTransitionalHarnessPhase(phase)).toBe(false);
    }
  });
});

describe("parseHarnessGateBudget", () => {
  it("clamps and defaults an out-of-range budget", () => {
    expect(parseHarnessGateBudget(undefined)).toBe(HARNESS_GATE_DEFAULT_BUDGET_MS);
    expect(parseHarnessGateBudget("not-a-number")).toBe(HARNESS_GATE_DEFAULT_BUDGET_MS);
    expect(parseHarnessGateBudget(-5)).toBe(HARNESS_GATE_DEFAULT_BUDGET_MS);
    expect(parseHarnessGateBudget("1500")).toBe(1_500);
    expect(parseHarnessGateBudget(10_000_000)).toBe(HARNESS_GATE_MAX_BUDGET_MS);
  });
});

describe("findHarnessGateRepoRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-harness-gate-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("walks up from a session directory to the managed checkout", () => {
    const repoRoot = path.join(tmpDir, "repo");
    const nested = path.join(repoRoot, "packages", "app", "src");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");

    expect(findHarnessGateRepoRoot(nested)).toBe(path.resolve(repoRoot));
    expect(findHarnessGateRepoRoot(tmpDir)).toBeUndefined();
  });

  it("reports unknown evidence for a checkout without a lifecycle record", () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });

    expect(readHarnessGateObservation(repoRoot)).toMatchObject({ phase: "unknown" });
  });

  it("claims once before the first deferral and refuses a replay", async () => {
    const clock = createClock();
    const claim = vi.fn(() => ({
      kind: "replay" as const,
      state: "granted" as const,
      settledAtMs: 500,
    }));

    const decision = await waitForHarnessGate({
      observe: scriptedObservations([{ phase: "stopping" }, { phase: "stable" }]),
      budgetMs: 30_000,
      now: clock.now,
      sleep: clock.sleep,
      claim,
    });

    expect(claim).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      decision: "refuse",
      reason: "continuation-replay",
      observedPhase: "stopping",
      continuation: { state: "granted", settledAtMs: 500 },
    });
    expect(clock.now()).toBe(0);
  });

  it("does not claim a settled phase or a spent budget", async () => {
    const settledClaim = vi.fn();
    await waitForHarnessGate({
      observe: scriptedObservations([{ phase: "stable" }]),
      budgetMs: 30_000,
      claim: settledClaim,
    });
    expect(settledClaim).not.toHaveBeenCalled();

    const spentClaim = vi.fn();
    const spent = await waitForHarnessGate({
      observe: scriptedObservations([{ phase: "starting" }]),
      budgetMs: 0,
      claim: spentClaim,
    });
    expect(spentClaim).not.toHaveBeenCalled();
    expect(spent).toMatchObject({ decision: "refuse", reason: "budget-exhausted" });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessGateObservation } from "../../core/harness-gate";
import { type HarnessGateDependencies, runHarnessCommand } from "../harness";

function stdoutLines(): string[] {
  return vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0]));
}

function lastStdoutJson(): Record<string, unknown> {
  const lines = stdoutLines();
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
}

function hookPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    cwd: "/repo",
    ...overrides,
  });
}

function dependencies(overrides: Partial<HarnessGateDependencies> = {}): HarnessGateDependencies {
  return {
    stdin: async () => hookPayload(),
    observe: vi.fn((): HarnessGateObservation => ({ phase: "stable" })),
    stderr: vi.fn(),
    ...overrides,
  };
}

describe("runHarnessCommand gate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-harness-command-test-"));
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints the harness hook decision for a settled environment", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");
    const observe = vi.fn((): HarnessGateObservation => ({ phase: "stable" }));
    const stderr = vi.fn();

    await runHarnessCommand(
      "gate",
      {},
      undefined,
      dependencies({ stdin: async () => hookPayload({ cwd: repoRoot }), observe, stderr }),
    );

    expect(lastStdoutJson()).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "devrouter: environment settled.",
      },
    });
    expect(observe).toHaveBeenCalledWith(path.resolve(repoRoot));
    const printed = stderr.mock.calls.map((call) => String(call[0]));
    expect(printed.join("\n")).not.toContain("deferring");
  });

  it("renders the Codex hook envelope for an allowed call", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");

    await runHarnessCommand(
      "gate",
      {},
      undefined,
      dependencies({
        stdin: async () =>
          hookPayload({ cwd: repoRoot, prompt_id: undefined, turn_id: "01a0bdf9-turn" }),
        observe: (): HarnessGateObservation => ({ phase: "stable" }),
      }),
    );

    const output = lastStdoutJson() as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision?: string;
        additionalContext?: string;
      };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.additionalContext).toBe("devrouter: environment settled.");
  });

  it("refuses an exhausted Codex wait with a deny envelope", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");

    await runHarnessCommand(
      "gate",
      { waitBudgetMs: "1000" },
      undefined,
      dependencies({
        stdin: async () =>
          hookPayload({ cwd: repoRoot, prompt_id: undefined, turn_id: "01a0bdf9-turn" }),
        observe: (): HarnessGateObservation => ({ phase: "starting" }),
        sleep: async () => {},
      }),
    );

    const output = lastStdoutJson() as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("still starting");
  });

  it("defers while the environment is transitional and allows after it settles", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");
    const phases = ["starting", "verifying", "stable"] as const;
    let index = 0;
    const observe = vi.fn(
      (): HarnessGateObservation => ({ phase: phases[Math.min(index++, phases.length - 1)] }),
    );
    const stderr = vi.fn();

    await runHarnessCommand(
      "gate",
      { json: true, waitBudgetMs: "30000" },
      undefined,
      dependencies({
        stdin: async () => hookPayload({ cwd: repoRoot }),
        observe,
        stderr,
        sleep: async () => {},
      }),
    );

    expect(lastStdoutJson()).toMatchObject({
      decision: "deferred-allow",
      reason: "settled-after-wait",
      observations: 3,
      observedPhase: "stable",
      checkout: path.resolve(repoRoot),
    });
    const printed = stderr.mock.calls.map((call) => String(call[0]));
    expect(printed[0]).toContain("starting in progress");
    expect(printed[0]).toContain("without model turns");
  });

  it("refuses once with recovery guidance when the budget is exhausted", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");

    await runHarnessCommand(
      "gate",
      { waitBudgetMs: "1000" },
      undefined,
      dependencies({
        stdin: async () => hookPayload({ cwd: repoRoot }),
        observe: (): HarnessGateObservation => ({ phase: "stopping" }),
        sleep: async () => {},
      }),
    );

    const output = lastStdoutJson() as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("still stopping");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      "Do not retry automatically",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("passes a devrouter lifecycle command through without observing", async () => {
    const observe = vi.fn((): HarnessGateObservation => ({ phase: "stopping" }));

    await runHarnessCommand(
      "gate",
      {},
      undefined,
      dependencies({
        stdin: async () =>
          hookPayload({ tool_input: { command: "pnpm devrouter ensure . --json" }, cwd: tmpDir }),
        observe,
      }),
    );

    expect(observe).not.toHaveBeenCalled();
    expect(lastStdoutJson()).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("allows an unmanaged checkout, an invalid payload and a missing directory", async () => {
    const observe = vi.fn((): HarnessGateObservation => ({ phase: "stopping" }));

    await runHarnessCommand(
      "gate",
      { json: true },
      undefined,
      dependencies({ stdin: async () => hookPayload({ cwd: tmpDir }), observe }),
    );
    expect(lastStdoutJson()).toMatchObject({ decision: "allow", reason: "unmanaged-checkout" });

    await runHarnessCommand(
      "gate",
      { json: true },
      undefined,
      dependencies({ stdin: async () => "not json", observe }),
    );
    expect(lastStdoutJson()).toMatchObject({ decision: "allow", reason: "hook-payload-invalid" });

    await runHarnessCommand(
      "gate",
      { json: true },
      undefined,
      dependencies({ stdin: async () => hookPayload({ cwd: "/does/not/exist" }), observe }),
    );
    expect(lastStdoutJson()).toMatchObject({ decision: "allow", reason: "unmanaged-checkout" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("gates non-shell tools through the same decision path", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");
    const observe = vi.fn((): HarnessGateObservation => ({ phase: "idle" }));

    await runHarnessCommand(
      "gate",
      {},
      repoRoot,
      dependencies({
        stdin: async () => hookPayload({ tool_name: "Read", tool_input: { file_path: "a" } }),
        observe,
      }),
    );

    expect(observe).toHaveBeenCalledWith(path.resolve(repoRoot));
    expect(lastStdoutJson()).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("claims a gated call before deferring and settles the granted wait", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");
    const phases = ["stopping", "stable"] as const;
    let index = 0;
    const observe = vi.fn(
      (): HarnessGateObservation => ({ phase: phases[Math.min(index++, phases.length - 1)] }),
    );
    const claim = vi.fn(() => ({ kind: "claimed" as const }));
    const settle = vi.fn();

    await runHarnessCommand(
      "gate",
      { json: true, waitBudgetMs: "30000" },
      undefined,
      dependencies({
        stdin: async () => hookPayload({ cwd: repoRoot, tool_use_id: "toolu_gate_1" }),
        observe,
        claim,
        settle,
        // A fixed clock keeps the recorded wait deterministic; the wall clock
        // can cross a millisecond boundary while the loop runs.
        now: () => 500,
        sleep: async () => {},
      }),
    );

    expect(claim).toHaveBeenCalledWith(path.resolve(repoRoot), {
      toolUseId: "toolu_gate_1",
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      phase: "stopping",
      budgetMs: 30_000,
    });
    expect(settle).toHaveBeenCalledWith(path.resolve(repoRoot), "toolu_gate_1", {
      state: "granted",
      waitedMs: 0,
    });
    expect(lastStdoutJson()).toMatchObject({ decision: "deferred-allow" });
  });

  it.each([
    ["granted", /already permitted/],
    ["interrupted", /wait was cancelled/],
    ["refused", /already refused/],
  ] as const)("refuses a replayed call whose claim is %s", async (state, expected) => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");
    const observe = vi.fn((): HarnessGateObservation => ({ phase: "idle" }));
    const claim = vi.fn();
    const settle = vi.fn();

    await runHarnessCommand(
      "gate",
      {},
      undefined,
      dependencies({
        stdin: async () => hookPayload({ cwd: repoRoot, tool_use_id: "toolu_gate_1" }),
        observe,
        claim,
        lookup: () => ({ state, settledAtMs: Date.now() - 5_000 }),
        settle,
      }),
    );

    const output = lastStdoutJson() as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(expected);
    expect(claim).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("keeps the wait-only behavior for payloads without a tool_use_id", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");
    const observe = vi.fn((): HarnessGateObservation => ({ phase: "idle" }));
    const claim = vi.fn();
    const settle = vi.fn();

    await runHarnessCommand(
      "gate",
      { json: true },
      undefined,
      dependencies({ stdin: async () => hookPayload({ cwd: repoRoot }), observe, claim, settle }),
    );

    expect(claim).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(lastStdoutJson()).toMatchObject({ decision: "allow", reason: "settled" });
  });

  it("settles the claim as interrupted when the harness cancels the hook", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".devrouter.yml"), "version: 1\n", "utf-8");
    const settle = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-interrupted");
    }) as never);
    let current = 0;

    const run = runHarnessCommand(
      "gate",
      { json: true, waitBudgetMs: "4000" },
      undefined,
      dependencies({
        stdin: async () => hookPayload({ cwd: repoRoot, tool_use_id: "toolu_gate_2" }),
        observe: (): HarnessGateObservation => ({ phase: "stopping" }),
        claim: () => ({ kind: "claimed" }),
        settle,
        now: () => current,
        sleep: async (ms: number) => {
          current += ms;
        },
      }),
    );

    await Promise.resolve();
    let raised: unknown;
    try {
      process.emit("SIGTERM");
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Error);
    expect(settle.mock.calls[0]).toEqual([
      path.resolve(repoRoot),
      "toolu_gate_2",
      {
        state: "interrupted",
      },
    ]);
    expect(exit).toHaveBeenCalledWith(143);
    exit.mockRestore();
    process.removeAllListeners("SIGTERM");
    await run;
  });
});

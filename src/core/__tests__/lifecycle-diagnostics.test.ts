import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLogsCommand } from "../../commands/logs";
import {
  LifecycleDiagnosticRecorder,
  lifecycleDiagnosticsPath,
  readLifecycleDiagnostics,
} from "../lifecycle-diagnostics";
import { createReliabilityState, reliabilityFence } from "../reliability-contract";
import type { ReliabilityOperationRecord } from "../reliability-operation-store";
import { LifecycleOutput, type LifecycleWorkerRequest } from "../reliability-worker";

const fixture = vi.hoisted(() => ({ home: "", read: vi.fn() }));
vi.mock("../router", () => ({
  get DEVROUTER_HOME() {
    return fixture.home;
  },
}));
vi.mock("../reliability-operation-store", () => ({ readReliabilityOperation: fixture.read }));
vi.mock("../docker", () => ({ isContainerRunning: vi.fn() }));
vi.mock("../workspace", () => ({ resolveWorktreeWorkspace: () => undefined }));
vi.mock("../workspace-runtime", () => ({ resolveWorkspaceRuntimeForReport: () => "devsy" }));
vi.mock("../../commands/environment-path", () => ({
  resolveGitCheckoutPath: () => "/synthetic/checkout",
}));

let record: ReliabilityOperationRecord;
let request: LifecycleWorkerRequest;
let output: LifecycleOutput;
let recorder: LifecycleDiagnosticRecorder;
const now = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-diagnostics-"));
  const identity = { repoPath: "/synthetic/checkout", workspace: null, provider: "devsy" as const };
  const state = createReliabilityState("environment", now, "manual");
  state.operation = {
    id: "operation",
    kind: "ensure",
    status: "RUNNING",
    drained: false,
    exitCode: null,
  };
  record = {
    version: 1,
    identity,
    revision: 1,
    state,
    effectSequence: 0,
    outcome: null,
    worker: { id: "worker", operationId: "operation", pid: 123, birth: "proc:123" },
  };
  fixture.read.mockReset().mockImplementation(() => structuredClone(record));
  request = {
    kind: "ensure",
    repoPath: identity.repoPath,
    identity,
    requestId: "request",
    operationId: "operation",
    workerId: "worker",
    fence: reliabilityFence(state),
    options: {},
  };
  output = new LifecycleOutput();
  recorder = new LifecycleDiagnosticRecorder(request, () => output.read());
});

afterEach(() => {
  recorder.close();
  vi.useRealTimers();
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

function append(value: string) {
  const bytes = Buffer.from(value);
  output.append("stderr", bytes);
  recorder.append("stderr", bytes);
}

describe("bounded lifecycle diagnostics", () => {
  it("projects actual split package output without exposing raw content in metadata", async () => {
    recorder.phase("provider");
    append("\u001b[32m@fixture/ut");
    append("il:build:\u001b[0m compiling\nprivate-output-value\n");
    await vi.advanceTimersByTimeAsync(250);
    const result = readLifecycleDiagnostics(request.identity)!;
    expect(result.metadata).toMatchObject({
      stage: "provider",
      buildPackage: "@fixture/util",
      liveness: "unknown",
      executionDeadlineAtMs: null,
      workerDrained: false,
    });
    expect(JSON.stringify(result.metadata)).not.toContain("private-output-value");
    expect(
      Buffer.concat(result.output.map((c) => Buffer.from(c.data, "base64"))).length,
    ).toBeGreaterThan(0);
    expect(fs.statSync(lifecycleDiagnosticsPath(request.identity)).mode & 0o077).toBe(0);
  });

  it("does not advance distinct-output progress on duplicate output or phase heartbeats", async () => {
    append("@fixture/util:build: compiling\n");
    await vi.advanceTimersByTimeAsync(250);
    vi.setSystemTime(now + 40_000);
    append("@fixture/util:build: compiling\n");
    append('{"type":"lifecycle-progress","phase":"provider"}\n');
    recorder.phase("provider");
    expect(readLifecycleDiagnostics(request.identity)?.metadata).toMatchObject({
      progressAgeMs: 40_000,
      liveness: "unknown",
      outputAgeMs: 0,
    });
  });

  it("bounds oversized output and retains the newest tail through cancellation", async () => {
    append("x".repeat(100_000));
    await vi.advanceTimersByTimeAsync(250);
    recorder.cancel();
    record.worker = null;
    record.state.operation!.status = "INTERRUPTED";
    record.state.operation!.drained = true;
    recorder.close();
    const result = readLifecycleDiagnostics(request.identity)!;
    expect(result.output.reduce((n, c) => n + Buffer.byteLength(c.data, "base64"), 0)).toBe(32_768);
    expect(result.metadata).toMatchObject({ cancellationRequested: true, workerDrained: true });
    expect(fs.statSync(lifecycleDiagnosticsPath(request.identity)).size).toBeLessThan(65_536);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["intent", "operation", "worker", "revision-race"])("rejects %s mismatch", (failure) => {
    if (failure === "intent") record.state.intentRevision++;
    if (failure === "operation") record.state.operation!.id = "other";
    if (failure === "worker") record.worker!.id = "other";
    if (failure === "revision-race")
      fixture.read
        .mockImplementationOnce(() => structuredClone(record))
        .mockImplementation(() => ({ ...structuredClone(record), revision: 2 }));
    expect(readLifecycleDiagnostics(request.identity)).toBeUndefined();
  });

  it.each(["symlink", "oversized", "public", "invalid"])("rejects unsafe %s files", (failure) => {
    const file = lifecycleDiagnosticsPath(request.identity);
    if (failure === "symlink") {
      const target = path.join(fixture.home, "other");
      fs.renameSync(file, target);
      fs.symlinkSync(target, file);
    }
    if (failure === "oversized") fs.writeFileSync(file, "x".repeat(65_537));
    if (failure === "public") fs.chmodSync(file, 0o644);
    if (failure === "invalid") fs.writeFileSync(file, "{}");
    expect(readLifecycleDiagnostics(request.identity)).toBeUndefined();
  });

  it("reports stale evidence and never infers liveness after a quiet hook", () => {
    recorder.phase("preparation");
    vi.setSystemTime(now + 30_000);
    expect(readLifecycleDiagnostics(request.identity)?.metadata).toMatchObject({
      evidence: "stale",
      progressAgeMs: null,
      buildPackage: null,
      liveness: "unknown",
    });
  });

  it("requires explicit logs access to emit bounded raw output without container exec", async () => {
    append("synthetic diagnostic\n");
    await vi.advanceTimersByTimeAsync(250);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await runLogsCommand({ repo: request.repoPath });
      expect(write).toHaveBeenCalledOnce();
      expect(Buffer.byteLength(String(write.mock.calls[0][0]))).toBeLessThanOrEqual(32_768);
      await expect(runLogsCommand({ repo: request.repoPath, follow: true })).rejects.toThrow();
      await expect(runLogsCommand({ repo: request.repoPath, tail: "10001" })).rejects.toThrow();
      record.state.intentRevision++;
      await expect(runLogsCommand({ repo: request.repoPath })).rejects.toThrow();
      expect(write).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    true,
    false,
  ])("tails complete final lines with a terminal newline: %s", async (terminated) => {
    const expected = `last-line${terminated ? "\n" : ""}`;
    append(`first-line\n${expected}`);
    await vi.advanceTimersByTimeAsync(250);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await runLogsCommand({ repo: request.repoPath, tail: "1" });
      expect(write).toHaveBeenCalledExactlyOnceWith(expected);
    } finally {
      write.mockRestore();
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { processBirthIdentity } from "../file-lock";
import { reliabilityFence } from "../reliability-contract";
import { stepReliability } from "../reliability-model";
import {
  type ReliabilityIdentity,
  readReliabilityOperation,
  updateReliabilityOperation,
} from "../reliability-operation-store";
import { settleWorkspaceJournal } from "../workspace-journal-settle";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../router", async (importOriginal) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "journal-settle-"));
  const actual = await importOriginal<typeof import("../router")>();
  return { ...actual, DEVROUTER_HOME: fixture.root };
});
vi.mock("../workspace", () => ({
  comparableWorkspacePath: (value: string) => value,
  isLinkedWorktree: () => false,
  readPersistedWorkspace: () => undefined,
  resolveWorktreeWorkspace: () => undefined,
  sameWorkspacePath: (left: string, right: string) => left === right,
  withWorkspaceLifecycleLock: async (_repoPath: string, operation: () => unknown) => operation(),
}));
vi.mock("../workspace-runtime", () => ({ resolveWorkspaceRuntimeOrDefault: () => "devsy" }));

const checkouts: string[] = [];
let identity: ReliabilityIdentity;
beforeEach(() => {
  identity = {
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "journal-settle-checkout-")),
    workspace: null,
    provider: "devsy",
  };
  checkouts.push(identity.repoPath);
});
afterAll(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  for (const checkout of checkouts) fs.rmSync(checkout, { recursive: true, force: true });
});

function seedRunningOperation(): string {
  updateReliabilityOperation(identity, (record) => {
    const stepSeed = (state: typeof record.state, event: Record<string, unknown>) =>
      stepReliability(
        state,
        { ...reliabilityFence(state), ...event } as Parameters<typeof stepReliability>[1],
        Date.now(),
      ).state;
    let state = record.state;
    const base = {
      type: "operation-request",
      kind: "ensure",
      key: "seed",
      operationId: "seed-op",
      profile: "manage",
      consumer: { id: "manual-cli", requiredCapabilities: [], pinned: false },
      runtimeRunning: false,
    } as const;
    state = stepSeed(state, base);
    state = stepSeed(state, { type: "dispatch" });
    state = stepSeed(state, { type: "dispatch-persisted", operationId: "seed-op" });
    state = stepSeed(state, { type: "launched", operationId: "seed-op" });
    record.state = state;
    return undefined;
  });
  return "seed-op";
}

describe("workspace journal settlement", () => {
  it("refuses when no journal exists", async () => {
    await expect(settleWorkspaceJournal(identity.repoPath)).rejects.toThrow(
      /No reliability journal/,
    );
  });

  it("settles a running operation whose worker is gone and reports the prior status", async () => {
    seedRunningOperation();
    const result = await settleWorkspaceJournal(identity.repoPath);
    expect(result).toMatchObject({
      status: "settled",
      priorStatus: "RUNNING",
      operationId: "seed-op",
      workspace: null,
    });
    const record = readReliabilityOperation(identity);
    expect(record?.state.operation).toMatchObject({ status: "INTERRUPTED", drained: true });
    expect(record?.state.phase).toBe("recovering");
  });

  it("joins when the operation is already settled", async () => {
    seedRunningOperation();
    await settleWorkspaceJournal(identity.repoPath);
    const again = await settleWorkspaceJournal(identity.repoPath);
    expect(again.status).toBe("already-settled");
  });

  it("refuses while a live worker outcome is observable", async () => {
    seedRunningOperation();
    updateReliabilityOperation(identity, (record) => {
      record.worker = {
        id: "worker",
        operationId: "seed-op",
        pid: process.pid,
        birth: processBirthIdentity(process.pid)!,
      };
      return undefined;
    });
    await expect(settleWorkspaceJournal(identity.repoPath)).rejects.toThrow(/still running/);
    expect(readReliabilityOperation(identity)?.state.operation?.status).toBe("RUNNING");
  });

  it("never settles a completed outcome into an interruption", async () => {
    seedRunningOperation();
    updateReliabilityOperation(identity, (record) => {
      record.state = stepReliability(
        record.state,
        { ...record.state, type: "completion", operationId: "seed-op", exitCode: 0 },
        Date.now(),
      ).state;
      record.state = stepReliability(
        record.state,
        { ...record.state, type: "drained", operationId: "seed-op" },
        Date.now(),
      ).state;
      return undefined;
    });
    const result = await settleWorkspaceJournal(identity.repoPath);
    expect(result.status).toBe("already-settled");
    expect(readReliabilityOperation(identity)?.state.operation?.status).toBe("COMPLETED");
  });
});

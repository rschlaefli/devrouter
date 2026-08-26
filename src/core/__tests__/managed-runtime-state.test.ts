import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type ManagedRuntimeState,
  managedRuntimeStatePath,
  markManagedRuntimeDegraded,
  readManagedRuntimeState,
  writeManagedRuntimeState,
} from "../managed-runtime-state";

const testHome = vi.hoisted(() => `/tmp/devrouter-managed-runtime-state-home-${process.pid}`);

vi.mock("../router", () => ({ DEVROUTER_HOME: testHome }));

const digest = "a".repeat(64);

function state(repoPath: string, workspace?: string): ManagedRuntimeState {
  return {
    version: 1,
    repoPath,
    ...(workspace !== undefined ? { workspace } : {}),
    devpodId: "devpod-a",
    composeProject: "project-a",
    profile: "ai,mcp",
    desired: {
      apps: ["chat"],
      services: ["litellm"],
      processes: ["local-mcp"],
    },
    sourceConfigSha256: digest,
    effectiveConfigSha256: "b".repeat(64),
    status: "ready",
    updatedAt: "2026-08-26T08:00:00.000Z",
  };
}

describe("managed runtime state", () => {
  const repoPath = "/repo/trees/feature";

  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.mkdirSync(testHome, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it("round-trips exact workspace identity and desired resources atomically", () => {
    const original = state(repoPath, "feature");

    expect(readManagedRuntimeState(repoPath, "feature")).toBeUndefined();
    writeManagedRuntimeState(original);

    expect(readManagedRuntimeState(repoPath, "feature")).toEqual(original);
    expect(managedRuntimeStatePath(repoPath, "feature")).not.toBe(
      managedRuntimeStatePath(repoPath, "other"),
    );
    expect(fs.readdirSync(path.dirname(managedRuntimeStatePath(repoPath, "feature")))).toEqual([
      expect.stringMatching(/\.json$/),
    ]);
  });

  it("keeps primary and linked state in separate exact records", () => {
    writeManagedRuntimeState(state(repoPath));
    writeManagedRuntimeState(state(repoPath, "feature"));

    expect(readManagedRuntimeState(repoPath)).toEqual(state(repoPath));
    expect(readManagedRuntimeState(repoPath, "feature")).toEqual(state(repoPath, "feature"));
  });

  it("marks a known state degraded without storing runtime values", () => {
    const original = state(repoPath, "feature");
    writeManagedRuntimeState(original);

    markManagedRuntimeDegraded(original, "route-publication");
    const degraded = readManagedRuntimeState(repoPath, "feature");

    expect(degraded).toMatchObject({
      ...original,
      status: "degraded",
      transitionPhase: "route-publication",
      updatedAt: expect.any(String),
    });
    expect(degraded?.updatedAt).not.toBe(original.updatedAt);
    expect(JSON.stringify(degraded)).not.toContain("OPENROUTER_API_KEY");
  });

  it("rejects corrupt, cross-workspace, and invalid resource state", () => {
    const statePath = managedRuntimeStatePath(repoPath, "feature");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    fs.writeFileSync(statePath, "not-json\n", "utf-8");
    expect(() => readManagedRuntimeState(repoPath, "feature")).toThrow(
      "Could not parse managed runtime state",
    );

    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...state(repoPath, "other"), workspace: "other" }),
      "utf-8",
    );
    expect(() => readManagedRuntimeState(repoPath, "feature")).toThrow(
      "belongs to a different exact workspace",
    );

    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...state(repoPath, "feature"), desired: { apps: ["chat", "chat"] } }),
      "utf-8",
    );
    expect(() => readManagedRuntimeState(repoPath, "feature")).toThrow(
      "invalid desired resource set",
    );
  });
});

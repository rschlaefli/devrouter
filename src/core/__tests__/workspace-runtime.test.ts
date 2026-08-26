import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

function result(status: number | null, stdout = "") {
  return { status, stdout, stderr: "" };
}

async function loadRuntime() {
  const mod = await import("../workspace-runtime");
  return mod.resolveWorkspaceRuntime;
}

async function loadRuntimeOrDefault() {
  const mod = await import("../workspace-runtime");
  return mod.resolveWorkspaceRuntimeOrDefault;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.DEVROUTER_WORKSPACE_RUNTIME;
});

afterEach(() => {
  delete process.env.DEVROUTER_WORKSPACE_RUNTIME;
  vi.resetModules();
});

describe("resolveWorkspaceRuntime", () => {
  it("rejects an unsupported explicit override", async () => {
    const resolve = await loadRuntime();
    expect(() => resolve("docker")).toThrow(/Unsupported workspace runtime/);
  });

  it("honors a supported explicit override without probing", async () => {
    const resolve = await loadRuntime();
    expect(resolve(" Devsy ")).toBe("devsy");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("honors DEVROUTER_WORKSPACE_RUNTIME", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "devsy";
    const resolve = await loadRuntime();
    expect(resolve()).toBe("devsy");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported DEVROUTER_WORKSPACE_RUNTIME", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "nix";
    const resolve = await loadRuntime();
    expect(() => resolve()).toThrow(/Unsupported DEVROUTER_WORKSPACE_RUNTIME/);
  });

  it("prefers devsy when only devsy is installed", async () => {
    spawnSyncMock.mockImplementation((command) =>
      command === "devsy" ? result(0, "v1.0.0") : result(1),
    );
    const resolve = await loadRuntime();
    expect(resolve()).toBe("devsy");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "devsy",
      ["--version"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("falls back to devpod when only devpod is installed", async () => {
    spawnSyncMock.mockImplementation((command) =>
      command === "devpod" ? result(0, "v0.7.0") : result(1),
    );
    const resolve = await loadRuntime();
    expect(resolve()).toBe("devpod");
  });

  it("throws guidance when no runtime is installed", async () => {
    spawnSyncMock.mockReturnValue(result(1));
    const resolve = await loadRuntime();
    expect(() => resolve()).toThrow(/No workspace runtime found/);
  });

  it("falls back to devpod for dispatch when nothing is installed", async () => {
    spawnSyncMock.mockReturnValue(result(1));
    const resolveOrDefault = await loadRuntimeOrDefault();
    expect(resolveOrDefault()).toBe("devpod");
  });

  it("still fails loudly on an unsupported env runtime via the dispatch helper", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "podman";
    const resolveOrDefault = await loadRuntimeOrDefault();
    expect(() => resolveOrDefault()).toThrow(/Unsupported DEVROUTER_WORKSPACE_RUNTIME/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
    },
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  };
});

function result(status: number | null, stdout = "") {
  return { status, stdout, stderr: "" };
}

/** Command-aware spawn mock: probes succeed, registry reads return bodies. */
function mockRegistries(options: {
  devsyInstalled?: boolean;
  devpodInstalled?: boolean;
  devsyWorkspaces?: unknown[];
  devpodWorkspaces?: unknown[];
  devsyRegistryStatus?: number;
  devpodRegistryStatus?: number;
}) {
  spawnSyncMock.mockImplementation((command: string, args: string[]) => {
    const probeArg = command === "devsy" ? "--version" : "version";
    if (args[0] === probeArg) {
      const installed = command === "devsy" ? options.devsyInstalled : options.devpodInstalled;
      return result(installed ? 0 : 1);
    }
    if (args[0] === "--version" || args[0] === "version") {
      return result(1);
    }
    if (command === "devsy" && args.includes("list")) {
      return result(
        options.devsyRegistryStatus ?? 0,
        JSON.stringify(options.devsyWorkspaces ?? []),
      );
    }
    if (command === "devpod" && args[0] === "list") {
      return result(
        options.devpodRegistryStatus ?? 0,
        JSON.stringify(options.devpodWorkspaces ?? []),
      );
    }
    return result(1);
  });
}

async function loadRuntime() {
  const mod = await import("../workspace-runtime");
  return mod.resolveWorkspaceRuntimeDetailed;
}

async function loadRuntimeOrDefault() {
  const mod = await import("../workspace-runtime");
  return mod.resolveWorkspaceRuntimeOrDefault;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.DEVROUTER_WORKSPACE_RUNTIME;
  readFileSyncMock.mockImplementation(() => {
    throw new Error("ENOENT");
  });
});

afterEach(() => {
  delete process.env.DEVROUTER_WORKSPACE_RUNTIME;
  vi.resetModules();
});

describe("resolveWorkspaceRuntimeDetailed", () => {
  it("rejects an unsupported explicit override", async () => {
    const resolve = await loadRuntime();
    expect(() => resolve(undefined, "docker")).toThrow(/Unsupported workspace runtime/);
  });

  it("honors a supported explicit override without probing", async () => {
    const resolve = await loadRuntime();
    expect(resolve(undefined, " Devsy ").runtime).toBe("devsy");
    expect(resolve(undefined, " Devsy ").source).toBe("override");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("honors DEVROUTER_WORKSPACE_RUNTIME", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "devsy";
    const resolve = await loadRuntime();
    expect(resolve().runtime).toBe("devsy");
    expect(resolve().source).toBe("env");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported DEVROUTER_WORKSPACE_RUNTIME", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "nix";
    const resolve = await loadRuntime();
    expect(() => resolve()).toThrow(/Unsupported workspace runtime 'nix'/);
  });

  it("prefers devsy when only devsy is installed", async () => {
    mockRegistries({ devsyInstalled: true });
    const resolve = await loadRuntime();
    expect(resolve().runtime).toBe("devsy");
    expect(resolve().source).toBe("auto-detect");
  });

  it("falls back to devpod when only devpod is installed", async () => {
    mockRegistries({ devpodInstalled: true });
    const resolve = await loadRuntime();
    expect(resolve().runtime).toBe("devpod");
    expect(resolve().source).toBe("auto-detect");
  });

  it("keeps the historical devpod order when both are installed and nothing else is known", async () => {
    mockRegistries({ devsyInstalled: true, devpodInstalled: true });
    const resolve = await loadRuntime();
    expect(resolve().runtime).toBe("devpod");
    expect(resolve().source).toBe("auto-detect");
  });

  it("falls back to devpod for dispatch when nothing is installed", async () => {
    spawnSyncMock.mockReturnValue(result(1));
    const resolveOrDefault = await loadRuntimeOrDefault();
    expect(resolveOrDefault()).toBe("devpod");
  });

  it("still fails loudly on an unsupported env runtime via the dispatch helper", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "podman";
    const resolveOrDefault = await loadRuntimeOrDefault();
    expect(() => resolveOrDefault()).toThrow(/Unsupported workspace runtime 'podman'/);
  });
});

describe("machine workspace-runtime preference", () => {
  it("uses the persisted preference before auto-detection", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devsy" }));
    mockRegistries({ devsyInstalled: true, devpodInstalled: true });
    const resolve = await loadRuntime();
    expect(resolve().runtime).toBe("devsy");
    expect(resolve().source).toBe("machine-config");
  });

  it("ignores an invalid persisted runtime and reports nothing configured", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "docker" }));
    mockRegistries({ devpodInstalled: true });
    const mod = await import("../workspace-runtime");
    expect(mod.readWorkspaceRuntimeConfig().runtime).toBeUndefined();
    expect(mod.inspectWorkspaceRuntimeConfig().problems[0]).toMatch(/runtime='docker'/);
    const resolve = mod.resolveWorkspaceRuntimeDetailed;
    expect(resolve().runtime).toBe("devpod");
    expect(resolve().source).toBe("auto-detect");
  });
});

describe("exact-path registry ownership", () => {
  it("resolves a devsy-owned path to devsy even with devpod installed and preferred", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devpod" }));
    mockRegistries({
      devsyInstalled: true,
      devpodInstalled: true,
      devsyWorkspaces: [{ id: "ws", source: { localFolder: "/repo/ws" } }],
      devpodWorkspaces: [{ id: "other", source: { localFolder: "/repo/other" } }],
    });
    const resolve = await loadRuntime();
    expect(resolve("/repo/ws").runtime).toBe("devsy");
    expect(resolve("/repo/ws").source).toBe("path-owner");
  });

  it("resolves a devpod-owned path to devpod even when devsy is the machine preference", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devsy" }));
    mockRegistries({
      devsyInstalled: true,
      devpodInstalled: true,
      devpodWorkspaces: [{ id: "feature", source: { localFolder: "/repo/feature" } }],
    });
    const resolve = await loadRuntime();
    expect(resolve("/repo/feature").runtime).toBe("devpod");
    expect(resolve("/repo/feature").source).toBe("path-owner");
  });

  it("detects DevPod through its version subcommand when the --version flag is unsupported", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devsy" }));
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === "devsy" && args[0] === "--version") return result(0);
      if (command === "devpod" && args[0] === "version") return result(0);
      if (command === "devpod" && args[0] === "--version") return result(1);
      if (command === "devpod" && args[0] === "list") {
        return result(
          0,
          JSON.stringify([{ id: "feature", source: { localFolder: "/repo/feature" } }]),
        );
      }
      if (command === "devsy" && args.includes("list")) return result(0, "[]");
      return result(1);
    });
    const resolve = await loadRuntime();

    expect(resolve("/repo/feature").runtime).toBe("devpod");
    expect(resolve("/repo/feature").source).toBe("path-owner");
  });

  it("falls back to the machine preference when neither registry owns the path", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devsy" }));
    mockRegistries({ devsyInstalled: true, devpodInstalled: true });
    const resolve = await loadRuntime();
    expect(resolve("/repo/fresh").runtime).toBe("devsy");
    expect(resolve("/repo/fresh").source).toBe("machine-config");
  });

  it("fails closed when both registries own the path", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devpod" }));
    mockRegistries({
      devsyInstalled: true,
      devpodInstalled: true,
      devsyWorkspaces: [{ id: "ws", source: { localFolder: "/repo/ws" } }],
      devpodWorkspaces: [{ id: "ws", source: { localFolder: "/repo/ws" } }],
    });
    const resolve = await loadRuntime();
    expect(() => resolve("/repo/ws")).toThrow(/Both DevPod and Devsy claim this checkout/);
  });

  it("fails closed when an installed runtime registry is unavailable", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devsy" }));
    mockRegistries({
      devsyInstalled: true,
      devpodInstalled: true,
      devsyRegistryStatus: 1,
      devpodWorkspaces: [],
    });
    const resolve = await loadRuntime();
    expect(() => resolve("/repo/fresh")).toThrow(/Devsy workspace registry is unavailable/i);
  });

  it("keeps per-path ownership decisive after a fallback resolved another path first", async () => {
    readFileSyncMock.mockImplementation(() => JSON.stringify({ runtime: "devpod" }));
    mockRegistries({
      devsyInstalled: true,
      devpodInstalled: true,
      devsyWorkspaces: [{ id: "ws", source: { localFolder: "/repo/ws" } }],
    });
    const resolve = await loadRuntime();

    expect(resolve("/repo/unowned").source).toBe("machine-config");
    expect(resolve("/repo/ws").runtime).toBe("devsy");
    expect(resolve("/repo/ws").source).toBe("path-owner");
    expect(resolve("/repo/unowned-again").source).toBe("machine-config");
  });

  it("skips registry probing when the env override is set", async () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "devsy";
    mockRegistries({ devsyInstalled: true, devpodInstalled: true });
    const resolve = await loadRuntime();
    expect(resolve("/repo/ws").source).toBe("env");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

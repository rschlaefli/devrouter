import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDevpodWorkspacesRaw } from "../devpod-registry";
import {
  inspectDevpodRuntimeStatus,
  inspectDevpodWorkspaceOwnership,
  listDevpodWorkspaces,
  listDevpodWorkspacesFromSnapshots,
} from "../devpod-workspaces";
import { resetWorkspaceRuntimeCaches } from "../workspace-runtime";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let previousWorkspaceRuntime: string | undefined;

beforeEach(() => {
  previousWorkspaceRuntime = process.env.DEVROUTER_WORKSPACE_RUNTIME;
  process.env.DEVROUTER_WORKSPACE_RUNTIME = "devpod";
  vi.clearAllMocks();
  resetWorkspaceRuntimeCaches();
});

afterEach(() => {
  if (previousWorkspaceRuntime === undefined) delete process.env.DEVROUTER_WORKSPACE_RUNTIME;
  else process.env.DEVROUTER_WORKSPACE_RUNTIME = previousWorkspaceRuntime;
});

describe("DevPod workspace adapter", () => {
  it("parses the provider list at one typed boundary", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify([{ id: "feature", source: { localFolder: "/repo/trees/feature" } }]),
      stderr: "",
    } as never);

    expect(listDevpodWorkspaces()).toEqual([
      { id: "feature", source: { localFolder: "/repo/trees/feature" } },
    ]);
    expect(spawnSync).toHaveBeenCalledWith("devpod", ["list", "--output", "json", "--skip-pro"], {
      encoding: "utf-8",
    });
  });

  it("preserves malformed Devsy activity in live and snapshot projections", () => {
    process.env.DEVROUTER_WORKSPACE_RUNTIME = "devsy";
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devsy" && argv[0] === "--version") {
        return { status: 0, stdout: "v1.16.2", stderr: "" } as never;
      }
      if (command === "devpod" && argv[0] === "version") {
        return { status: 1, stdout: "", stderr: "missing" } as never;
      }
      if (command === "devsy" && argv[0] === "workspace" && argv[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "feature",
              source: { localFolder: "/repo/trees/feature" },
              lastUsed: null,
            },
          ]),
          stderr: "",
        } as never;
      }
      return { status: 1, stdout: "", stderr: "unexpected" } as never;
    });

    expect(listDevpodWorkspaces("/repo/trees/feature")).toEqual([
      {
        id: "feature",
        source: { localFolder: "/repo/trees/feature" },
        lastUsedMalformed: true,
      },
    ]);
    resetWorkspaceRuntimeCaches();
    expect(listDevpodWorkspacesFromSnapshots("/repo/trees/feature")).toEqual([
      {
        id: "feature",
        source: { localFolder: "/repo/trees/feature" },
        lastUsedMalformed: true,
      },
    ]);
  });

  it("strictly classifies exact provider runtime state", () => {
    for (const [providerState, expected] of [
      ["Running", "running"],
      ["Stopped", "stopped"],
      ["Busy", "busy"],
      ["NotFound", "not-found"],
    ] as const) {
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ id: "feature", provider: "docker", state: providerState }),
        stderr: "",
      } as never);
      expect(inspectDevpodRuntimeStatus("feature")).toBe(expected);
    }
    for (const output of [
      '{"id":"other","state":"Stopped"}',
      '{"id":"feature","state":"Future"}',
      "invalid",
    ]) {
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: output, stderr: "" } as never);
      expect(inspectDevpodRuntimeStatus("feature")).toBe("unknown");
    }
  });

  it("uses a bounded exact runtime probe and fails closed on command errors", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ id: "feature", state: "NotFound" }),
        stderr: "",
      } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "unavailable" } as never);

    expect(inspectDevpodRuntimeStatus("feature")).toBe("not-found");
    expect(inspectDevpodRuntimeStatus("feature")).toBe("unknown");
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "devpod",
      ["status", "feature", "--output", "json", "--timeout", "5s"],
      { encoding: "utf-8" },
    );
  });

  it("classifies only one exact id and path pair as owned", () => {
    const exact = { id: "feature", source: { localFolder: "/repo/trees/feature" } };
    expect(inspectDevpodWorkspaceOwnership([exact], "feature", "/repo/trees/feature")).toEqual({
      status: "owned",
      workspace: exact,
    });
    expect(inspectDevpodWorkspaceOwnership([], "feature", "/repo/trees/feature")).toEqual({
      status: "absent",
    });
    expect(
      inspectDevpodWorkspaceOwnership(
        [exact, { ...exact, source: { localFolder: "/other/trees/feature" } }],
        "feature",
        "/repo/trees/feature",
      ),
    ).toMatchObject({ status: "conflict" });
  });
});

describe("optional competing DevPod executable", () => {
  it("accepts executable absence only when explicitly requested", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      stdout: null,
      stderr: null,
      error: Object.assign(new Error("missing executable"), { code: "ENOENT" }),
    } as never);
    expect(() => listDevpodWorkspacesRaw()).toThrow();
    expect(listDevpodWorkspacesRaw({ allowMissingExecutable: true })).toEqual([]);
  });
  it.each(["EACCES", "ETIMEDOUT", "EIO"])("rejects %s with optional enumeration", (code) => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("unavailable"), { code }),
    } as never);
    expect(() => listDevpodWorkspacesRaw({ allowMissingExecutable: true })).toThrow();
  });
  it.each([
    { status: 1, stdout: "", stderr: "registry unavailable" },
    { status: 0, stdout: "invalid", stderr: "" },
    { status: 0, stdout: "{}", stderr: "" },
    { status: 0, stdout: '[{"id":"other"}]', stderr: "" },
  ])("rejects failed or malformed registry output", (result) => {
    vi.mocked(spawnSync).mockReturnValue(result as never);
    expect(() => listDevpodWorkspacesRaw({ allowMissingExecutable: true })).toThrow();
  });
});

describe("local legacy registry when DevPod is uninstalled", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-registry-")));
    vi.stubEnv("DEVPOD_HOME", path.join(root, "devpod"));
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      error: Object.assign(new Error("uninstalled"), { code: "ENOENT" }),
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function read() {
    return listDevpodWorkspacesRaw({ readLocalWhenMissing: true });
  }
  function record(id = "other", source = { localFolder: "/unrelated" }, context = "default") {
    const directory = path.join(root, "devpod", "contexts", context, "workspaces", id);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "workspace.json");
    fs.writeFileSync(file, JSON.stringify({ id, source }));
    return file;
  }
  it("proves no legacy registry on a Devsy-only installation", () => {
    expect(read()).toEqual([]);
    expect(fs.existsSync(path.join(root, "devpod"))).toBe(false);
  });
  it("proves empty registries across every context", () => {
    for (const name of ["default", "second"])
      fs.mkdirSync(path.join(root, "devpod", "contexts", name, "workspaces"), { recursive: true });
    expect(read()).toEqual([]);
  });
  it("retains exact legacy ownership from a non-default context", () => {
    record("target", { localFolder: "/target" }, "second");
    expect(read()).toEqual([{ id: "target", source: { localFolder: "/target" } }]);
    expect(inspectDevpodWorkspaceOwnership(read(), "target", "/target").status).toBe("owned");
    expect(inspectDevpodWorkspaceOwnership(read(), "target", "/elsewhere").status).toBe("conflict");
    expect(inspectDevpodWorkspaceOwnership(read(), "elsewhere", "/target").status).toBe("conflict");
  });
  it("allows validated unrelated ownership without exposing other record fields", () => {
    const file = record();
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: "other",
        source: { localFolder: "/unrelated" },
        omitted: { value: "synthetic" },
      }),
    );
    expect(read()).toEqual([{ id: "other", source: { localFolder: "/unrelated" } }]);
    expect(inspectDevpodWorkspaceOwnership(read(), "target", "/target").status).toBe("absent");
  });
  it.each([
    "invalid-json",
    "wrong-id",
    "missing-source",
    "missing-file",
    "symlink",
  ])("refuses %s legacy evidence", (failure) => {
    const file = record();
    if (failure === "invalid-json") fs.writeFileSync(file, "{");
    if (failure === "wrong-id")
      fs.writeFileSync(
        file,
        JSON.stringify({ id: "another", source: { localFolder: "/unrelated" } }),
      );
    if (failure === "missing-source") fs.writeFileSync(file, JSON.stringify({ id: "other" }));
    if (failure === "missing-file" || failure === "symlink") fs.unlinkSync(file);
    if (failure === "symlink") fs.symlinkSync(path.join(root, "missing"), file);
    expect(read).toThrow();
  });
  it("refuses a linked registry root instead of interpreting it as absent", () => {
    fs.symlinkSync(path.join(root, "missing"), path.join(root, "devpod"));
    expect(read).toThrow();
  });
  it("does not fallback from an unreadable executable", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      error: Object.assign(new Error("denied"), { code: "EACCES" }),
    } as never);
    expect(read).toThrow();
  });
  it("recognizes nonlocal sources without inventing a local path", () => {
    const file = record();
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: "other",
        source: { gitRepository: "https://example.invalid/synthetic.git" },
      }),
    );
    expect(read()).toEqual([{ id: "other", source: { localFolder: "" } }]);
  });
  it.each([
    "relative-source",
    "unknown-source",
    "oversized",
    "directory-file",
    "changed-population",
  ])("refuses %s registry evidence", (failure) => {
    const file = record();
    if (failure === "relative-source")
      fs.writeFileSync(file, JSON.stringify({ id: "other", source: { localFolder: "relative" } }));
    if (failure === "unknown-source")
      fs.writeFileSync(file, JSON.stringify({ id: "other", source: {} }));
    if (failure === "oversized") fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1));
    if (failure === "directory-file") {
      fs.unlinkSync(file);
      fs.mkdirSync(file);
    }
    if (failure === "changed-population") {
      const original = fs.readdirSync.bind(fs);
      vi.spyOn(fs, "readdirSync").mockImplementation(((dir: string) => {
        const names = original(dir);
        if (dir.endsWith("/workspaces")) fs.mkdirSync(path.join(dir, "new"));
        return names;
      }) as typeof fs.readdirSync);
    }
    expect(read).toThrow();
  });
  it("refuses unreadable registry directories", () => {
    record();
    vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(read).toThrow();
  });
});

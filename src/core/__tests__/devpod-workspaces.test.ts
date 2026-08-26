import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectDevpodRuntimeStatus,
  inspectDevpodWorkspaceOwnership,
  listDevpodWorkspaces,
} from "../devpod-workspaces";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let previousWorkspaceRuntime: string | undefined;

beforeEach(() => {
  previousWorkspaceRuntime = process.env.DEVROUTER_WORKSPACE_RUNTIME;
  process.env.DEVROUTER_WORKSPACE_RUNTIME = "devpod";
  vi.clearAllMocks();
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

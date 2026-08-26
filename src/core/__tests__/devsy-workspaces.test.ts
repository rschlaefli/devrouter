import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectDevsyRuntimeStatus,
  inspectDevsyWorkspaceOwnership,
  listDevsyWorkspaces,
  selectDevsyWorkspace,
} from "../devsy-workspaces";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Devsy workspace adapter", () => {
  it("parses the provider list at one typed boundary", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { id: "feature", source: { localFolder: "/repo/trees/feature" } },
        {
          id: "legacy",
          source: { localFolder: "/repo/trees/legacy" },
          lastUsed: "2026-08-01T00:00:00Z",
        },
      ]),
      stderr: "",
    } as never);

    expect(listDevsyWorkspaces()).toEqual([
      { id: "feature", source: { localFolder: "/repo/trees/feature" } },
      {
        id: "legacy",
        source: { localFolder: "/repo/trees/legacy" },
        lastUsed: "2026-08-01T00:00:00Z",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledWith(
      "devsy",
      ["workspace", "list", "--result-format", "json"],
      { encoding: "utf-8" },
    );
  });

  it("fails closed on provider errors and malformed output", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "boom" } as never);
    expect(() => listDevsyWorkspaces()).toThrow(/devsy workspace list failed/);

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "not json",
      stderr: "",
    } as never);
    expect(() => listDevsyWorkspaces()).toThrow(/invalid JSON/);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "{}", stderr: "" } as never);
    expect(() => listDevsyWorkspaces()).toThrow(/unexpected response/);
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
      expect(inspectDevsyRuntimeStatus("feature")).toBe(expected);
    }
    for (const output of [
      '{"id":"other","state":"Stopped"}',
      '{"id":"feature","state":"Future"}',
      "invalid",
    ]) {
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: output, stderr: "" } as never);
      expect(inspectDevsyRuntimeStatus("feature")).toBe("unknown");
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

    expect(inspectDevsyRuntimeStatus("feature")).toBe("not-found");
    expect(inspectDevsyRuntimeStatus("feature")).toBe("unknown");
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "devsy",
      ["workspace", "status", "feature", "--result-format", "json"],
      { encoding: "utf-8", timeout: 10_000 },
    );
  });

  it("classifies only one exact id and path pair as owned", () => {
    const exact = { id: "feature", source: { localFolder: "/repo/trees/feature" } };
    expect(inspectDevsyWorkspaceOwnership([exact], "feature", "/repo/trees/feature")).toEqual({
      status: "owned",
      workspace: exact,
    });
    expect(inspectDevsyWorkspaceOwnership([], "feature", "/repo/trees/feature")).toEqual({
      status: "absent",
    });
    expect(
      inspectDevsyWorkspaceOwnership(
        [exact, { ...exact, source: { localFolder: "/other/trees/feature" } }],
        "feature",
        "/repo/trees/feature",
      ),
    ).toMatchObject({ status: "conflict" });
  });

  it("selects one exact-path workspace and rejects duplicates", () => {
    const exact = { id: "feature", source: { localFolder: "/repo/trees/feature" } };
    expect(selectDevsyWorkspace([exact], "/repo/trees/feature")).toEqual(exact);
    expect(selectDevsyWorkspace([], "/repo")).toBeUndefined();
    expect(() =>
      selectDevsyWorkspace([exact, { ...exact, id: "feature-2" }], "/repo/trees/feature"),
    ).toThrow(/Multiple Devsy workspaces/);
  });
});

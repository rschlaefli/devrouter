import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectDevpodWorkspaceOwnership,
  listDevpodWorkspaces,
  runDevpodWorkspaceAction,
} from "../devpod-workspaces";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
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

  it("uses argv-only provider mutation and delete idempotency", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);

    runDevpodWorkspaceAction("delete", "feature");

    expect(spawnSync).toHaveBeenCalledWith("devpod", ["delete", "feature", "--ignore-not-found"], {
      encoding: "utf-8",
    });
  });
});

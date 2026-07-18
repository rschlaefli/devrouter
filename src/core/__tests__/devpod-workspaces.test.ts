import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withDevpodMutationLockSync } from "../devpod-mutation";
import {
  inspectDevpodWorkspaceOwnership,
  listDevpodWorkspaces,
  mutateOwnedDevpodWorkspace,
} from "../devpod-workspaces";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../devpod-mutation", () => ({
  withDevpodMutationLockSync: vi.fn(
    (_activity: string, _target: string, operation: () => unknown) => operation(),
  ),
}));

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

  it("revalidates exact ownership inside the global lock before and after deletion", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        listCalls += 1;
        return {
          status: 0,
          stdout:
            listCalls === 1
              ? JSON.stringify([{ id: "feature", source: { localFolder: "/repo/trees/feature" } }])
              : "[]",
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(mutateOwnedDevpodWorkspace("delete", "feature", "/repo/trees/feature")).toMatchObject({
      status: "changed",
    });

    expect(withDevpodMutationLockSync).toHaveBeenCalledWith(
      "DevPod delete",
      "/repo/trees/feature",
      expect.any(Function),
    );
    expect(spawnSync).toHaveBeenCalledWith("devpod", ["delete", "feature", "--ignore-not-found"], {
      encoding: "utf-8",
    });
  });

  it("fails when the DevPod id is reassigned before post-delete proof", () => {
    let listCalls = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = (args as string[]) ?? [];
      if (command === "devpod" && argv[0] === "list") {
        listCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "feature",
              source: {
                localFolder: listCalls === 1 ? "/repo/trees/feature" : "/other/trees/feature",
              },
            },
          ]),
          stderr: "",
        } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    expect(() => mutateOwnedDevpodWorkspace("delete", "feature", "/repo/trees/feature")).toThrow(
      "do not have one exact owner",
    );
  });

  it("does not call the provider when the exact owner is absent", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "[]", stderr: "" } as never);

    expect(mutateOwnedDevpodWorkspace("stop", "feature", "/repo/trees/feature")).toEqual({
      status: "absent",
    });
    expect(spawnSync).not.toHaveBeenCalledWith("devpod", ["stop", "feature"], expect.anything());
  });
});

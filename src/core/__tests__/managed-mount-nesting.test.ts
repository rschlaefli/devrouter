import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  classifyManagedMountNesting,
  observeManagedMountNesting,
  parseMountinfoDestinations,
} from "../managed-mount-nesting";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const WORKSPACE = {
  Type: "bind",
  Source: "/Users/agent/Git/task/trees/affected",
  Destination: "/workspaces/affected",
};
const NODE_MODULES = {
  Type: "volume",
  Source: "task_node_modules",
  Destination: "/workspaces/affected/node_modules",
};

/** One `/proc/self/mountinfo` line with a placeholder separator block. */
function mountinfoLine(destination: string): string {
  return `36 35 0:32 / ${destination} rw,relatime - overlay overlay rw`;
}

describe("parseMountinfoDestinations", () => {
  it("decodes the escaped separators mountinfo uses", () => {
    const destinations = parseMountinfoDestinations(
      [mountinfoLine("/workspaces/with\\040space"), mountinfoLine("/workspaces/affected")].join(
        "\n",
      ),
    );
    expect(destinations).toEqual(["/workspaces/with space", "/workspaces/affected"]);
  });

  it("ignores lines that do not carry a mount point", () => {
    expect(parseMountinfoDestinations("not a mountinfo line\n\n")).toEqual([]);
  });
});

describe("classifyManagedMountNesting", () => {
  it("reports nothing to check when no configured mount is nested", () => {
    const observation = classifyManagedMountNesting(
      [WORKSPACE],
      ["/workspaces/affected"],
      "abc123",
    );
    expect(observation.status).toBe("not-applicable");
    expect(observation.unwound).toEqual([]);
  });

  it("confirms a nested mount the container still reports", () => {
    const observation = classifyManagedMountNesting(
      [WORKSPACE, NODE_MODULES],
      ["/workspaces/affected", "/workspaces/affected/node_modules"],
      "abc123",
    );
    expect(observation.status).toBe("effective");
    expect(observation.checked).toEqual(["/workspaces/affected/node_modules"]);
    expect(observation.container).toBe("abc123");
  });

  it("names the nested mount and the mount underneath it once unwound", () => {
    const observation = classifyManagedMountNesting(
      [WORKSPACE, NODE_MODULES],
      ["/workspaces/affected"],
      "abc123",
    );
    expect(observation.status).toBe("unwound");
    expect(observation.unwound).toEqual([
      {
        destination: "/workspaces/affected/node_modules",
        source: "task_node_modules",
        nestedWithin: "/workspaces/affected",
      },
    ]);
  });

  it("compares paths at a separator boundary and ignores trailing slashes", () => {
    const sibling = {
      Type: "volume",
      Source: "extra",
      Destination: "/workspaces/affected/node_modules-extra",
    };
    expect(classifyManagedMountNesting([NODE_MODULES, sibling], [], "abc123").status).toBe(
      "not-applicable",
    );
    const trailing = {
      Type: "volume",
      Source: "task_node_modules",
      Destination: "/workspaces/affected/node_modules/",
    };
    expect(
      classifyManagedMountNesting(
        [WORKSPACE, trailing],
        ["/workspaces/affected", "/workspaces/affected/node_modules"],
        "abc123",
      ).status,
    ).toBe("effective");
  });

  it("names the outermost configured mount when several contain the nested one", () => {
    const observation = classifyManagedMountNesting(
      [
        WORKSPACE,
        { Type: "bind", Source: "/host/affected", Destination: "/workspaces" },
        NODE_MODULES,
      ],
      [],
      "abc123",
    );
    expect(observation.unwound[0]?.nestedWithin).toBe("/workspaces");
  });

  it("keeps an unreadable mount table unverified instead of passing or failing", () => {
    const observation = classifyManagedMountNesting([WORKSPACE, NODE_MODULES], null, "abc123");
    expect(observation.status).toBe("unverified");
    expect(observation.checked).toEqual([]);
    expect(observation.unwound).toEqual([]);
    expect(observation.reason).toBeTruthy();
  });
});

describe("observeManagedMountNesting", () => {
  it("reports nothing to check without reading a container that nests no mount", () => {
    vi.mocked(spawnSync).mockClear();
    const observation = observeManagedMountNesting({ id: "abc123", mounts: [WORKSPACE] });
    expect(observation.status).toBe("not-applicable");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("reads the container's own mount table once a configured mount is nested", () => {
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: mountinfoLine("/workspaces/affected"),
      stderr: "",
    } as never);
    const observation = observeManagedMountNesting({
      id: "abc123",
      mounts: [WORKSPACE, NODE_MODULES],
    });
    expect(vi.mocked(spawnSync).mock.calls[0]?.slice(0, 2)).toEqual([
      "docker",
      ["exec", "abc123", "cat", "/proc/self/mountinfo"],
    ]);
    expect(observation.status).toBe("unwound");
  });

  it("reports a refused mount-table read as unverified rather than failing the caller", () => {
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValue({ status: 90, stdout: "", stderr: "" } as never);
    const observation = observeManagedMountNesting({
      id: "abc123",
      mounts: [WORKSPACE, NODE_MODULES],
    });
    expect(observation.status).toBe("unverified");
  });
});

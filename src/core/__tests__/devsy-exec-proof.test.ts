import { beforeEach, describe, expect, it, vi } from "vitest";
import * as environment from "../devpod-environment";
import { captureDevsyExecProof, revalidateDevsyExecProof } from "../devsy-exec-proof";
import * as registry from "../devsy-workspaces";

vi.mock("../devpod-environment", () => ({
  inspectManagedStopContainers: vi.fn(),
  inspectManagedStopDaemon: vi.fn(),
  inspectManagedStopRunnerId: vi.fn(),
  inspectWorkspaceContainers: vi.fn(),
  resolveManagedStopEndpoint: vi.fn(),
  supportsManagedStopBaseline: vi.fn(),
  workspaceAppContainers: vi.fn((containers) => containers),
}));
vi.mock("../devsy-workspaces", () => ({
  inspectDevsyRuntimeStatus: vi.fn(),
  inspectDevsyWorkspaceOwnership: vi.fn(),
  listDevsyWorkspaces: vi.fn(),
  selectDevsyWorkspace: vi.fn(),
}));
vi.mock("../workspace", () => ({
  comparableWorkspacePath: (value: string) => value,
  sameWorkspacePath: (a: string, b: string) => a === b,
}));
const workspace = {
  id: "fixture",
  uid: "0123456789abcdef",
  context: "default",
  source: { localFolder: "/fixture" },
};
const container = {
  id: "a".repeat(64),
  state: { Running: true },
  labels: { "com.docker.compose.project": "fixture" },
  networks: {},
  mounts: [{ Type: "bind", Source: "/fixture", Destination: "/workspace" }],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(registry.listDevsyWorkspaces).mockReturnValue([workspace]);
  vi.mocked(registry.selectDevsyWorkspace).mockReturnValue(workspace);
  vi.mocked(registry.inspectDevsyWorkspaceOwnership).mockReturnValue({
    status: "owned",
    workspace,
  });
  vi.mocked(registry.inspectDevsyRuntimeStatus).mockReturnValue("running");
  vi.mocked(environment.resolveManagedStopEndpoint).mockReturnValue("unix:///fixture.sock");
  vi.mocked(environment.supportsManagedStopBaseline).mockReturnValue(true);
  vi.mocked(environment.inspectManagedStopDaemon).mockReturnValue("daemon");
  vi.mocked(environment.inspectWorkspaceContainers).mockReturnValue([container]);
  vi.mocked(environment.inspectManagedStopContainers).mockReturnValue([container as never]);
  vi.mocked(environment.inspectManagedStopRunnerId).mockReturnValue(workspace.uid);
  vi.mocked(environment.workspaceAppContainers).mockImplementation((containers) => containers);
});
describe("retained exec identity", () => {
  it("retains provider, daemon, exact container and mount across independent observations", () => {
    const proof = captureDevsyExecProof("/fixture");
    expect(proof).toMatchObject({
      uid: workspace.uid,
      daemon: "daemon",
      containerId: container.id,
      workspacePath: "/workspace",
    });
    expect(() => revalidateDevsyExecProof("/fixture", proof)).not.toThrow();
  });
  it.each([
    "uid",
    "context",
    "daemon",
    "container",
    "mount",
  ])("rejects changed %s before launch", (field) => {
    const proof = captureDevsyExecProof("/fixture");
    if (field === "uid" || field === "context") {
      vi.mocked(registry.selectDevsyWorkspace).mockReturnValue({
        ...workspace,
        [field]: "changed",
      });
    } else if (field === "daemon")
      vi.mocked(environment.inspectManagedStopDaemon).mockReturnValue("other");
    else {
      const changed =
        field === "container"
          ? { ...container, id: "b".repeat(64) }
          : { ...container, mounts: [{ ...container.mounts[0], Destination: "/other" }] };
      vi.mocked(environment.inspectWorkspaceContainers).mockReturnValue([changed]);
      vi.mocked(environment.inspectManagedStopContainers).mockReturnValue([changed as never]);
    }
    expect(() => revalidateDevsyExecProof("/fixture", proof)).toThrow();
  });
  it("rejects ambiguous registration and nonrunning or ambiguous primaries", () => {
    vi.mocked(registry.inspectDevsyWorkspaceOwnership).mockReturnValue({
      status: "conflict",
      reason: "duplicate",
    });
    expect(() => captureDevsyExecProof("/fixture")).toThrow();
    vi.mocked(registry.inspectDevsyWorkspaceOwnership).mockReturnValue({
      status: "owned",
      workspace,
    });
    vi.mocked(registry.inspectDevsyRuntimeStatus).mockReturnValue("stopped");
    expect(() => captureDevsyExecProof("/fixture")).toThrow();
    vi.mocked(registry.inspectDevsyRuntimeStatus).mockReturnValue("running");
    vi.mocked(environment.inspectWorkspaceContainers).mockReturnValue([container, container]);
    expect(() => captureDevsyExecProof("/fixture")).toThrow();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { superviseLifecycle } from "../../core/reliability-lifecycle";
import type { WorkspaceEnsureResult } from "../../core/workspace-ensure";
import { runEnsureCommand } from "../ensure";
import { resolveGitCheckoutPath } from "../environment-path";

vi.mock("../../core/reliability-lifecycle", () => ({ superviseLifecycle: vi.fn() }));
vi.mock("../environment-path", () => ({ resolveGitCheckoutPath: vi.fn(() => "/repo") }));

function refusalResult(): WorkspaceEnsureResult {
  return {
    kind: "linked",
    repoPath: "/repo",
    workspace: "feature",
    profile: "full",
    devpodId: "feature",
    urls: [],
    recreated: false,
    tlsRefreshed: false,
    hostPortConflicts: [
      {
        service: "azurite",
        hostIp: "127.0.0.1",
        hostPort: 10003,
        protocol: "tcp",
        holderContainer: "default-fe-d0f0d-azurite-1",
        holderComposeProject: "default-fe-d0f0d",
        holderWorkspace: "feat-kb-capacity",
        remediation: "Stop the holding workspace with 'devrouter stop /repo/trees/kb-capacity'.",
      },
    ],
  };
}

function stdoutLines(): string[] {
  return vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  process.exitCode = undefined;
});

describe("runEnsureCommand host-port refusal output", () => {
  it("forwards replacement only as an explicit worker intent", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue(refusalResult());
    await runEnsureCommand({ replaceApp: true, json: true });
    expect(superviseLifecycle).toHaveBeenLastCalledWith(
      "ensure",
      "/repo",
      expect.objectContaining({ replaceApp: true }),
    );
    await runEnsureCommand({ json: true });
    expect(vi.mocked(superviseLifecycle).mock.calls.at(-1)?.[2]).not.toHaveProperty("replaceApp");
  });
  it("carries explicit fresh intent into supervised startup", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue(refusalResult());
    await runEnsureCommand({ json: true, profile: "web", initializeNew: true });
    expect(superviseLifecycle).toHaveBeenCalledWith(
      "ensure",
      "/repo",
      expect.objectContaining({
        initializeNew: true,
        profile: "web",
      }),
    );
  });

  it("prints a machine-readable refusal under --json and exits nonzero", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue(refusalResult());

    await runEnsureCommand({ json: true });

    expect(process.exitCode).toBe(1);
    const output = stdoutLines().join("");
    const parsed = JSON.parse(output) as { hostPortConflicts?: unknown[] };
    expect(parsed.hostPortConflicts).toHaveLength(1);
    expect(parsed.hostPortConflicts?.[0]).toMatchObject({
      holderContainer: "default-fe-d0f0d-azurite-1",
      hostPort: 10003,
    });
  });

  it("names the port, holder, and remediation in human output and exits nonzero", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue(refusalResult());

    await runEnsureCommand({});

    expect(process.exitCode).toBe(1);
    const output = stdoutLines().join("");
    expect(output).toContain("was not started");
    expect(output).toContain("127.0.0.1:10003/tcp");
    expect(output).toContain("'default-fe-d0f0d-azurite-1'");
    expect(output).toContain("workspace 'feat-kb-capacity'");
    expect(output).toContain("devrouter stop /repo/trees/kb-capacity");
    expect(resolveGitCheckoutPath).toHaveBeenCalledWith(undefined);
  });

  it("leaves the ready path unchanged when no conflicts exist", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue({
      kind: "linked",
      repoPath: "/repo",
      workspace: "feature",
      profile: "full",
      devpodId: "feature",
      urls: ["http://app.feature.localhost"],
      recreated: false,
      tlsRefreshed: false,
    });

    await runEnsureCommand({});

    expect(process.exitCode).toBeUndefined();
    expect(stdoutLines().join("")).toContain("is ready");
  });
});

describe("runEnsureCommand runtime variant forwarding", () => {
  function readyResult(): WorkspaceEnsureResult {
    return {
      kind: "primary",
      repoPath: "/repo",
      profile: "full",
      devpodId: "repo",
      urls: [],
      recreated: false,
      tlsRefreshed: false,
    };
  }

  it("forwards an explicit variant to lifecycle ensure", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue(readyResult());

    await runEnsureCommand({ variant: "ci" });

    expect(superviseLifecycle).toHaveBeenCalledWith(
      "ensure",
      "/repo",
      expect.objectContaining({ variant: "ci" }),
    );
  });

  it("leaves the variant absent when the flag is omitted", async () => {
    vi.mocked(superviseLifecycle).mockResolvedValue(readyResult());

    await runEnsureCommand({});

    expect(vi.mocked(superviseLifecycle).mock.calls.at(-1)?.[2]).not.toHaveProperty("variant");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { devpodExec } from "../../core/devpod-exec";
import { parseExecInvocation, runExecCommand } from "../exec";

vi.mock("../../core/devpod-exec", () => ({ devpodExec: vi.fn() }));
vi.mock("../../core/workspace-ownership", () => ({
  resolveGitTopLevel: vi.fn((repoPath: string) => repoPath),
}));

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("runExecCommand", () => {
  it("passes literal argv to the exact checkout and propagates exit status", async () => {
    vi.mocked(devpodExec).mockResolvedValue(23);

    await runExecCommand({ path: "/repo", command: ["node", "-e", "process.exit(23)"] });

    expect(devpodExec).toHaveBeenCalledWith("/repo", ["node", "-e", "process.exit(23)"]);
    expect(process.exitCode).toBe(23);
  });
});

describe("parseExecInvocation", () => {
  it("supports an omitted checkout path", () => {
    expect(parseExecInvocation(["--", "pnpm", "seed"])).toEqual({
      command: ["pnpm", "seed"],
    });
  });

  it("keeps every command argument after the separator literal", () => {
    expect(parseExecInvocation(["/repo", "--", "sh", "-lc", "echo $HOME; true"])).toEqual({
      path: "/repo",
      command: ["sh", "-lc", "echo $HOME; true"],
    });
  });

  it("keeps command-side flags, a second separator, and empty arguments", () => {
    expect(parseExecInvocation(["--", "tool", "--help", "--", ""])).toEqual({
      command: ["tool", "--help", "--", ""],
    });
  });

  it.each([
    { args: ["pnpm", "seed"] },
    { args: ["/one", "/two", "--", "pnpm"] },
    { args: ["/repo", "--"] },
  ])("rejects malformed invocation $args", ({ args }) => {
    expect(() => parseExecInvocation(args)).toThrow();
  });
});

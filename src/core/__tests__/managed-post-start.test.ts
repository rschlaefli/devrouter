import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ManagedPostStartPlan,
  resolveManagedPostStartPlan,
  runManagedPostStart,
} from "../managed-post-start";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const container = { id: "app-id", workspacePath: "/workspaces/repo" };
const runtimePlan: ManagedPostStartPlan = {
  kind: "runtime",
  adapterPath: ".devcontainer/post-start.sh",
};

describe("managed post-start", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-managed-post-start-"));
    fs.mkdirSync(path.join(tmpDir, ".devcontainer"), { recursive: true });
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function write(relativePath: string, content: string): void {
    fs.writeFileSync(path.join(tmpDir, relativePath), content, "utf-8");
  }

  function writeRuntimeAdapter(): void {
    write(
      ".devcontainer/post-start.sh",
      '#!/usr/bin/env bash\n# devrouter:managed devcontainer\n: "${DEVROUTER_PROCESS_HELPER:?}"\n',
    );
  }

  function writeLegacyAdapter(): void {
    write(
      ".devcontainer/post-start.sh",
      "#!/usr/bin/env bash\n# devrouter:managed devcontainer\ndevrouter-process ensure --name app --match app -- sleep infinity\n",
    );
  }

  function writeLegacyImageContract(): void {
    write(
      ".devcontainer/Dockerfile",
      "FROM node:24\nRUN npm pack @devrouter/cli && install devrouter-process /usr/local/bin\n",
    );
    write(
      ".devcontainer/devcontainer.json",
      '{"postStartCommand":"bash .devcontainer/post-start.sh"}\n',
    );
  }

  it("classifies absent and custom adapters as unmanaged", () => {
    expect(resolveManagedPostStartPlan(tmpDir)).toEqual({ kind: "unmanaged" });

    write(".devcontainer/post-start.sh", "#!/usr/bin/env bash\npnpm dev\n");
    expect(resolveManagedPostStartPlan(tmpDir)).toEqual({ kind: "unmanaged" });
  });

  it("does not follow a repository adapter symlink on the host", () => {
    const outside = path.join(tmpDir, "outside.sh");
    write("outside.sh", "# devrouter:managed devcontainer\nDEVROUTER_PROCESS_HELPER=x\n");
    fs.symlinkSync(outside, path.join(tmpDir, ".devcontainer", "post-start.sh"));

    expect(resolveManagedPostStartPlan(tmpDir)).toEqual({ kind: "unmanaged" });
  });

  it("temporarily preserves a legacy adapter with its legacy image hook", () => {
    writeLegacyAdapter();
    writeLegacyImageContract();

    expect(resolveManagedPostStartPlan(tmpDir)).toEqual({ kind: "legacy" });
  });

  it("selects runtime delivery for a new adapter even when the legacy image remains", () => {
    writeRuntimeAdapter();
    writeLegacyImageContract();

    expect(resolveManagedPostStartPlan(tmpDir)).toEqual(runtimePlan);
  });

  it("selects runtime delivery for the helper-free target state", () => {
    writeRuntimeAdapter();
    write(".devcontainer/Dockerfile", "FROM node:24\n");

    expect(resolveManagedPostStartPlan(tmpDir)).toEqual(runtimePlan);
  });

  it("rejects a legacy adapter paired with a helper-free image", () => {
    writeLegacyAdapter();
    write(".devcontainer/Dockerfile", "FROM node:24\n");

    expect(() => resolveManagedPostStartPlan(tmpDir)).toThrow(
      "Managed post-start must use DEVROUTER_PROCESS_HELPER",
    );
  });

  it("delivers the packaged helper before invoking the exact adapter", () => {
    runManagedPostStart({ plan: runtimePlan, container });

    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["exec", "-i", "app-id", "sh", "-c", expect.stringContaining("umask 077")],
      { input: expect.any(Buffer), encoding: "utf-8" },
    );
    const deliveryScript = vi.mocked(spawnSync).mock.calls[0]?.[1]?.[5];
    expect(deliveryScript).toContain("mktemp");
    expect(deliveryScript).toContain('-L "$runtime_root"');
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "exec",
        "--workdir",
        "/workspaces/repo",
        "--env",
        "DEVROUTER_PROCESS_HELPER=/tmp/devrouter/bin/devrouter-process",
        "app-id",
        "bash",
        ".devcontainer/post-start.sh",
      ],
      { stdio: "inherit" },
    );
  });

  it("does nothing for unmanaged and fully legacy contracts", () => {
    runManagedPostStart({ plan: { kind: "unmanaged" }, container });
    runManagedPostStart({ plan: { kind: "legacy" }, container });

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("stops before adapter invocation when helper delivery fails", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "delivery failed",
    } as never);

    expect(() => runManagedPostStart({ plan: runtimePlan, container })).toThrow(
      "Could not deliver the managed process helper: delivery failed",
    );
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("reports managed adapter failure after successful delivery", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "post-start failed" } as never);

    expect(() => runManagedPostStart({ plan: runtimePlan, container })).toThrow(
      "Managed post-start failed",
    );
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});

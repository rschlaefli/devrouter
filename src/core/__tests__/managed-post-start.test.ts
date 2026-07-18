import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const runtimeAdapter =
  '#!/usr/bin/env bash\n# devrouter:managed devcontainer\n: "${DEVROUTER_PROCESS_HELPER:?}"\n';
const runtimePlan: ManagedPostStartPlan = {
  kind: "runtime",
  adapterPath: ".devcontainer/post-start.sh",
  adapterSha256: createHash("sha256").update(runtimeAdapter).digest("hex"),
  adapterContents: Buffer.from(runtimeAdapter),
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
    write(".devcontainer/post-start.sh", runtimeAdapter);
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

  it("rejects devrouter-looking adapters without the managed marker", () => {
    write(
      ".devcontainer/post-start.sh",
      '#!/usr/bin/env bash\n: "${DEVROUTER_PROCESS_HELPER:?}"\n',
    );

    expect(() => resolveManagedPostStartPlan(tmpDir)).toThrow(
      "Devrouter-looking post-start adapter is missing",
    );
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

  it("changes the exact adapter fingerprint when its bytes change", () => {
    writeRuntimeAdapter();
    const before = resolveManagedPostStartPlan(tmpDir);
    write(".devcontainer/post-start.sh", `${runtimeAdapter}# changed\n`);
    const after = resolveManagedPostStartPlan(tmpDir);

    expect(before).toMatchObject({ kind: "runtime" });
    expect(after).toMatchObject({ kind: "runtime" });
    expect(after).not.toEqual(before);
  });

  it("rejects a legacy adapter paired with a helper-free image", () => {
    writeLegacyAdapter();
    write(".devcontainer/Dockerfile", "FROM node:24\n");

    expect(() => resolveManagedPostStartPlan(tmpDir)).toThrow(
      "Managed post-start must use DEVROUTER_PROCESS_HELPER",
    );
  });

  it("delivers the helper and captured adapter bytes before invoking the exact snapshot", () => {
    runManagedPostStart({ plan: runtimePlan, container });
    const runtimeAdapterPath = `/tmp/devrouter/bin/managed-post-start-${runtimePlan.adapterSha256}`;

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
      ["exec", "-i", "app-id", "sh", "-c", expect.stringContaining(runtimeAdapterPath)],
      { input: runtimePlan.adapterContents, encoding: "utf-8" },
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      3,
      "docker",
      [
        "exec",
        "--workdir",
        "/workspaces/repo",
        "--env",
        "DEVROUTER_PROCESS_HELPER=/tmp/devrouter/bin/devrouter-process",
        "--env",
        `DEVROUTER_PROCESS_ADAPTER_SHA256=${runtimePlan.adapterSha256}`,
        "app-id",
        "bash",
        "-c",
        expect.stringContaining("readonly DEVROUTER_PROCESS_HELPER"),
        ".devcontainer/post-start.sh",
        runtimeAdapterPath,
      ],
      { stdio: "inherit" },
    );
  });

  it("preserves the direct Bash adapter argument and unset-variable contract", async () => {
    runManagedPostStart({ plan: runtimePlan, container });
    const wrapper = vi.mocked(spawnSync).mock.calls[2]?.[1]?.[10];
    expect(wrapper).toContain('adapter_snapshot="$1"');
    expect(wrapper).toContain("shift");
    expect(wrapper).not.toContain("set -eu");

    const adapterSnapshot = path.join(tmpDir, "adapter-snapshot.sh");
    write("adapter-snapshot.sh", `printf '%s|%s|%s\\n' "$0" "$#" "\${OPTIONAL_VALUE-unset}"\n`);
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const result = actualChildProcess.spawnSync(
      "bash",
      ["-c", String(wrapper), ".devcontainer/post-start.sh", adapterSnapshot],
      {
        cwd: tmpDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          DEVROUTER_PROCESS_HELPER: "/tmp/devrouter/bin/devrouter-process",
          DEVROUTER_PROCESS_ADAPTER_SHA256: runtimePlan.adapterSha256,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(".devcontainer/post-start.sh|0|unset\n");
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
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "post-start failed" } as never);

    expect(() => runManagedPostStart({ plan: runtimePlan, container })).toThrow(
      "Managed post-start failed",
    );
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("stops before invocation when captured adapter delivery fails", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "adapter delivery failed" } as never);

    expect(() => runManagedPostStart({ plan: runtimePlan, container })).toThrow(
      "Could not deliver the managed post-start adapter: adapter delivery failed",
    );
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});

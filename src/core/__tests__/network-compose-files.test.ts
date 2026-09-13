import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_DEVCONTAINER_MARKER, type ManagedDevcontainerPlan } from "../devcontainer-profile";
import { inspectNetworkComposeFiles, prepareNetworkComposeFiles } from "../network-compose-files";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
  vi.clearAllMocks();
});
function fixture(): ManagedDevcontainerPlan {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "network-compose-test-"));
  roots.push(root);
  return {
    composeDirectory: root,
    composeFiles: [path.join(root, "compose.yml")],
    contents: `${MANAGED_DEVCONTAINER_MARKER}\n${JSON.stringify({ dockerComposeFile: ["compose.yml"], runServices: ["web"], remoteEnv: { WORKSPACE: "synthetic" } })}\n`,
    effectiveConfigSha256: "before",
  } as ManagedDevcontainerPlan;
}
describe("reserved network configuration files", () => {
  it("suppresses application values from malformed YAML diagnostics", () => {
    const plan = fixture();
    fs.writeFileSync(plan.composeFiles[0], "services: [synthetic-private-value\n");
    let error: unknown;
    try {
      inspectNetworkComposeFiles({
        plan,
        endpoint: "unix:///tmp/synthetic.sock",
        workspace: { token: "test", gitCommonDir: "/synthetic/git" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("synthetic-private-value");
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it("preserves native configuration and writes only the matching derived overlay", () => {
    const native = fixture();
    const before = native.contents;
    const prepared = prepareNetworkComposeFiles(native, "10.88.0.0/26");
    const file = prepared.plan.composeFiles[1];
    expect(fs.existsSync(file)).toBe(false);
    prepared.write();
    const effective = JSON.parse(prepared.plan.contents.split("\n").slice(1).join("\n"));
    expect(effective).toMatchObject({
      runServices: ["web"],
      remoteEnv: { WORKSPACE: "synthetic" },
    });
    expect(effective.dockerComposeFile).toEqual([
      "compose.yml",
      "docker-compose.devrouter-network.yml",
    ]);
    expect(native.contents).toBe(before);
    expect(prepareNetworkComposeFiles(native, "10.88.0.0/26").plan.effectiveConfigSha256).toBe(
      prepared.plan.effectiveConfigSha256,
    );
    expect(() => prepareNetworkComposeFiles(native, "10.88.0.64/26")).toThrow();
  });
  it("rejects unignored files and tampering between preparation and write", () => {
    const native = fixture();
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as never);
    expect(() => prepareNetworkComposeFiles(native, "10.88.0.0/26")).toThrow();
    const prepared = prepareNetworkComposeFiles(native, "10.88.0.0/26");
    const file = prepared.plan.composeFiles[1];
    fs.writeFileSync(file, "foreign");
    expect(prepared.write).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("foreign");
  });
});

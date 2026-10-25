import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePreviewInstallation, loadPreviewInstallation } from "../installation";
import { createPreviewPool, PreviewStateConflict, type PreviewStateStore } from "../state";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-installation-"));
  dirs.push(root);
  const config = "version: 1\napps: []\n";
  const manifest = `version: 1
aliases: {web: {resources: [web]}}
bindings: {apps: {}, dependencies: {}, services: {}, processes: {}}
resources:
  web:
    kind: service
    image: example/app@sha256:${"a".repeat(64)}
    ports: [{name: http, port: 8080, public: true}]
selection:
  rules: [{paths: ['src/**'], aliases: [web]}]
  ignorePaths: ['docs/**']
  controlPaths: []
  allowedUnions: []
`;
  fs.writeFileSync(path.join(root, "local.yml"), config);
  fs.writeFileSync(path.join(root, "preview.yml"), manifest);
  const ref = (file: string, bytes: string) => ({
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const policy = {
    version: 1,
    installationId: "test",
    state: {
      containerUrl: "https://example.blob.core.windows.net/previews",
      tokenEnv: "DEVROUTER_PREVIEW_STATE_TOKEN",
    },
    maxActive: 2,
    maxReservedCents: 1000,
    projects: [
      {
        key: "app",
        forge: {
          kind: "github",
          host: "github.com",
          apiUrl: "https://api.github.com/",
          repository: "example/app",
          projectId: "123",
          botId: "456",
          tokenEnv: "DEVROUTER_PREVIEW_GITHUB_TOKEN",
        },
        config: ref("local.yml", config),
        manifest: ref("preview.yml", manifest),
        northflank: {
          projectId: "test",
          tokenEnv: "DEVROUTER_PREVIEW_NORTHFLANK_TOKEN",
          graph: {
            namespace: "test",
            baseDomain: "preview.example.org",
            allowedNetworks: ["192.0.2.0/24"],
            resources: {
              web: {
                deploymentPlan: "nf-compute-10",
                readiness: { port: "http", path: "/health" },
              },
            },
          },
          qualification: {
            fixedDeadline: false,
            sameEnvironment: false,
            deletionFence: false,
            scopedRuntimeSecrets: false,
            restrictedIngress: false,
          },
          runtimeSecrets: {},
        },
        hourlyCents: { web: 1 },
        acceptance: { command: ["/bin/false"], environment: [] },
      },
    ],
  };
  const filename = path.join(root, "installation.json");
  const write = () => fs.writeFileSync(filename, JSON.stringify(policy));
  write();
  return { filename, policy, write, root };
}

describe("reviewed preview installation", () => {
  it("diagnoses an unqualified installation without requesting credentials or network", () => {
    const f = fixture();
    let calls = 0;
    const installed = loadPreviewInstallation(f.filename, {
      env: {},
      fetch: async () => {
        calls++;
        throw new Error("unexpected network");
      },
    });
    expect(installed.diagnostic.projects[0].qualified).toBe(false);
    expect(installed.diagnostic.projects[0].aliases).toEqual(["web"]);
    expect(calls).toBe(0);
  });
  it("rejects changed controls, escaping files and non-scoped credential mappings before effects", () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.root, "preview.yml"), "\n# drift\n");
    expect(() => loadPreviewInstallation(f.filename)).toThrow("fingerprint");
    f.policy.projects[0].manifest.file = "../outside.yml";
    f.write();
    expect(() => loadPreviewInstallation(f.filename)).toThrow();
    f.policy.state.tokenEnv = "GITHUB_TOKEN";
    f.write();
    expect(() => loadPreviewInstallation(f.filename)).toThrow("scoped");
  });
  it("never reinitializes an established or partially initialized pool", async () => {
    const rows = new Map<string, unknown>();
    const store: PreviewStateStore = {
      async read(key, decode) {
        const value = rows.get(key);
        return value ? { value: decode(structuredClone(value)), version: "1" } : null;
      },
      async compareAndSwap(key, expected, value) {
        if (expected !== null || rows.has(key)) throw new PreviewStateConflict();
        rows.set(key, structuredClone(value));
        return "1";
      },
    };
    await initializePreviewInstallation("test", store);
    expect(rows.get("installations/test/pool")).toEqual(createPreviewPool("test"));
    rows.delete("installations/test/pool");
    await expect(initializePreviewInstallation("test", store)).rejects.toThrow(
      "already initialized",
    );
    expect(rows.has("installations/test/pool")).toBe(false);
  });
});

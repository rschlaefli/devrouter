import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterConfig } from "../../types";
import {
  inspectManagedDevcontainerConfig,
  MANAGED_DEVCONTAINER_MARKER,
  MANAGED_DEVCONTAINER_PATH,
  prepareManagedDevcontainerConfig,
  startExactManagedServices,
} from "../devcontainer-profile";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";

let tmpDir: string;

const managedConfig: DevrouterConfig = {
  version: 1,
  managedRuntime: {
    devcontainer: {
      baseServices: ["postgres"],
      profileServices: ["redis", "litellm"],
    },
    processes: ["app"],
  },
  apps: [],
};

function write(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function setupRepo(): void {
  fs.mkdirSync(path.join(tmpDir, ".devcontainer"), { recursive: true });
  write(
    ".devcontainer/devcontainer.json",
    `{
  // Native mode intentionally remains all-on.
  "name": "fixture",
  "dockerComposeFile": [
    "docker-compose.yml",
    "\${localEnv:DEVCONTAINER_COMPOSE_OVERLAY:docker-compose.default.yml}"
  ],
  "service": "app",
  "runServices": ["app", "postgres", "redis", "litellm"],
  "forwardPorts": [3000, 4000],
}
`,
  );
  write(
    ".devcontainer/docker-compose.yml",
    `services:
  app:
    image: fixture
  postgres:
    image: postgres
  redis:
    image: redis
  litellm:
    image: fixture-litellm
`,
  );
  write(".devcontainer/docker-compose.default.yml", "services: {}\n");
  write(".gitignore", `${MANAGED_DEVCONTAINER_PATH}\n`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devcontainer-profile-"));
  setupRepo();
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("managed Dev Container config", () => {
  it("supports JSONC, preserves source fields, and selects services in the same directory", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });

    expect(plan.generatedRelativePath).toBe(MANAGED_DEVCONTAINER_PATH);
    expect(plan.desiredServices).toEqual(["app", "postgres", "litellm"]);
    expect(plan.composeFiles).toEqual([
      path.join(tmpDir, ".devcontainer/docker-compose.yml"),
      path.join(tmpDir, ".devcontainer/docker-compose.default.yml"),
    ]);
    expect(plan.contents.startsWith(`${MANAGED_DEVCONTAINER_MARKER}\n`)).toBe(true);
    expect(fs.existsSync(plan.generatedPath)).toBe(false);

    prepareManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    const generated = fs.readFileSync(plan.generatedPath, "utf-8");
    expect(generated).toContain(
      '"runServices": [\n    "app",\n    "postgres",\n    "litellm"\n  ]',
    );
    expect(fs.readFileSync(plan.sourcePath, "utf-8")).toContain('"forwardPorts": [3000, 4000]');
  });

  it("refuses an unowned generated-path collision", () => {
    write(MANAGED_DEVCONTAINER_PATH, "{}\n");
    expect(() =>
      inspectManagedDevcontainerConfig({
        repoPath: tmpDir,
        config: managedConfig,
        profile: { apps: [], devcontainerServices: ["litellm"] },
        linked: false,
      }),
    ).toThrow(/exists without the devrouter ownership marker/);
  });

  it("refuses an unclassified native service before writing the effective file", () => {
    const config = structuredClone(managedConfig);
    config.managedRuntime!.devcontainer.profileServices = ["redis"];
    expect(() =>
      inspectManagedDevcontainerConfig({
        repoPath: tmpDir,
        config,
        profile: { apps: [], devcontainerServices: ["redis"] },
        linked: false,
      }),
    ).toThrow(/does not classify native runServices: litellm/);
    expect(fs.existsSync(path.join(tmpDir, MANAGED_DEVCONTAINER_PATH))).toBe(false);
  });

  it("uses exact project and service arguments for warm additions without recreate", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);

    startExactManagedServices({
      plan,
      composeProject: "fixture",
      services: ["litellm"],
    });

    expect(spawnSync).toHaveBeenLastCalledWith(
      "docker",
      expect.arrayContaining([
        "compose",
        "--project-name",
        "fixture",
        "--project-directory",
        path.join(tmpDir, ".devcontainer"),
        "up",
        "-d",
        "--no-recreate",
        "--no-deps",
        "litellm",
      ]),
      expect.objectContaining({ cwd: path.join(tmpDir, ".devcontainer") }),
    );
  });
});

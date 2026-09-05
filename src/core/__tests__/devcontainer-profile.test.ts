import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterConfig } from "../../types";
import {
  assertManagedContainerConfigUnchanged,
  inspectManagedDevcontainerConfig,
  inspectManagedDevcontainerGeneratedConfig,
  MANAGED_DEVCONTAINER_MARKER,
  MANAGED_DEVCONTAINER_PATH,
  prepareManagedDevcontainerConfig,
  removeManagedDevcontainerConfig,
  startExactManagedServices,
} from "../devcontainer-profile";
import type { WorkspaceContainerSnapshot } from "../devpod-environment";

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
  "postCreateCommand": "bash .devcontainer/post-create.sh",
  "waitFor": "postCreateCommand",
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

function retainedContainer(
  plan: ReturnType<typeof inspectManagedDevcontainerConfig>,
  hash: string,
  service = plan.primaryService,
): WorkspaceContainerSnapshot {
  return {
    id: `${service}-id`,
    state: { Running: false },
    labels: {
      "com.docker.compose.project": "fixture",
      "com.docker.compose.service": service,
      "com.docker.compose.project.working_dir": plan.composeDirectory,
      "com.docker.compose.project.config_files": plan.composeFiles.join(","),
      "com.docker.compose.config-hash": hash,
    },
    mounts: [],
    networks: {},
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devcontainer-profile-"));
  setupRepo();
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: "app\npostgres\nredis\nlitellm\n",
    stderr: "",
  } as never);
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
    expect(generated).toContain('"waitFor": "postCreateCommand"');
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

  it("rejects a selected service outside the declared managed registry", () => {
    expect(() =>
      inspectManagedDevcontainerConfig({
        repoPath: tmpDir,
        config: managedConfig,
        profile: { apps: [], devcontainerServices: ["missing"] },
        linked: false,
      }),
    ).toThrow(/selects unregistered managed services: missing/);
  });

  it("validates services against the resolved Compose model", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "app\npostgres\nlitellm\n",
      stderr: "",
    } as never);

    expect(() =>
      inspectManagedDevcontainerConfig({
        repoPath: tmpDir,
        config: managedConfig,
        profile: { apps: [], devcontainerServices: ["redis"] },
        linked: false,
      }),
    ).toThrow(/devcontainer.runServices references unknown service 'redis'/);
  });

  it("removes only an ownership-marked generated config", () => {
    const plan = prepareManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });

    removeManagedDevcontainerConfig(plan);

    expect(fs.existsSync(plan.generatedPath)).toBe(false);
  });

  it("hashes the generated file and detects missing or changed content", () => {
    const plan = prepareManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });

    expect(inspectManagedDevcontainerGeneratedConfig(plan)).toMatchObject({
      status: "valid",
      sha256: plan.effectiveConfigSha256,
    });

    fs.writeFileSync(plan.generatedPath, `${MANAGED_DEVCONTAINER_MARKER}\n{}\n`, "utf-8");
    expect(inspectManagedDevcontainerGeneratedConfig(plan)).toMatchObject({
      status: "drifted",
      sha256: expect.any(String),
    });

    fs.unlinkSync(plan.generatedPath);
    expect(inspectManagedDevcontainerGeneratedConfig(plan)).toEqual({ status: "missing" });
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
      expect.objectContaining({
        cwd: path.join(tmpDir, ".devcontainer"),
        env: expect.not.objectContaining({
          WORKSPACE: expect.anything(),
          DEVROUTER_WORKSPACE: expect.anything(),
          DEVROUTER_GIT_COMMON_DIR: expect.anything(),
          DEVCONTAINER_COMPOSE_OVERLAY: expect.anything(),
        }),
      }),
    );

    startExactManagedServices({
      plan,
      composeProject: "fixture",
      services: ["litellm"],
      workspace: { token: "feature", gitCommonDir: "/repos/sample.git" },
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
      expect.objectContaining({
        cwd: path.join(tmpDir, ".devcontainer"),
        env: expect.objectContaining({
          WORKSPACE: "feature",
          DEVROUTER_WORKSPACE: "feature",
          DEVROUTER_GIT_COMMON_DIR: "/repos/sample.git",
          DEVCONTAINER_COMPOSE_OVERLAY: "docker-compose.devrouter.yml",
        }),
      }),
    );
  });

  it("hashes the resolved model through stdin without reinterpolating environment values", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    const hash = "a".repeat(64);
    const rendered = JSON.stringify({
      services: { app: { environment: { EXAMPLE: "test-$VALUE" } } },
    });
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: rendered } as never);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: `app ${hash}\n`,
      stderr: "compose diagnostics must stay suppressed",
    } as never);

    assertManagedContainerConfigUnchanged({
      plan,
      containers: [retainedContainer(plan, hash)],
      workspace: { token: "feature", gitCommonDir: "/repos/sample.git" },
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "docker",
      [
        "compose",
        "--project-name",
        "fixture",
        "--project-directory",
        plan.composeDirectory,
        ...plan.composeFiles.flatMap((file) => ["-f", file]),
        "config",
        "--format",
        "json",
      ],
      expect.objectContaining({
        cwd: plan.composeDirectory,
        encoding: "utf-8",
        env: expect.objectContaining({
          WORKSPACE: "feature",
          DEVROUTER_WORKSPACE: "feature",
          DEVROUTER_GIT_COMMON_DIR: "/repos/sample.git",
          DEVCONTAINER_COMPOSE_OVERLAY: "docker-compose.devrouter.yml",
        }),
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }),
    );
    expect(spawnSync).toHaveBeenLastCalledWith(
      "docker",
      [
        "compose",
        "--project-name",
        "fixture",
        "--project-directory",
        plan.composeDirectory,
        "-f",
        "-",
        "config",
        "--no-interpolate",
        "--hash",
        "app",
      ],
      expect.objectContaining({
        input: rendered,
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }),
    );
    expect(fs.existsSync(plan.generatedPath)).toBe(false);
  });

  it("rejects a missing Compose hash label before invoking Docker", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    const container = retainedContainer(plan, "a".repeat(64));
    delete container.labels["com.docker.compose.config-hash"];
    vi.mocked(spawnSync).mockClear();

    expect(() => assertManagedContainerConfigUnchanged({ plan, containers: [container] })).toThrow(
      "missing valid Compose identity and hash labels",
    );
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.generatedPath)).toBe(false);
  });

  it("rejects a recorded Compose model that omits a planned file", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    const container = retainedContainer(plan, "a".repeat(64));
    container.labels["com.docker.compose.project.config_files"] = plan.composeFiles[0];
    vi.mocked(spawnSync).mockClear();

    expect(() => assertManagedContainerConfigUnchanged({ plan, containers: [container] })).toThrow(
      "do not include the managed plan files",
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects an unreadable recorded Compose file without exposing command output", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    const container = retainedContainer(plan, "a".repeat(64));
    const missingFile = path.join(tmpDir, ".devcontainer/missing-compose.yml");
    container.labels["com.docker.compose.project.config_files"] = [
      ...plan.composeFiles,
      missingFile,
    ].join(",");
    vi.mocked(spawnSync).mockClear();

    let error: unknown;
    try {
      assertManagedContainerConfigUnchanged({ plan, containers: [container] });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Managed container Compose configuration contains an unreadable file.",
    );
    expect((error as Error).message).not.toContain(missingFile);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects a mismatched service hash and suppresses Compose stderr", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    const expectedHash = "a".repeat(64);
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: '{"services":{"app":{}}}',
    } as never);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: `app ${"b".repeat(64)}\n`,
      stderr: "secret command stderr",
    } as never);

    let error: unknown;
    try {
      assertManagedContainerConfigUnchanged({
        plan,
        containers: [retainedContainer(plan, expectedHash)],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Managed Compose configuration changed for service 'app'.",
    );
    expect((error as Error).message).not.toContain("secret command stderr");
    const [, args, spawnOptions] = vi.mocked(spawnSync).mock.calls[0];
    expect(args).not.toContain("up");
    expect(args).not.toContain("stop");
    expect(spawnOptions).toEqual(expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }));
    expect(fs.existsSync(plan.generatedPath)).toBe(false);
  });

  it.each([
    { status: 1, stdout: "sensitive-rendered-value" },
    { status: 0, stdout: "" },
    { status: 0, stdout: "sensitive-rendered-value", error: new Error("sensitive-error") },
  ])("rejects failed or incomplete rendering before hashing without exposing output", (rendered) => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValueOnce(rendered as never);
    expect(() =>
      assertManagedContainerConfigUnchanged({
        plan,
        containers: [retainedContainer(plan, "a".repeat(64))],
      }),
    ).toThrow("Could not verify managed Compose configuration for service 'app'.");
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});

import { createHash } from "node:crypto";
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
  vi.unstubAllEnvs();
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

  it("undoes Compose dollar escaping before hashing without expanding literal variables", () => {
    const plan = inspectManagedDevcontainerConfig({
      repoPath: tmpDir,
      config: managedConfig,
      profile: { apps: [], devcontainerServices: ["litellm"] },
      linked: false,
    });
    const hash = "a".repeat(64);
    const model = {
      services: {
        app: {
          entrypoint: ["sh", "-c", 'exec "$@"; echo $$'],
          command: ["echo", "$VALUE", "${VALUE}"],
          environment: { EXAMPLE: "literal-$$-${VALUE}" },
          labels: { literal$key: "literal$value" },
        },
      },
    };
    const resolved = JSON.stringify(model);
    // Compose config escapes every dollar in the serialized document, including keys.
    const rendered = resolved.split("$").join("$$");
    vi.stubEnv("VALUE", "must-not-be-expanded");
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: rendered } as never);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: `app ${hash}\n` } as never);

    assertManagedContainerConfigUnchanged({
      plan,
      containers: [retainedContainer(plan, hash)],
    });

    const [, args, options] = vi.mocked(spawnSync).mock.calls[1];
    expect(args).toContain("--no-interpolate");
    expect(options).toEqual(expect.objectContaining({ input: resolved }));
    expect(options?.input).not.toContain("must-not-be-expanded");
    expect(fs.existsSync(plan.generatedPath)).toBe(false);
  });

  describe("resolved service network namespaces", () => {
    function fixture() {
      const plan = inspectManagedDevcontainerConfig({
        repoPath: tmpDir,
        config: managedConfig,
        linked: false,
      });
      const primaryId = "1".repeat(64);
      const sharingId = "2".repeat(64);
      const model = {
        services: {
          app: { image: "fixture", environment: { LITERAL: "$VALUE" } },
          postgres: { image: "fixture-db", network_mode: "service:app" },
        },
      };
      const hash = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const primary = retainedContainer(plan, hash(model.services.app));
      primary.id = primaryId;
      primary.mounts = [{ Type: "bind", Source: tmpDir, Destination: "/workspace" }];
      const sharing = retainedContainer(
        plan,
        hash({ ...model.services.postgres, network_mode: `container:${primaryId}` }),
        "postgres",
      );
      sharing.id = sharingId;
      const containers = [primary, sharing];
      const inspected = [
        { id: sharingId, networkMode: `container:${primaryId}` },
        { id: primaryId, networkMode: "fixture_default" },
      ];
      let inspections = 0;
      const inspectionResult = vi.fn((stdout: string) => ({ status: 0, stdout, stderr: "" }));
      const changeInspection = vi.fn((rows: typeof inspected, _count: number) => rows);
      vi.mocked(spawnSync).mockClear();
      vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
        if (args?.includes("inspect")) {
          return inspectionResult(
            changeInspection(inspected, ++inspections)
              .map((row) => JSON.stringify(row))
              .join("\n"),
          ) as never;
        }
        if (args?.includes("--hash")) {
          const input = JSON.parse(String(options?.input));
          const service = args.at(-1) as string;
          return { status: 0, stdout: `${service} ${hash(input.services[service])}\n` } as never;
        }
        return { status: 0, stdout: JSON.stringify(model).replaceAll("$", "$$") } as never;
      });
      return {
        plan,
        model,
        containers,
        primary,
        sharing,
        inspected,
        changeInspection,
        inspectionResult,
      };
    }

    it("accepts only the exact owned namespace while hashing every other field unchanged", () => {
      const { plan, model, containers, primary } = fixture();
      const source = fs.readFileSync(plan.composeFiles[0]);
      vi.stubEnv("DOCKER_CONTEXT", "foreign-context");
      const endpoint = "unix:///synthetic/owned.sock";
      assertManagedContainerConfigUnchanged({ plan, containers, endpoint });
      const inspections = vi
        .mocked(spawnSync)
        .mock.calls.filter(([, args]) => args?.includes("inspect"));
      expect(inspections).toHaveLength(2);
      for (const [, args, options] of inspections) {
        expect(args?.slice(-2)).toEqual([containers[1].id, primary.id]);
        expect(options).toEqual(
          expect.objectContaining({
            env: expect.objectContaining({ DOCKER_HOST: endpoint }),
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          }),
        );
        expect(options?.env?.DOCKER_CONTEXT).toBeUndefined();
      }
      const hashes = vi.mocked(spawnSync).mock.calls.filter(([, args]) => args?.includes("--hash"));
      expect(JSON.parse(String(hashes.at(-1)?.[2]?.input))).toEqual({
        ...model,
        services: {
          ...model.services,
          postgres: { ...model.services.postgres, network_mode: `container:${primary.id}` },
        },
      });
      expect(fs.readFileSync(plan.composeFiles[0])).toEqual(source);
      expect(
        vi
          .mocked(spawnSync)
          .mock.calls.some(([, args]) =>
            args?.some((arg) => ["up", "stop", "rm"].includes(String(arg))),
          ),
      ).toBe(false);
    });

    it("preserves an already matching unresolved hash without namespace fallback", () => {
      const { plan, model, containers, sharing } = fixture();
      sharing.labels["com.docker.compose.config-hash"] = createHash("sha256")
        .update(JSON.stringify(model.services.postgres))
        .digest("hex");
      assertManagedContainerConfigUnchanged({ plan, containers });
      expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.includes("inspect"))).toBe(
        false,
      );
    });

    it.each([
      "missing",
      "duplicate",
      "foreign-project",
      "foreign-path",
      "foreign-files",
      "foreign-mount",
      "short-id",
    ])("refuses a %s target instead of adopting project labels", (kind) => {
      const { plan, containers, primary } = fixture();
      if (kind === "missing") containers.shift();
      if (kind === "duplicate") containers.push({ ...primary, id: "3".repeat(64) });
      if (kind === "foreign-project") primary.labels["com.docker.compose.project"] = "foreign";
      if (kind === "foreign-path")
        primary.labels["com.docker.compose.project.working_dir"] = "/foreign/.devcontainer";
      if (kind === "foreign-files")
        primary.labels["com.docker.compose.project.config_files"] = plan.composeFiles[0];
      if (kind === "foreign-mount") primary.mounts[0].Source = "/foreign";
      if (kind === "short-id") primary.id = primary.id.slice(0, 12);
      expect(() => assertManagedContainerConfigUnchanged({ plan, containers })).toThrow();
    });

    it.each([
      "missing",
      "foreign-id",
      "duplicate",
      "wrong-namespace",
      "raced-target",
      "raced-namespace",
      "malformed",
    ])("refuses %s live namespace evidence", (kind) => {
      const { plan, containers, changeInspection } = fixture();
      changeInspection.mockImplementation((rows, count) => {
        if (kind === "missing") return rows.slice(0, 1);
        if (kind === "foreign-id" || (kind === "raced-target" && count > 1))
          return [rows[0], { ...rows[1], id: "3".repeat(64) }];
        if (kind === "duplicate") return [rows[0], rows[0]];
        if (kind === "wrong-namespace" || (kind === "raced-namespace" && count > 1))
          return [{ ...rows[0], networkMode: `container:${"3".repeat(64)}` }, rows[1]];
        if (kind === "malformed") return [{ id: rows[0].id } as (typeof rows)[number], rows[1]];
        return rows;
      });
      expect(() => assertManagedContainerConfigUnchanged({ plan, containers })).toThrow();
    });

    it.each([
      { status: 1, stdout: "", stderr: "fixture-sensitive-error" },
      { status: 0, stdout: "fixture-invalid-json", stderr: "fixture-sensitive-error" },
    ])("suppresses failed or malformed namespace inspection output", (result) => {
      const { plan, containers, inspectionResult } = fixture();
      inspectionResult.mockReturnValue(result);
      expect(() => assertManagedContainerConfigUnchanged({ plan, containers })).toThrow(Error);
      expect(inspectionResult).toHaveBeenCalledTimes(1);
    });

    it("still refuses genuine non-namespace configuration drift", () => {
      const { plan, model, containers } = fixture();
      model.services.postgres.image = "changed-image";
      expect(() => assertManagedContainerConfigUnchanged({ plan, containers })).toThrow(Error);
      expect(
        vi.mocked(spawnSync).mock.calls.filter(([, args]) => args?.includes("inspect")),
      ).toHaveLength(2);
    });
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevrouterConfig } from "../../types";
import { buildDevcontainerChecks } from "../devcontainer-diagnostics";
import { inspectManagedDevcontainerConfig } from "../devcontainer-profile";
import { detectHostPortClaimConflicts } from "../host-port-claims";
import { loadRuntimeConfig } from "../repo-config";
import { isLinkedWorktree } from "../workspace";
import { resolveGitCommonDir } from "../workspace-ownership";

vi.mock("../repo-config", () => ({ loadRuntimeConfig: vi.fn() }));
vi.mock("../devcontainer-profile", () => ({ inspectManagedDevcontainerConfig: vi.fn() }));
vi.mock("../host-port-claims", () => ({ detectHostPortClaimConflicts: vi.fn(() => []) }));
vi.mock("../workspace", async (importOriginal) => ({
  ...(await importOriginal()),
  isLinkedWorktree: vi.fn(() => false),
}));
vi.mock("../workspace-ownership", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGitCommonDir: vi.fn(() => "/tmp/host-port-claims-doctor/common"),
}));

let tmpDir: string;

function writeCompose(
  options: { aliases?: string[]; external?: boolean; ports?: string } = {},
): void {
  const aliases = options.aliases ?? ["${WORKSPACE:-sample}-app"];
  const external = options.external ?? true;
  const ports = options.ports ? `    ports:\n      - ${options.ports}\n` : "";
  const composePath = path.join(tmpDir, ".devcontainer", "docker-compose.yml");
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(
    composePath,
    `services:
  app:
${ports}    networks:
      devnet:
        aliases:
${aliases.map((alias) => `          - ${alias}`).join("\n")}
networks:
  devnet:
    external: ${String(external)}
`,
    "utf-8",
  );
}

function writeDockerfile(content: string): void {
  const dockerfilePath = path.join(tmpDir, ".devcontainer", "Dockerfile");
  fs.mkdirSync(path.dirname(dockerfilePath), { recursive: true });
  fs.writeFileSync(dockerfilePath, content, "utf-8");
}

function writePostStart(content: string): void {
  const adapterPath = path.join(tmpDir, ".devcontainer", "post-start.sh");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, content, "utf-8");
}

function writeDevcontainer(content: string): void {
  const sourcePath = path.join(tmpDir, ".devcontainer", "devcontainer.json");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, content, "utf-8");
}

function config(upstream: string): DevrouterConfig {
  return {
    version: 1,
    apps: [
      {
        name: "app",
        host: "sample.localhost",
        protocol: "http",
        runtime: "proxy",
        dependencies: [],
        upstream,
      },
    ],
  };
}

function managedConfig(): DevrouterConfig {
  return {
    version: 1,
    managedRuntime: {
      devcontainer: { baseServices: ["postgres"], profileServices: ["redis"] },
      processes: ["app"],
    },
    apps: [],
  };
}

function checkLevel(
  checks: ReturnType<typeof buildDevcontainerChecks>,
  id: string,
): string | undefined {
  return checks.find((check) => check.id === id)?.level;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devcontainer-diagnostics-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildDevcontainerChecks", () => {
  it("matches defaulted workspace aliases to concrete default upstreams", () => {
    writeCompose();

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.upstream-alias-match")).toBe("ok");
  });

  it("matches defaulted workspace aliases to active workspace upstreams", () => {
    writeCompose();

    const checks = buildDevcontainerChecks(tmpDir, config("feature-x-app:3000"), "feature-x");

    expect(checkLevel(checks, "repo.devcontainer.upstream-alias-match")).toBe("ok");
  });

  it("warns when top-level devnet is not external", () => {
    writeCompose({ external: false });

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.aliases")).toBe("warn");
  });

  it("errors on published host ports including long syntax", () => {
    writeCompose({ ports: "{ target: 3000, published: 3000 }" });

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.no-published-ports")).toBe("error");
  });

  it("accepts a consumer image without devrouter artifacts", () => {
    writeCompose();
    writeDockerfile("FROM node:24-bookworm-slim\nRUN apt-get install -y procps util-linux\n");

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.no-devrouter-image-install")).toBe("ok");
  });

  it("warns instead of claiming clean evidence when the Dockerfile is absent", () => {
    writeCompose();

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.no-devrouter-image-install")).toBe("warn");
  });

  it("rejects a consumer image that installs or extracts devrouter artifacts", () => {
    writeCompose();
    writeDockerfile(
      "FROM node:24-bookworm-slim\nRUN npm pack @devrouter/cli && install devrouter-process /usr/local/bin\n",
    );

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.no-devrouter-image-install")).toBe("error");
  });

  it("warns when proxy upstreams do not match aliases", () => {
    writeCompose();

    const checks = buildDevcontainerChecks(tmpDir, config("other-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.upstream-alias-match")).toBe("warn");
  });

  it("keeps a truly custom post-start adapter unmanaged", () => {
    writeCompose();
    writePostStart("#!/usr/bin/env bash\npnpm dev\n");

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.managed-post-start")).toBe("ok");
  });

  it("errors on marker-free devrouter lifecycle wiring", () => {
    writeCompose();
    writePostStart('#!/usr/bin/env bash\n: "${DEVROUTER_PROCESS_HELPER:?}"\n');

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.managed-post-start")).toBe("error");
  });

  it("errors when managed post-start can outrun post-create", () => {
    writeCompose();
    writePostStart(
      '#!/usr/bin/env bash\n# devrouter:managed devcontainer\n: "${DEVROUTER_PROCESS_HELPER:?}"\n',
    );
    writeDevcontainer('{"postCreateCommand":"bash .devcontainer/post-create.sh"}\n');

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));
    const lifecycle = checks.find((check) => check.id === "repo.devcontainer.managed-post-start");

    expect(lifecycle?.level).toBe("error");
    expect(lifecycle?.details).toContain("Set waitFor to 'postCreateCommand'");
  });
});

describe("repo.host-port-claims check", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, ".devcontainer"), { recursive: true });
    vi.mocked(isLinkedWorktree).mockReturnValue(false);
    vi.mocked(loadRuntimeConfig).mockReturnValue({
      profile: "full",
      workspace: undefined,
      resolvedProfile: { name: "full" },
      config: managedConfig(),
    } as never);
    vi.mocked(inspectManagedDevcontainerConfig).mockReturnValue({
      composeFiles: ["/d/docker-compose.yml"],
      composeDirectory: "/d",
    } as never);
    vi.mocked(detectHostPortClaimConflicts).mockReturnValue([]);
  });

  it("is absent for repos without managedRuntime", () => {
    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checks.some((check) => check.id === "repo.host-port-claims")).toBe(false);
    expect(detectHostPortClaimConflicts).not.toHaveBeenCalled();
  });

  it("reports ok when no configured binding conflicts with a live holder", () => {
    const checks = buildDevcontainerChecks(tmpDir, managedConfig());

    expect(checkLevel(checks, "repo.host-port-claims")).toBe("ok");
    expect(detectHostPortClaimConflicts).toHaveBeenCalledWith({
      repoPath: tmpDir,
      plan: { composeFiles: ["/d/docker-compose.yml"], composeDirectory: "/d" },
      workspace: undefined,
    });
  });

  it("errors with holder attribution on conflicts", () => {
    vi.mocked(detectHostPortClaimConflicts).mockReturnValue([
      {
        service: "azurite",
        hostIp: "127.0.0.1",
        hostPort: 10003,
        protocol: "tcp",
        holderContainer: "default-fe-d0f0d-azurite-1",
        holderComposeProject: "default-fe-d0f0d",
        holderWorkspace: "feat-kb-capacity",
        remediation: "Stop the holding workspace.",
      },
    ]);

    const checks = buildDevcontainerChecks(tmpDir, managedConfig(), "feature");
    const check = checks.find((entry) => entry.id === "repo.host-port-claims");

    expect(check?.level).toBe("error");
    expect(check?.details).toContain("azurite: 127.0.0.1:10003/tcp");
    expect(check?.details).toContain("'default-fe-d0f0d-azurite-1'");
    expect(check?.details).toContain("workspace 'feat-kb-capacity'");
  });

  it("warns instead of throwing when evidence is unavailable", () => {
    vi.mocked(detectHostPortClaimConflicts).mockImplementation(() => {
      throw new Error("Cannot connect to the Docker daemon");
    });

    const checks = buildDevcontainerChecks(tmpDir, managedConfig());
    const check = checks.find((entry) => entry.id === "repo.host-port-claims");

    expect(check?.level).toBe("warn");
    expect(check?.details).toContain("Cannot connect to the Docker daemon");
  });

  it("passes the workspace interpolation env for linked checkouts", () => {
    vi.mocked(isLinkedWorktree).mockReturnValue(true);
    vi.mocked(resolveGitCommonDir).mockReturnValue("/tmp/host-port-claims-doctor/common");

    buildDevcontainerChecks(tmpDir, managedConfig(), "feature");

    expect(detectHostPortClaimConflicts).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: { token: "feature", gitCommonDir: "/tmp/host-port-claims-doctor/common" },
      }),
    );
  });
});

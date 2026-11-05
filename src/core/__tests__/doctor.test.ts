import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedRuntimeStatus, RouterStatus } from "../../types";
import { CapacityHistoryError } from "../capacity-store";
import { buildDoctorReport } from "../doctor";
import { collectManagedRuntimeStatus } from "../managed-runtime-status";
import { createLifecycleCapacityStore } from "../reliability-operation-store";
import { collectRouterStatus } from "../status";
import { getTLSHostCoverage } from "../tls";
import { inspectWorkspaceGc } from "../workspace-gc";
import { resolveGitCommonDir } from "../workspace-ownership";

vi.mock("../reliability-operation-store", () => ({
  createLifecycleCapacityStore: vi.fn(() => ({ read: () => ({ revision: 0, reservations: [] }) })),
}));

vi.mock("../status", () => ({
  collectRouterStatus: vi.fn(),
}));

vi.mock("../managed-runtime-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-runtime-status")>()),
  collectManagedRuntimeStatus: vi.fn(),
}));

vi.mock("../network-diagnostics", () => ({
  inspectNetworkCapacity: vi.fn(() => ({})),
  networkCapacityCheck: vi.fn(() => ({
    id: "global.network-capacity",
    level: "warn",
    summary: "Synthetic unknown capacity",
  })),
}));

vi.mock("../router", () => ({
  areTLSCertsPresent: vi.fn(() => false),
  DEVNET_NAME: "devnet",
  DEVROUTER_HOME: "/tmp/devrouter-doctor-test-home",
  getActiveTcpProtocols: vi.fn(() => []),
  getRouterFileLayout: vi.fn(() => ({ required: [], missing: [] })),
  isTLSConfigured: vi.fn(() => false),
  isTLSEnabled: vi.fn(() => false),
  ROUTER_CONTAINER_NAME: "devrouter-traefik",
  TCP_PROTOCOL_REGISTRY: {
    postgres: { port: 5432, entrypoint: "postgres" },
    redis: { port: 6379, entrypoint: "redis" },
    mariadb: { port: 3306, entrypoint: "mariadb" },
    mysql: { port: 3306, entrypoint: "mysql" },
  },
}));

vi.mock("../docker", () => ({
  findContainerByName: vi.fn(async () => undefined),
  getCurrentDockerContext: vi.fn(() => "default"),
  listContainers: vi.fn(async () => []),
  networkExists: vi.fn(async () => true),
}));

vi.mock("../host-routes", () => ({
  listHostRoutes: vi.fn(() => []),
}));

vi.mock("../route-state", () => ({
  findStaleProcessRoutes: vi.fn(() => []),
}));

vi.mock("../workspace-gc", () => ({ inspectWorkspaceGc: vi.fn() }));
vi.mock("../workspace-ownership", () => ({ resolveGitCommonDir: vi.fn() }));

vi.mock("../tls", () => ({
  getTLSHostCoverage: vi.fn(() => ({
    requiredHosts: [],
    certificateHosts: [],
    uncoveredHosts: [],
  })),
}));

vi.mock("../routes", async () => {
  const actual = await vi.importActual("../routes");
  return {
    ...(actual as object),
    discoverRoutes: vi.fn(() => ({ routes: [], duplicateHosts: [] })),
    findDuplicateHosts: vi.fn(() => []),
  };
});

vi.mock("../tool-diagnostics", () => ({
  buildGlobalToolChecks: vi.fn(() => []),
}));

vi.mock("../devcontainer-diagnostics", async () => {
  const actual = await vi.importActual("../devcontainer-diagnostics");
  return {
    ...(actual as object),
  };
});

let tmpDir: string;

function singleQuoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function writeRepoFiles(options: {
  composeEnv: string;
  hostCommand?: string;
  hostName?: string;
  managedProfiles?: string;
}): void {
  const hostName = options.hostName ?? "web.localhost";
  const hostAppBlock = options.hostCommand
    ? `
  - name: web
    host: ${hostName}
    protocol: http
    runtime: host
    dependencies:
      - app: db
    hostRun:
      command: ${singleQuoteYaml(options.hostCommand)}
      cwd: .
`
    : "";

  fs.writeFileSync(
    path.join(tmpDir, ".devrouter.yml"),
    `version: 1
${options.managedProfiles ?? ""}apps:
${hostAppBlock}
  - name: db
    host: db.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: docker
    docker:
      service: postgres
      internalPort: 5432
      composeFiles:
        - docker-compose.yml
`,
    "utf-8",
  );

  fs.writeFileSync(
    path.join(tmpDir, "docker-compose.yml"),
    `services:
  postgres:
    image: postgres:16
    environment:
${options.composeEnv}
`,
    "utf-8",
  );
}

function makeStatus(repoPath: string, tlsEnabled: boolean): RouterStatus {
  return {
    dockerContext: "default",
    routerRunning: true,
    routerContainerName: "devrouter-traefik",
    boundPorts: {
      web80: true,
      web443: true,
      dashboard8080: true,
      tcp: { postgres: true },
    },
    tlsEnabled,
    certPresent: tlsEnabled,
    tlsConfigured: tlsEnabled,
    networkExists: true,
    repo: {
      path: repoPath,
      configPath: path.join(repoPath, ".devrouter.yml"),
      exists: true,
      valid: true,
      appCount: 1,
      tcpAppCount: 1,
    },
    insights: {
      httpRoutingReady: true,
      tcpRoutingReady: tlsEnabled,
      nextSteps: [],
    },
  };
}

function makeManagedRuntimeStatus(
  overrides: Partial<ManagedRuntimeStatus> = {},
): ManagedRuntimeStatus {
  return {
    mode: "managed",
    status: "ready",
    profile: "ai",
    desired: { apps: ["chat"], services: ["litellm"], processes: ["chat"] },
    active: { apps: ["chat"], services: ["litellm"], processes: ["chat"] },
    serviceStatuses: { litellm: "healthy" },
    baseServiceStatuses: {},
    processStatuses: { chat: "running" },
    drift: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-doctor-test-"));
  vi.mocked(resolveGitCommonDir).mockReturnValue(path.join(tmpDir, ".git"));
  vi.mocked(inspectWorkspaceGc).mockReturnValue({
    generatedAt: "2026-07-15T10:00:00.000Z",
    repoPath: tmpDir,
    mode: "dry-run",
    summary: { total: 0, eligible: 0, cleaned: 0, blocked: 0, errors: 0 },
    candidates: [],
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("buildDoctorReport", () => {
  it("keeps normal diagnostics available outside Git repositories", async () => {
    writeRepoFiles({
      composeEnv:
        "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));
    vi.mocked(resolveGitCommonDir).mockImplementation(() => {
      throw new Error("not a Git repository");
    });

    const report = await buildDoctorReport({ repo: tmpDir });

    expect(report.repoPath).toBe(tmpDir);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.some((check) => check.id === "workspace.ownership-cleanup")).toBe(false);
    expect(inspectWorkspaceGc).not.toHaveBeenCalled();
  });

  it("reuses the GC inspector and prints the exact repo cleanup command", async () => {
    writeRepoFiles({
      composeEnv:
        "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));
    vi.mocked(inspectWorkspaceGc).mockReturnValue({
      generatedAt: "2026-07-15T10:00:00.000Z",
      repoPath: tmpDir,
      mode: "dry-run",
      summary: { total: 1, eligible: 1, cleaned: 0, blocked: 0, errors: 0 },
      candidates: [
        {
          kind: "owned",
          workspace: "gone",
          worktreePath: path.join(tmpDir, "trees", "gone"),
          ownerStatus: "missing",
          devpodStatus: "owned",
          routeCount: 1,
          eligible: true,
          reason: "Ownership record is missing from live Git registration or marked prunable.",
          actions: [],
        },
      ],
    });

    const report = await buildDoctorReport({ repo: tmpDir });
    const check = report.checks.find((entry) => entry.id === "workspace.ownership-cleanup");

    expect(check).toMatchObject({
      level: "warn",
      suggestion: `Run: dev workspace gc --repo ${tmpDir}`,
    });
    expect(check?.details).toContain("gone");
  });

  it("warns for conflict-only ownership reports without making them eligible", async () => {
    writeRepoFiles({
      composeEnv:
        "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));
    vi.mocked(inspectWorkspaceGc).mockReturnValue({
      generatedAt: "2026-07-15T10:00:00.000Z",
      repoPath: tmpDir,
      mode: "dry-run",
      summary: { total: 1, eligible: 0, cleaned: 0, blocked: 1, errors: 0 },
      candidates: [
        {
          kind: "owned",
          workspace: "conflict",
          devpodId: "conflict",
          worktreePath: path.join(tmpDir, "trees", "conflict"),
          ownerStatus: "conflict",
          devpodStatus: "conflict",
          routeCount: 0,
          eligible: false,
          reason: "Ownership conflicts with live evidence.",
          actions: [],
        },
      ],
    });

    const check = (await buildDoctorReport({ repo: tmpDir })).checks.find(
      (entry) => entry.id === "workspace.ownership-cleanup",
    );

    expect(check?.level).toBe("warn");
    expect(check?.details).toContain("conflict");
  });

  it("adds explicit TLS install guidance when tcp apps exist and TLS is disabled", async () => {
    writeRepoFiles({
      composeEnv:
        "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, false));

    const report = await buildDoctorReport({ repo: tmpDir });
    const tlsCheck = report.checks.find((check) => check.id === "repo.tcp-tls");

    expect(tlsCheck?.level).toBe("error");
    expect(tlsCheck?.suggestion).toBe("Run: dev tls install");
    expect(report.nextSteps).toContain("Run: dev tls install");
  });

  it("warns on postgres credential mismatch and includes volume migration remediation", async () => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n      POSTGRES_DB: app",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));

    const report = await buildDoctorReport({ repo: tmpDir });
    const credentialCheck = report.checks.find((check) => check.id === "repo.postgres-credentials");
    const tlsCoverageCheck = report.checks.find((check) => check.id === "repo.tls-host-coverage");

    expect(credentialCheck?.level).toBe("warn");
    expect(credentialCheck?.summary).toContain("differ from devrouter defaults");
    expect(credentialCheck?.suggestion).toContain("docker compose down -v");
    expect(tlsCoverageCheck?.level).toBe("ok");
  });

  it("warns when TLS cert does not cover configured hosts", async () => {
    writeRepoFiles({
      composeEnv:
        "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
      hostCommand: "pnpm dev",
      hostName: "elearning.klicker.localhost",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue({
      ...makeStatus(tmpDir, true),
      repo: {
        ...makeStatus(tmpDir, true).repo!,
        appCount: 2,
      },
    });
    vi.mocked(getTLSHostCoverage).mockReturnValue({
      requiredHosts: ["localhost", "*.localhost", "elearning.klicker.localhost"],
      certificateHosts: ["localhost", "*.localhost"],
      uncoveredHosts: ["elearning.klicker.localhost"],
    });

    const report = await buildDoctorReport({ repo: tmpDir });
    const tlsCoverageCheck = report.checks.find((check) => check.id === "repo.tls-host-coverage");

    expect(tlsCoverageCheck?.level).toBe("warn");
    expect(tlsCoverageCheck?.details).toContain("elearning.klicker.localhost");
    expect(tlsCoverageCheck?.suggestion).toContain("dev app run <name>");
  });

  it("warns when host command assigns DB vars before wrapper boundary", async () => {
    writeRepoFiles({
      composeEnv:
        "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
      hostCommand:
        "DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} infisical run --env=dev -- pnpm dev",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue({
      ...makeStatus(tmpDir, true),
      repo: {
        ...makeStatus(tmpDir, true).repo!,
        appCount: 2,
      },
    });

    const report = await buildDoctorReport({ repo: tmpDir });
    const precedenceCheck = report.checks.find(
      (check) => check.id === "repo.host-command-env-precedence",
    );

    expect(precedenceCheck?.level).toBe("warn");
    expect(precedenceCheck?.details).toContain("web");
    expect(precedenceCheck?.details).toContain("DATABASE_URI");
    expect(precedenceCheck?.suggestion).toContain("env DATABASE_URI=${DB_URL:?missing DB_URL}");
  });

  it("reports ok when DB var assignment happens after wrapper boundary", async () => {
    writeRepoFiles({
      composeEnv:
        "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
      hostCommand:
        "infisical run --env=dev -- env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} pnpm dev",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue({
      ...makeStatus(tmpDir, true),
      repo: {
        ...makeStatus(tmpDir, true).repo!,
        appCount: 2,
      },
    });

    const report = await buildDoctorReport({ repo: tmpDir });
    const precedenceCheck = report.checks.find(
      (check) => check.id === "repo.host-command-env-precedence",
    );

    expect(precedenceCheck?.level).toBe("ok");
    expect(precedenceCheck?.summary).toContain("No risky pre-wrapper DB env assignments");
  });

  it("reports error when CLI version is older than repo configuration required version", async () => {
    vi.stubGlobal("__VERSION__", "0.0.24");
    fs.writeFileSync(
      path.join(tmpDir, ".devrouter.yml"),
      `version: 1
devrouter:
  version: 0.0.25
apps: []
`,
      "utf-8",
    );
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));

    const report = await buildDoctorReport({ repo: tmpDir });
    const check = report.checks.find((c) => c.id === "repo.cli-outdated");
    expect(check?.level).toBe("error");
    expect(check?.details).toContain("installedVersion=0.0.24");
    expect(check?.details).toContain("repoVersion=0.0.25");
    expect(check?.details).toContain("repoVersionRelation=newer");

    vi.unstubAllGlobals();
  });

  it("reports ok when CLI version is equal or newer than repo configuration required version", async () => {
    vi.stubGlobal("__VERSION__", "0.0.25");
    fs.writeFileSync(
      path.join(tmpDir, ".devrouter.yml"),
      `version: 1
devrouter:
  version: 0.0.25
apps: []
`,
      "utf-8",
    );
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));

    const report = await buildDoctorReport({ repo: tmpDir });
    const check = report.checks.find((c) => c.id === "repo.cli-outdated");
    expect(check?.level).toBe("ok");
    expect(check?.details).toContain("installedVersion=0.0.25");
    expect(check?.details).toContain("repoVersion=0.0.25");
    expect(check?.details).toContain("repoVersionRelation=equal");

    vi.unstubAllGlobals();
  });

  it("keeps an older repo version pin as a non-failing, distinguishable diagnostic", async () => {
    vi.stubGlobal("__VERSION__", "0.0.25");
    fs.writeFileSync(
      path.join(tmpDir, ".devrouter.yml"),
      `version: 1
devrouter:
  version: 0.0.24
apps: []
`,
      "utf-8",
    );
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));

    const report = await buildDoctorReport({ repo: tmpDir });
    const check = report.checks.find((c) => c.id === "repo.cli-outdated");

    expect(check?.level).toBe("ok");
    expect(check?.details).toContain("installedVersion=0.0.25");
    expect(check?.details).toContain("repoVersion=0.0.24");
    expect(check?.details).toContain("repoVersionRelation=older");

    vi.unstubAllGlobals();
  });

  it("reports missing installed and repo versions explicitly as unknown", async () => {
    writeRepoFiles({ composeEnv: "      POSTGRES_HOST_AUTH_METHOD: trust" });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));

    const report = await buildDoctorReport({ repo: tmpDir });
    const check = report.checks.find((c) => c.id === "repo.cli-outdated");

    expect(check?.level).toBe("ok");
    expect(check?.details).toContain("installedVersion=unknown");
    expect(check?.details).toContain("repoVersion=unknown");
    expect(check?.details).toContain("repoVersionRelation=unknown");
  });

  it("warns with fixed expansion dimensions and the named-default remedy for a managed full profile", async () => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_HOST_AUTH_METHOD: trust",
      hostCommand: "pnpm dev",
      managedProfiles: `managedRuntime:
  devcontainer:
    baseServices:
      - postgres
    profileServices:
      - mailhog
  processes:
    - web
profiles:
  manage:
    apps:
      - web
    devcontainerServices:
      - mailhog
    processes:
      - web
  full:
    apps:
      - '*'
    default: true
`,
    });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));

    const report = await buildDoctorReport({ repo: tmpDir });
    const expansionChecks = report.checks.filter((check) => check.id === "repo.profile-expansion");

    expect(expansionChecks).toHaveLength(1);
    expect(expansionChecks[0]?.level).toBe("warn");
    expect(expansionChecks[0]?.details).toContain("notice=MANAGED_FULL_PROFILE_EXPANSION");
    expect(expansionChecks[0]?.details).toContain("dimensions=devcontainerServices,processes");
    expect(expansionChecks[0]?.details).not.toContain("mailhog");
    expect(expansionChecks[0]?.suggestion).toContain("SET_NAMED_DEFAULT_PROFILE");
    expect(expansionChecks[0]?.suggestion).toContain("manage");
  });

  it("omits the profile expansion diagnostic when the managed full profile selects every dimension", async () => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_HOST_AUTH_METHOD: trust",
      hostCommand: "pnpm dev",
      managedProfiles: `managedRuntime:
  devcontainer:
    baseServices:
      - postgres
    profileServices:
      - mailhog
  processes:
    - web
profiles:
  full:
    apps:
      - '*'
    devcontainerServices:
      - '*'
    processes:
      - '*'
    default: true
`,
    });
    vi.mocked(collectRouterStatus).mockResolvedValue(makeStatus(tmpDir, true));

    const report = await buildDoctorReport({ repo: tmpDir });

    expect(report.checks.some((check) => check.id === "repo.profile-expansion")).toBe(false);
  });

  it("reports a ready managed runtime as an ok diagnostic", async () => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_HOST_AUTH_METHOD: trust",
    });
    vi.mocked(collectRouterStatus).mockResolvedValue({
      ...makeStatus(tmpDir, true),
      repo: {
        ...makeStatus(tmpDir, true).repo!,
        managedRuntime: makeManagedRuntimeStatus(),
      },
    });

    const report = await buildDoctorReport({ repo: tmpDir });
    const check = report.checks.find((entry) => entry.id === "repo.managed-runtime");

    expect(check).toMatchObject({
      level: "ok",
      summary: "Managed runtime profile 'ai' is ready.",
    });
  });

  it.each([
    false,
    true,
  ])("keeps combined failed-transition advice non-starting with unwound mounts=%s", async (unwound) => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_HOST_AUTH_METHOD: trust",
      managedProfiles: `managedRuntime:
  devcontainer:
    baseServices:
      - postgres
    profileServices: []
  processes: []
`,
    });
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue(
      makeManagedRuntimeStatus({
        status: "failed-transition",
        ...(unwound
          ? {
              mountNesting: {
                status: "unwound" as const,
                checked: [],
                unwound: [
                  { destination: "/workspace/deps", source: "deps", nestedWithin: "/workspace" },
                ],
              },
            }
          : {}),
      }),
    );
    const actualStatus = await vi.importActual<typeof import("../status")>("../status");
    const status = await actualStatus.collectRouterStatus(tmpDir);
    expect(status.repo?.valid, status.repo?.error).toBe(true);
    expect(status.repo?.managedRuntime?.status).toBe("failed-transition");
    vi.mocked(collectRouterStatus).mockResolvedValue(status);

    const report = await buildDoctorReport({ repo: tmpDir });
    expect(report.nextSteps.some((step) => /\bdevrouter (?:ensure|stop)\b/.test(step))).toBe(false);
    expect(report.nextSteps.some((step) => /\bdevrouter status --repo\b/.test(step))).toBe(true);
    expect(report.checks.find((check) => check.id === "repo.managed-runtime")?.level).toBe("error");
  });

  it.each<{ name: string; runtime: Partial<ManagedRuntimeStatus> }>([
    { name: "unreadable history", runtime: { status: "drifted", drift: ["journal-writer-newer"] } },
    {
      name: "live owner",
      runtime: {
        reliability: {
          desired: "running",
          phase: "stable",
          admission: "not-applicable",
          chargeHeld: false,
          incident: null,
          operation: {
            operationId: "active",
            phase: "running",
            outcome: null,
            reason: null,
            exitCode: null,
            kind: "exec",
            drained: false,
          },
        },
      },
    },
  ])("keeps combined $name advice read-only even with an unwound mount", async ({ runtime }) => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_HOST_AUTH_METHOD: trust",
      managedProfiles: `managedRuntime:
  devcontainer:
    baseServices:
      - postgres
    profileServices: []
  processes: []
`,
    });
    vi.mocked(collectManagedRuntimeStatus).mockReturnValue(
      makeManagedRuntimeStatus({
        ...runtime,
        mountNesting: {
          status: "unwound",
          checked: [],
          unwound: [{ destination: "/workspace/deps", source: "deps", nestedWithin: "/workspace" }],
        },
      }),
    );
    const actualStatus = await vi.importActual<typeof import("../status")>("../status");
    const status = await actualStatus.collectRouterStatus(tmpDir);
    expect(status.repo?.valid, status.repo?.error).toBe(true);
    vi.mocked(collectRouterStatus).mockResolvedValue(status);
    const report = await buildDoctorReport({ repo: tmpDir });
    expect(report.nextSteps.some((step) => /\bdevrouter (?:ensure|stop|exec)\b/.test(step))).toBe(
      false,
    );
    expect(report.nextSteps.some((step) => /\bdevrouter status --repo\b/.test(step))).toBe(true);
  });

  it.each([
    {
      name: "stopped startup",
      runtime: { status: "stopped", activeVariant: "ci" },
      checkId: "repo.managed-runtime",
      level: "warn",
      expected: (checkout: string) => ["devrouter", "ensure", checkout, "--variant", "ci"],
    },
    {
      name: "failed-transition inspection",
      runtime: { status: "failed-transition" },
      checkId: "repo.managed-runtime",
      level: "error",
      expected: (checkout: string) => ["devrouter", "status", "--repo", checkout],
    },
    {
      name: "unwound mount restart",
      runtime: {
        activeVariant: "ci",
        mountNesting: {
          status: "unwound",
          checked: [],
          unwound: [{ destination: "/workspace/deps", source: "deps", nestedWithin: "/workspace" }],
        },
      },
      checkId: "repo.managed-mount-nesting",
      level: "warn",
      expected: (checkout: string) => [
        "devrouter",
        "stop",
        checkout,
        "devrouter",
        "ensure",
        checkout,
        "--variant",
        "ci",
      ],
    },
    {
      name: "unverified mount inspection",
      runtime: {
        mountNesting: { status: "unverified", checked: [], unwound: [] },
      },
      checkId: "repo.managed-mount-nesting",
      level: "warn",
      expected: (checkout: string) => [
        "devrouter",
        "exec",
        checkout,
        "--",
        "cat",
        "/proc/self/mountinfo",
      ],
    },
  ] satisfies Array<{
    name: string;
    runtime: Partial<ManagedRuntimeStatus>;
    checkId: string;
    level: string;
    expected: (checkout: string) => string[];
  }>)("preserves literal checkout arguments for $name", async ({
    runtime,
    checkId,
    level,
    expected,
  }) => {
    writeRepoFiles({ composeEnv: "      POSTGRES_HOST_AUTH_METHOD: trust" });
    const checkout = path.join(tmpDir, "pilot's checkout $HOME");
    fs.mkdirSync(checkout);
    for (const name of [".devrouter.yml", "docker-compose.yml"]) {
      fs.copyFileSync(path.join(tmpDir, name), path.join(checkout, name));
    }
    vi.mocked(collectRouterStatus).mockResolvedValue({
      ...makeStatus(checkout, true),
      repo: {
        ...makeStatus(checkout, true).repo!,
        managedRuntime: makeManagedRuntimeStatus(runtime),
      },
    });
    const report = await buildDoctorReport({ repo: checkout });
    const check = report.checks.find((entry) => entry.id === checkId);
    expect(check?.level).toBe(level);
    const suggestion = check?.suggestion;
    const commands = suggestion?.match(
      /\b(?:devrouter|dev) (?:stop|ensure|exec|status) .*?(?= and then | to |;|$)/g,
    );
    expect(commands).toBeDefined();
    const argv = execFileSync(
      "/bin/sh",
      [
        "-c",
        [
          "devrouter() { printf '%s\\0' devrouter \"$@\"; }",
          "dev() { printf '%s\\0' dev \"$@\"; }",
          ...commands!,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    )
      .split("\0")
      .slice(0, -1);
    expect(argv).toEqual(expected(checkout));
  });
});

it.each([
  "capacity-ledger-lost",
  "capacity-history-unprovable",
] as const)("reports %s without raw history evidence", async (code) => {
  vi.mocked(createLifecycleCapacityStore).mockImplementationOnce(() => {
    throw new CapacityHistoryError(code);
  });
  const report = await buildDoctorReport({ repo: tmpDir });
  expect(report.checks.find((check) => check.id === "global.capacity-ledger")).toMatchObject({
    level: "error",
    details: code,
  });
});

it("redacts an arbitrary capacity history read failure", async () => {
  const privateValue = "synthetic-private-history-value";
  vi.mocked(createLifecycleCapacityStore).mockImplementationOnce(() => {
    throw new Error(privateValue);
  });
  const report = await buildDoctorReport({ repo: tmpDir });
  const check = report.checks.find((check) => check.id === "global.capacity-ledger");
  expect(check).toMatchObject({ level: "error", details: "capacity-history-unprovable" });
  expect(JSON.stringify(check)).not.toContain(privateValue);
});

it("names the bounded journal cause and entry of an unprovable history", async () => {
  vi.mocked(createLifecycleCapacityStore).mockImplementationOnce(() => {
    throw new CapacityHistoryError(
      "capacity-history-unprovable",
      "journal-entry-unsupported",
      "23fe529a.stuck-stopping-20260914T1720.bak",
    );
  });
  const report = await buildDoctorReport({ repo: tmpDir });
  const check = report.checks.find((entry) => entry.id === "global.capacity-ledger");
  expect(check).toMatchObject({
    level: "error",
    details:
      "capacity-history-unprovable; journal-entry-unsupported; at 23fe529a.stuck-stopping-20260914T1720.bak",
  });
  expect(check?.suggestion).toContain("Move the named unrecognised entry");
});

it("reports newer-writer capacity history with its distinct cause", async () => {
  const location = `${"a".repeat(64)}.json`;
  vi.mocked(createLifecycleCapacityStore).mockImplementationOnce(() => {
    throw new CapacityHistoryError("capacity-history-unprovable", "journal-writer-newer", location);
  });
  const report = await buildDoctorReport({ repo: tmpDir });
  expect(report.checks.find((entry) => entry.id === "global.capacity-ledger")).toMatchObject({
    level: "error",
    details: `capacity-history-unprovable; journal-writer-newer; at ${location}`,
  });
});

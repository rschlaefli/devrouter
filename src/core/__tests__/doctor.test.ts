import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoctorReport } from "../doctor";
import type { RouterStatus } from "../../types";
import { collectRouterStatus } from "../status";
import { getTLSHostCoverage } from "../tls";

vi.mock("../status", () => ({
  collectRouterStatus: vi.fn(),
}));

vi.mock("../router", () => ({
  getRouterFileLayout: vi.fn(() => ({ required: [], missing: [] })),
  isTLSEnabled: vi.fn(() => false),
}));

vi.mock("../docker", () => ({
  listContainers: vi.fn(async () => []),
}));

vi.mock("../host-routes", () => ({
  listHostRouteState: vi.fn(() => []),
  listHostRoutes: vi.fn(() => []),
}));

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

let tmpDir: string;

function singleQuoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function writeRepoFiles(options: { composeEnv: string; hostCommand?: string; hostName?: string }): void {
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
apps:
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
    "utf-8"
  );

  fs.writeFileSync(
    path.join(tmpDir, "docker-compose.yml"),
    `services:
  postgres:
    image: postgres:16
    environment:
${options.composeEnv}
`,
    "utf-8"
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
      postgres5432: true,
      dashboard8080: true,
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-doctor-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("buildDoctorReport", () => {
  it("adds explicit TLS install guidance when tcp apps exist and TLS is disabled", async () => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
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
      composeEnv: "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
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
      composeEnv: "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
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
    const precedenceCheck = report.checks.find((check) => check.id === "repo.host-command-env-precedence");

    expect(precedenceCheck?.level).toBe("warn");
    expect(precedenceCheck?.details).toContain("web");
    expect(precedenceCheck?.details).toContain("DATABASE_URI");
    expect(precedenceCheck?.suggestion).toContain("env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL}");
  });

  it("reports ok when DB var assignment happens after wrapper boundary", async () => {
    writeRepoFiles({
      composeEnv: "      POSTGRES_USER: prisma\n      POSTGRES_PASSWORD: prisma\n      POSTGRES_DB: prisma",
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
    const precedenceCheck = report.checks.find((check) => check.id === "repo.host-command-env-precedence");

    expect(precedenceCheck?.level).toBe("ok");
    expect(precedenceCheck?.summary).toContain("No risky pre-wrapper DB env assignments");
  });
});

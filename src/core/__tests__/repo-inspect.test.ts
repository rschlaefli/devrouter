import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectRepo } from "../repo-inspect";

let tmpDir: string;

function write(fileName: string, content: string): void {
  const filePath = path.join(tmpDir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-repo-inspect-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("inspectRepo", () => {
  it("detects package, scripts, compose services, env names, devrouter config, and agent files", () => {
    write(
      "package.json",
      JSON.stringify({
        packageManager: "pnpm@11.6.0",
        engines: { node: ">=24" },
        scripts: {
          dev: "DATABASE_URL=postgres://secret-value next dev --port 3100",
          test: "vitest run",
        },
      }),
    );
    write(
      "infra/compose.yml",
      `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: prisma
      POSTGRES_USER: prisma
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U prisma"]
  redis:
    image: redis:7
`,
    );
    write(
      ".env.local",
      `DATABASE_URL=postgres://secret-value
AUTH0_ISSUER=https://issuer.example.test
PLAIN=value
`,
    );
    write(".devcontainer/devcontainer.json", "{}");
    write("AGENTS.md", "# Agents");
    write(".agents/skills/devrouter/SKILL.md", "# skill");
    write(
      ".devrouter.yml",
      `version: 1
apps:
  - name: app
    host: app.localhost
    protocol: http
    runtime: proxy
    upstream: app:3000
  - name: db
    host: db.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: docker
    docker:
      service: postgres
      internalPort: 5432
      composeFiles:
        - infra/compose.yml
`,
    );

    const report = inspectRepo({ repo: tmpDir });

    expect(report.packageManager).toEqual({
      name: "pnpm",
      version: "11.6.0",
      source: "package.json:packageManager",
    });
    expect(report.node).toEqual({ version: ">=24", source: "package.json:engines.node" });
    expect(report.scripts[0].command).toContain("DATABASE_URL=<redacted>");
    expect(JSON.stringify(report.scripts)).not.toContain("secret-value");
    expect(report.apps[0]).toMatchObject({ name: "app", port: 3100, confidence: "high" });
    expect(
      report.services.map((service) => [service.name, service.kind, service.hasHealthcheck]),
    ).toEqual([
      ["postgres", "postgres", true],
      ["redis", "redis", false],
    ]);
    expect(report.env.files).toEqual([
      {
        path: ".env.local",
        names: ["AUTH0_ISSUER", "DATABASE_URL", "PLAIN"],
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(report.env.authLikeNames).toEqual(["AUTH0_ISSUER"]);
    expect(report.env.databaseLikeNames).toEqual(["DATABASE_URL"]);
    expect(report.devcontainer).toEqual({
      exists: true,
      files: [".devcontainer/devcontainer.json"],
    });
    expect(report.devrouter).toMatchObject({
      exists: true,
      valid: true,
      appCount: 2,
      tcpAppCount: 1,
    });
    expect(report.agentGuidance).toEqual([
      { path: "AGENTS.md", kind: "agents" },
      { path: ".agents/skills/devrouter/SKILL.md", kind: "skill" },
    ]);
    expect(report.issues).toEqual([]);
  });

  it("reports actionable issues for missing onboarding surfaces", () => {
    const report = inspectRepo({ repo: tmpDir });

    expect(report.packageManager).toBeUndefined();
    expect(report.devcontainer.exists).toBe(false);
    expect(report.devrouter.exists).toBe(false);
    expect(report.issues.map((issue) => issue.id)).toEqual([
      "repo.package-manager.missing",
      "repo.devcontainer.missing",
      "repo.devrouter.missing",
    ]);
  });

  it("sanitizes invalid devrouter config errors", () => {
    write(
      ".devrouter.yml",
      `version: 1
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: host
    dependencies:
      - app: db
        envMap:
          DATABASE_URL: postgres://secret-value
    hostRun:
      command: pnpm dev
      cwd: .
`,
    );

    const report = inspectRepo({ repo: tmpDir });

    expect(report.devrouter.valid).toBe(false);
    expect(report.devrouter.error).toContain("value '<redacted>'");
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });
});

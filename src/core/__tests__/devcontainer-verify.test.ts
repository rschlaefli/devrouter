import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDevcontainer } from "../devcontainer-verify";
import { buildDoctorReport } from "../doctor";
import type { DoctorReport } from "../../types";

vi.mock("../doctor", () => ({
  buildDoctorReport: vi.fn(),
}));

let tmpDir: string;

function write(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function writeValidScaffold(): void {
  write(".devcontainer/devcontainer.json", "{}\n");
  write(".devcontainer/docker-compose.yml", "services: {}\n");
  write(
    ".devrouter.yml",
    `version: 1
project:
  name: sample
apps:
  - name: app
    host: sample.localhost
    protocol: http
    runtime: proxy
    upstream: \${WORKSPACE}-app:3000

  - name: db
    host: db.sample.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: proxy
    upstream: \${WORKSPACE}-db:5432
`
  );
}

function doctorReport(error = false): DoctorReport {
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    repoPath: tmpDir,
    summary: error ? { ok: 0, warn: 0, error: 1 } : { ok: 3, warn: 0, error: 0 },
    checks: error
      ? [{ id: "repo.devcontainer.aliases", level: "error", summary: "bad aliases" }]
      : [
          { id: "global.devnet", level: "ok", summary: "devnet exists" },
          { id: "repo.config", level: "ok", summary: "config valid" },
          { id: "repo.devcontainer.aliases", level: "ok", summary: "aliases ok" },
        ],
    nextSteps: [],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devcontainer-verify-test-"));
  vi.mocked(buildDoctorReport).mockResolvedValue(doctorReport(false));
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("verifyDevcontainer", () => {
  it("builds static verification evidence for a valid scaffold", async () => {
    writeValidScaffold();

    const report = await verifyDevcontainer({ repo: tmpDir });

    expect(report.summary.error).toBe(0);
    expect(report.evidence.proxyApps.map((app) => app.name)).toEqual(["app", "db"]);
    expect(report.evidence.blockingDoctorChecks).toEqual([]);
    expect(report.evidence.workspacePreview?.map((app) => app.host)).toContain("sample.verify.localhost");
    expect(report.checks.find((check) => check.id === "repo.devcontainer.verify-files")?.level).toBe("ok");
  });

  it("surfaces doctor blocking diagnostics", async () => {
    writeValidScaffold();
    vi.mocked(buildDoctorReport).mockResolvedValue(doctorReport(true));

    const report = await verifyDevcontainer({ repo: tmpDir });

    expect(report.summary.error).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === "repo.devcontainer.verify-doctor")?.level).toBe("error");
  });

  it("requires --yes before live verification mutates route state", async () => {
    writeValidScaffold();

    const report = await verifyDevcontainer({ repo: tmpDir, live: true });

    expect(report.summary.error).toBeGreaterThan(0);
    expect(report.checks.map((check) => check.id)).toContain("repo.devcontainer.verify-live-confirmation");
  });
});

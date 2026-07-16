import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "../../types";
import { verifyDevcontainer } from "../devcontainer-verify";
import { buildDoctorReport } from "../doctor";
import { probeHttpRoute } from "../http-route-probe";
import { replacePublishedProxyRoutes } from "../route-publication";

vi.mock("../doctor", () => ({
  buildDoctorReport: vi.fn(),
}));
vi.mock("../http-route-probe", () => ({ probeHttpRoute: vi.fn() }));
vi.mock("../route-publication", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../route-publication")>()),
  replacePublishedProxyRoutes: vi.fn(async () => []),
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
`,
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
  vi.mocked(probeHttpRoute).mockReturnValue({ ok: true, status: 404, details: "HTTP 404" });
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
    expect(report.evidence.workspacePreview?.map((app) => app.host)).toContain(
      "sample.verify.localhost",
    );
    expect(
      report.checks.find((check) => check.id === "repo.devcontainer.verify-files")?.level,
    ).toBe("ok");
  });

  it("surfaces doctor blocking diagnostics", async () => {
    writeValidScaffold();
    vi.mocked(buildDoctorReport).mockResolvedValue(doctorReport(true));

    const report = await verifyDevcontainer({ repo: tmpDir });

    expect(report.summary.error).toBeGreaterThan(0);
    expect(
      report.checks.find((check) => check.id === "repo.devcontainer.verify-doctor")?.level,
    ).toBe("error");
  });

  it("requires --yes before live verification mutates route state", async () => {
    writeValidScaffold();

    const report = await verifyDevcontainer({ repo: tmpDir, live: true });

    expect(report.summary.error).toBeGreaterThan(0);
    expect(report.checks.map((check) => check.id)).toContain(
      "repo.devcontainer.verify-live-confirmation",
    );
  });

  it("keeps live verification compatible through one batch publication and trusted probe", async () => {
    writeValidScaffold();

    const report = await verifyDevcontainer({ repo: tmpDir, live: true, yes: true });

    expect(replacePublishedProxyRoutes).toHaveBeenCalledOnce();
    expect(replacePublishedProxyRoutes).toHaveBeenCalledWith(
      tmpDir,
      expect.objectContaining({
        apps: expect.arrayContaining([expect.objectContaining({ name: "app" })]),
      }),
      undefined,
    );
    expect(probeHttpRoute).toHaveBeenCalledWith("sample.localhost", { repoPath: tmpDir });
    expect(report.evidence.liveRoutes).toEqual([
      {
        name: "app",
        host: "sample.localhost",
        status: "reachable",
        details: "HTTP 404",
      },
      expect.objectContaining({ name: "db", status: "registered" }),
    ]);
  });

  it("reports a routed 5xx as a live compatibility failure", async () => {
    writeValidScaffold();
    vi.mocked(probeHttpRoute).mockReturnValue({ ok: false, status: 503, details: "HTTP 503" });

    const report = await verifyDevcontainer({ repo: tmpDir, live: true, yes: true });

    expect(report.evidence.liveRoutes?.[0]).toMatchObject({
      name: "app",
      status: "failed",
      details: "HTTP 503",
    });
    expect(report.summary.error).toBeGreaterThan(0);
    expect(report.nextSteps).toEqual([
      "Start the devcontainer app process, then re-run live verification.",
    ]);
  });

  it("keeps live publication recovery scoped to the target repo", async () => {
    writeValidScaffold();
    vi.mocked(replacePublishedProxyRoutes).mockRejectedValueOnce(new Error("missing trust"));

    const report = await verifyDevcontainer({ repo: tmpDir, live: true, yes: true });

    expect(report.nextSteps).toEqual([
      expect.stringContaining(`devrouter setup --repo '${tmpDir}' --yes`),
    ]);
  });
});

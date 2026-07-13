import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureNetwork, isContainerRunning, networkExists } from "../docker";
import { buildDoctorReport } from "../doctor";
import { ensureRouterFiles, getRouterFileLayout, startRouterStack } from "../router";
import { runSetup } from "../setup";
import { installTLS } from "../tls";
import { runTool } from "../tool-diagnostics";

vi.mock("../docker", () => ({
  ensureNetwork: vi.fn(async () => undefined),
  isContainerRunning: vi.fn(async () => false),
  networkExists: vi.fn(async () => false),
}));

vi.mock("../router", () => ({
  DEVNET_NAME: "devnet",
  ROUTER_CONTAINER_NAME: "devrouter-traefik",
  ensureRouterFiles: vi.fn(),
  getRouterFileLayout: vi.fn(() => ({ required: [], missing: [] })),
  startRouterStack: vi.fn(),
}));

vi.mock("../tls", () => ({
  installTLS: vi.fn(async () => ({ alreadyEnabled: false, hosts: ["localhost", "*.localhost"] })),
}));

vi.mock("../doctor", () => ({
  buildDoctorReport: vi.fn(async () => ({
    generatedAt: "2026-06-28T00:00:00.000Z",
    repoPath: "/repo",
    summary: { ok: 1, warn: 0, error: 0 },
    checks: [{ id: "global.devnet", level: "ok", summary: "devnet exists" }],
    nextSteps: [],
  })),
}));

vi.mock("../tool-diagnostics", () => ({
  runTool: vi.fn(() => ({ ok: true, output: "v1.0.0" })),
}));

vi.mock("../repo-config", () => ({
  resolveRepoPath: vi.fn((repo?: string) => repo ?? "/repo"),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouterFileLayout).mockReturnValue({ required: [], missing: [] });
  vi.mocked(networkExists).mockResolvedValue(false);
  vi.mocked(isContainerRunning).mockResolvedValue(false);
  vi.mocked(runTool).mockReturnValue({ ok: true, output: "v1.0.0" });
  vi.mocked(installTLS).mockResolvedValue({
    alreadyEnabled: false,
    hosts: ["localhost", "*.localhost"],
  });
});

describe("runSetup", () => {
  it("requires explicit --yes before mutating machine state", async () => {
    const report = await runSetup({ repo: "/repo" });

    expect(ensureRouterFiles).not.toHaveBeenCalled();
    expect(ensureNetwork).not.toHaveBeenCalled();
    expect(startRouterStack).not.toHaveBeenCalled();
    expect(installTLS).not.toHaveBeenCalled();
    expect(report.summary.actions.failed).toBe(1);
    expect(report.actions[0]).toMatchObject({
      id: "setup.confirmation",
      status: "failed",
    });
  });

  it("performs missing router, network, stack, and TLS setup actions", async () => {
    vi.mocked(getRouterFileLayout).mockReturnValue({
      required: ["/home/.config/devrouter/compose.yml"],
      missing: ["/home/.config/devrouter/compose.yml"],
    });

    const report = await runSetup({ repo: "/repo", yes: true });

    expect(ensureRouterFiles).toHaveBeenCalled();
    expect(ensureNetwork).toHaveBeenCalledWith("devnet");
    expect(startRouterStack).toHaveBeenCalled();
    expect(installTLS).toHaveBeenCalled();
    expect(report.summary.actions).toEqual({ performed: 4, skipped: 0, failed: 0 });
    expect(report.actions.map((entry) => [entry.id, entry.status])).toEqual([
      ["global.router-files", "performed"],
      ["global.devnet", "performed"],
      ["global.router-stack", "performed"],
      ["global.tls", "performed"],
    ]);
  });

  it("reports setup as skipped when devrouter-owned state already exists", async () => {
    vi.mocked(networkExists).mockResolvedValue(true);
    vi.mocked(isContainerRunning).mockResolvedValue(true);
    vi.mocked(installTLS).mockResolvedValue({
      alreadyEnabled: true,
      hosts: ["localhost", "*.localhost"],
    });

    const report = await runSetup({ repo: "/repo", yes: true });

    expect(report.summary.actions).toEqual({ performed: 0, skipped: 4, failed: 0 });
    expect(report.actions.every((entry) => entry.status === "skipped")).toBe(true);
  });

  it("skips TLS mutation when mkcert is missing", async () => {
    vi.mocked(runTool).mockReturnValue({ ok: false, error: "not found" });

    const report = await runSetup({ repo: "/repo", yes: true });
    const tlsAction = report.actions.find((entry) => entry.id === "global.tls");

    expect(installTLS).not.toHaveBeenCalled();
    expect(tlsAction?.status).toBe("skipped");
    expect(tlsAction?.suggestion).toContain("Install mkcert");
    expect(report.nextSteps).toContain("Install mkcert, then run: devrouter setup --yes");
  });

  it("preserves structured output when a setup action fails", async () => {
    vi.mocked(networkExists).mockRejectedValue(new Error("Docker unavailable"));
    vi.mocked(buildDoctorReport).mockResolvedValue({
      generatedAt: "2026-06-28T00:00:00.000Z",
      repoPath: "/repo",
      summary: { ok: 0, warn: 0, error: 1 },
      checks: [{ id: "global.status", level: "error", summary: "Docker unavailable" }],
      nextSteps: ["Start Docker"],
    });

    const report = await runSetup({ repo: "/repo", yes: true });
    const devnetAction = report.actions.find((entry) => entry.id === "global.devnet");

    expect(devnetAction?.status).toBe("failed");
    expect(report.summary.actions.failed).toBe(1);
    expect(report.summary.checks.error).toBe(1);
    expect(report.nextSteps).toContain("Start Docker");
  });
});

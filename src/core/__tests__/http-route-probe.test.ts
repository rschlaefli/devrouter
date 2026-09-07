import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeHttpRoute } from "../http-route-probe";
import { isTLSEnabled } from "../router";
import { getMkcertRootCAPath } from "../tls";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../router", () => ({
  CERT_FILE: "/certs/localhost.pem",
  isTLSEnabled: vi.fn(() => true),
}));
vi.mock("../tls", () => ({ getMkcertRootCAPath: vi.fn(() => "/ca/rootCA.pem") }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTLSEnabled).mockReturnValue(true);
  vi.mocked(getMkcertRootCAPath).mockReturnValue("/ca/rootCA.pem");
});

describe("probeHttpRoute", () => {
  it("pins HTTPS readiness to the served certificate and accepts routed 4xx", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "404",
      stderr: "",
    } as never);

    const result = probeHttpRoute("elearning.klicker.localhost");

    expect(result).toMatchObject({ ok: true, status: 404, details: "HTTP 404" });
    expect(spawnSync).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining([
        "--cacert",
        "/certs/localhost.pem",
        "https://elearning.klicker.localhost",
      ]),
      { encoding: "utf-8" },
    );
    expect(vi.mocked(spawnSync).mock.calls[0][1]).not.toContain("/ca/rootCA.pem");
    expect(vi.mocked(spawnSync).mock.calls[0][1]).not.toContain("-k");
    expect(getMkcertRootCAPath).toHaveBeenCalledWith({ repoPath: undefined });
  });

  it("rejects 5xx responses", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "503",
      stderr: "",
    } as never);

    expect(probeHttpRoute("app.localhost")).toMatchObject({
      ok: false,
      status: 503,
      details: "HTTP 503",
    });
  });

  it("rejects a missing HTTP response even when curl exits successfully", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "000",
      stderr: "",
    } as never);

    expect(probeHttpRoute("app.localhost")).toMatchObject({ ok: false, status: 0 });
  });

  it("preserves curl diagnostics when TLS verification fails", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 60,
      stdout: "",
      stderr: "SSL certificate problem: out of memory",
    } as never);

    expect(probeHttpRoute("app.localhost")).toEqual({
      ok: false,
      status: undefined,
      details: "SSL certificate problem: out of memory",
    });
  });

  it("keeps plain HTTP probes free of TLS certificate arguments", () => {
    vi.mocked(isTLSEnabled).mockReturnValue(false);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "200",
      stderr: "",
    } as never);

    expect(probeHttpRoute("app.localhost")).toMatchObject({
      ok: true,
      status: 200,
      details: "HTTP 200",
    });
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toEqual(
      expect.not.arrayContaining(["--cacert", "/certs/localhost.pem"]),
    );
    expect(vi.mocked(getMkcertRootCAPath)).not.toHaveBeenCalled();
  });

  it("probes a readiness contract with bounded metadata-only curl arguments", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "200\tApplication/JSON; charset=utf-8",
      stderr: "",
    } as never);

    expect(
      probeHttpRoute("app.localhost", {
        maxTimeSeconds: 2.5,
        repoPath: "/repo",
        readiness: { path: "/health", contentType: "application/json" },
      }),
    ).toEqual({ ok: true, status: 200, details: "HTTP 200" });

    expect(spawnSync).toHaveBeenCalledWith(
      "curl",
      [
        "--disable",
        "--globoff",
        "--silent",
        "--show-error",
        "--no-location",
        "--noproxy",
        "*",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}\t%{content_type}",
        "--max-time",
        "2.5",
        "--cacert",
        "/certs/localhost.pem",
        "https://app.localhost/health",
      ],
      { encoding: "utf-8", maxBuffer: 1024, timeout: 2750 },
    );
    expect(vi.mocked(spawnSync).mock.calls[0][1]).not.toContain("--location");
    expect(vi.mocked(spawnSync).mock.calls[0][1]).not.toContain("/repo");
    expect(vi.mocked(getMkcertRootCAPath)).toHaveBeenCalledWith({ repoPath: "/repo" });
  });

  it("accepts an explicitly allowed 404 and rejects the default 200 contract", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "404\ttext/plain",
      stderr: "",
    } as never);

    expect(
      probeHttpRoute("app.localhost", { readiness: { path: "/health", statuses: [404] } }),
    ).toMatchObject({ ok: true, status: 404 });
    expect(probeHttpRoute("app.localhost", { readiness: { path: "/health" } })).toMatchObject({
      ok: false,
      status: 404,
      classification: "application-contract",
    });
  });

  it("classifies wrong media and redirect responses as application failures", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "200\ttext/html; charset=utf-8",
      stderr: "",
    } as never);

    expect(
      probeHttpRoute("app.localhost", {
        readiness: { path: "/health", contentType: "application/json" },
      }),
    ).toMatchObject({
      ok: false,
      status: 200,
      details: "HTTP 200; content type mismatch",
      classification: "application-contract",
    });

    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "302\ttext/html",
      stderr: "",
    } as never);
    expect(probeHttpRoute("app.localhost", { readiness: { path: "/health" } })).toMatchObject({
      ok: false,
      status: 302,
      classification: "application-contract",
    });
  });

  it("classifies TLS and transport failures without exposing curl output", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 60,
      stdout: "",
      stderr: "secret body or private location",
    } as never);

    expect(probeHttpRoute("app.localhost", { readiness: { path: "/health" } })).toEqual({
      ok: false,
      details: "HTTP route probe transport failure",
      classification: "transport",
    });
  });
});

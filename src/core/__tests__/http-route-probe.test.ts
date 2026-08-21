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
});

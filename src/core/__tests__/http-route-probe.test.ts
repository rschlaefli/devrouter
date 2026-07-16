import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeHttpRoute } from "../http-route-probe";
import { isTLSEnabled } from "../router";
import { getMkcertRootCAPath } from "../tls";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../router", () => ({ isTLSEnabled: vi.fn(() => true) }));
vi.mock("../tls", () => ({ getMkcertRootCAPath: vi.fn(() => "/ca/rootCA.pem") }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTLSEnabled).mockReturnValue(true);
  vi.mocked(getMkcertRootCAPath).mockReturnValue("/ca/rootCA.pem");
});

describe("probeHttpRoute", () => {
  it("verifies the real HTTPS hostname with the mkcert CA and accepts routed 4xx", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "404",
      stderr: "",
    } as never);

    const result = probeHttpRoute("elearning.klicker.localhost");

    expect(result).toMatchObject({ ok: true, status: 404 });
    expect(spawnSync).toHaveBeenCalledWith(
      "curl",
      expect.arrayContaining(["--cacert", "/ca/rootCA.pem", "https://elearning.klicker.localhost"]),
      { encoding: "utf-8" },
    );
    expect(vi.mocked(spawnSync).mock.calls[0][1]).not.toContain("-k");
  });

  it("rejects 5xx responses", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "503",
      stderr: "",
    } as never);

    expect(probeHttpRoute("app.localhost")).toMatchObject({ ok: false, status: 503 });
  });

  it("rejects a missing HTTP response even when curl exits successfully", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "000",
      stderr: "",
    } as never);

    expect(probeHttpRoute("app.localhost")).toMatchObject({ ok: false, status: 0 });
  });
});

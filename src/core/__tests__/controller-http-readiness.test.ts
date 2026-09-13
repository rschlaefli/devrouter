import { beforeEach, describe, expect, it, vi } from "vitest";
import { type HttpRouteProbeRunner, probeHttpReadiness } from "../http-route-probe";
import { isTLSEnabled } from "../router";
import { getMkcertRootCAPath } from "../tls";

vi.mock("../router", () => ({
  CERT_FILE: "/certs/localhost.pem",
  isTLSEnabled: vi.fn(() => true),
}));
vi.mock("../tls", () => ({ getMkcertRootCAPath: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTLSEnabled).mockReturnValue(true);
});

describe("controller HTTP readiness", () => {
  it("preserves readiness status and content-type classification", async () => {
    const runner: HttpRouteProbeRunner = vi.fn(async () => "200\ttext/html; charset=utf-8");

    await expect(
      probeHttpReadiness(
        "app.localhost",
        { path: "/health", contentType: "application/json" },
        new AbortController().signal,
        runner,
      ),
    ).resolves.toEqual({
      ok: false,
      status: 200,
      details: "HTTP 200; content type mismatch",
      classification: "application-contract",
    });
  });

  it("pins TLS to the served certificate without running the sync TLS probe", async () => {
    const signal = new AbortController().signal;
    const runner: HttpRouteProbeRunner = vi.fn(async () => "200\tapplication/json");

    await expect(
      probeHttpReadiness("app.localhost", { path: "/health" }, signal, runner),
    ).resolves.toMatchObject({ ok: true, status: 200 });

    expect(runner).toHaveBeenCalledWith(
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
        "2",
        "--cacert",
        "/certs/localhost.pem",
        "https://app.localhost/health",
      ],
      signal,
    );
    expect(getMkcertRootCAPath).not.toHaveBeenCalled();
  });

  it("propagates cancellation instead of classifying it as an application failure", async () => {
    const abort = new AbortController();
    const cancelled = new Error("cancelled");
    const runner: HttpRouteProbeRunner = vi.fn(
      (_command, _args, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(cancelled), { once: true });
        }),
    );

    const pending = probeHttpReadiness("app.localhost", { path: "/health" }, abort.signal, runner);
    abort.abort();

    await expect(pending).rejects.toBe(cancelled);
  });

  it("sanitizes non-cancellation runner failures as transport failures", async () => {
    const runner: HttpRouteProbeRunner = vi.fn(async () => {
      throw new Error("private transport details");
    });

    await expect(
      probeHttpReadiness(
        "app.localhost",
        { path: "/health" },
        new AbortController().signal,
        runner,
      ),
    ).resolves.toEqual({
      ok: false,
      details: "HTTP route probe transport failure",
      classification: "transport",
    });
  });
});

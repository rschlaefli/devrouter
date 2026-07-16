import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMkcertRootCAPath, refreshTLSCertificate } from "../tls";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  },
}));
vi.mock("../docker", () => ({
  findContainerByName: vi.fn(async () => undefined),
  isContainerRunning: vi.fn(async () => false),
}));
vi.mock("../host-routes", () => ({ refreshHostRoutesDynamicFile: vi.fn() }));
vi.mock("../router", () => ({
  CERT_FILE: "/devrouter/cert.pem",
  CERT_KEY_FILE: "/devrouter/key.pem",
  ensureRouterFiles: vi.fn(),
  isTLSEnabled: vi.fn(() => true),
  setTLSEnabled: vi.fn(),
  startRouterStack: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockImplementation((file) => String(file) === "/ca/rootCA.pem");
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    if (command === "sh") return { status: 0, stdout: "", stderr: "" } as never;
    if (command === "mkcert" && args?.[0] === "-CAROOT") {
      return { status: 0, stdout: "/ca\n", stderr: "" } as never;
    }
    return { status: 0, stdout: "", stderr: "" } as never;
  });
});

describe("refreshTLSCertificate", () => {
  it("re-mints SAN coverage without installing root-CA trust", async () => {
    await refreshTLSCertificate({ hosts: ["elearning.klicker.localhost"] });

    const mkcertCalls = vi
      .mocked(spawnSync)
      .mock.calls.filter(([command]) => command === "mkcert")
      .map(([, args]) => args);
    expect(mkcertCalls.some((args) => args?.includes("-install"))).toBe(false);
    expect(mkcertCalls).toContainEqual(
      expect.arrayContaining(["-cert-file", "/devrouter/cert.pem", "elearning.klicker.localhost"]),
    );
  });

  it("points missing first-time trust at repo-scoped setup", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => getMkcertRootCAPath({ repoPath: "/repo with spaces" })).toThrow(
      "devrouter setup --repo '/repo with spaces' --yes",
    );
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLockSync } from "../file-lock";
import { getMkcertRootCAPath, refreshTLSCertificate } from "../tls";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:crypto", () => ({
  X509Certificate: class {
    subjectAltName: string;

    constructor(pem: string) {
      this.subjectAltName = pem;
    }
  },
}));
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  },
}));
vi.mock("../file-lock", () => ({
  withFileLockSync: vi.fn((_path: string, _options: unknown, operation: () => unknown) =>
    operation(),
  ),
}));
vi.mock("../docker", () => ({
  findContainerByName: vi.fn(async () => undefined),
  isContainerRunning: vi.fn(async () => false),
}));
vi.mock("../host-routes", () => ({ refreshHostRoutesDynamicFile: vi.fn() }));
vi.mock("../router", () => ({
  CERT_FILE: "/devrouter/cert.pem",
  CERT_KEY_FILE: "/devrouter/key.pem",
  DEVROUTER_HOME: "/devrouter",
  ensureRouterFiles: vi.fn(),
  isTLSEnabled: vi.fn(() => true),
  setTLSEnabled: vi.fn(),
  startRouterStack: vi.fn(),
}));

let certificateSubjectAltName = "";

beforeEach(() => {
  vi.clearAllMocks();
  certificateSubjectAltName = "";
  vi.mocked(fs.existsSync).mockImplementation(
    (file) => String(file) === "/ca/rootCA.pem" || String(file) === "/devrouter/cert.pem",
  );
  vi.mocked(fs.readFileSync).mockImplementation(
    (file) => (String(file) === "/devrouter/cert.pem" ? certificateSubjectAltName : "") as never,
  );
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    if (command === "sh") return { status: 0, stdout: "", stderr: "" } as never;
    if (command === "mkcert" && args?.[0] === "-CAROOT") {
      return { status: 0, stdout: "/ca\n", stderr: "" } as never;
    }
    if (command === "mkcert" && args?.[0] === "-cert-file") {
      certificateSubjectAltName = args
        .slice(4)
        .map((host) => `DNS:${host}`)
        .join(", ");
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
    expect(withFileLockSync).toHaveBeenCalledWith(
      "/devrouter/tls-certificate.lock",
      expect.objectContaining({ activity: "TLS certificate refresh", waitMs: 60_000 }),
      expect.any(Function),
    );
  });

  it("serializes refreshes and preserves hosts added by an earlier worktree", async () => {
    await Promise.all([
      refreshTLSCertificate({ hosts: ["manage.first.localhost"] }),
      refreshTLSCertificate({ hosts: ["manage.second.localhost"] }),
    ]);

    expect(certificateSubjectAltName).toContain("DNS:manage.first.localhost");
    expect(certificateSubjectAltName).toContain("DNS:manage.second.localhost");
  });

  it("points missing first-time trust at repo-scoped setup", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => getMkcertRootCAPath({ repoPath: "/repo with spaces" })).toThrow(
      "devrouter setup --repo '/repo with spaces' --yes",
    );
  });
});

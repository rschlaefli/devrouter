import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let originalDevrouterHome: string;

vi.mock("../docker-error-guidance", () => ({
  withDockerFailureGuidance: vi.fn((msg: string) => msg),
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-router-tcp-test-"));
  originalDevrouterHome = process.env.HOME ?? os.homedir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("TCP_PROTOCOL_REGISTRY", () => {
  it("exports supported protocols", async () => {
    const { TCP_PROTOCOL_REGISTRY } = await import("../router");
    expect(TCP_PROTOCOL_REGISTRY.postgres).toEqual({ port: 5432, entrypoint: "postgres" });
    expect(TCP_PROTOCOL_REGISTRY.redis).toEqual({ port: 6379, entrypoint: "redis" });
    expect(TCP_PROTOCOL_REGISTRY.mariadb).toEqual({ port: 3306, entrypoint: "mariadb" });
    expect(TCP_PROTOCOL_REGISTRY.mysql).toEqual({ port: 3306, entrypoint: "mysql" });
  });
});

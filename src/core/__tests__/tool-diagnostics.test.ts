import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGlobalToolChecks } from "../tool-diagnostics";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

let tmpDir: string;

function writePackageJson(packageManager = "pnpm@11.6.0"): void {
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({
      packageManager,
      engines: { node: ">=1" },
    }),
    "utf-8"
  );
}

function result(status: number, stdout = "", stderr = ""): unknown {
  return { status, stdout, stderr };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-tool-diagnostics-test-"));
  spawnSyncMock.mockImplementation((command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "docker compose version") {
      return result(0, "Docker Compose version v2.39.0\n");
    }
    if (key === "mkcert -version") {
      return result(0, "v1.4.4\n");
    }
    if (key === "devpod version") {
      return result(0, "0.7.0\n");
    }
    if (key === "pnpm --version") {
      return result(0, "11.6.0\n");
    }
    if (key === "brew --version") {
      return result(0, "Homebrew 4.5.0\n");
    }
    return result(1, "", "missing");
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("buildGlobalToolChecks", () => {
  it("reports required global tools as ok when they are reachable", () => {
    writePackageJson();

    const checks = buildGlobalToolChecks(tmpDir);

    expect(checks.map((check) => [check.id, check.level])).toEqual([
      ["global.docker-compose", "ok"],
      ["global.mkcert", "ok"],
      ["global.devpod", "ok"],
      ["global.node-toolchain", "ok"],
    ]);
  });

  it("reports actionable remediation when external tools are missing", () => {
    writePackageJson();
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "brew --version") {
        return result(0, "Homebrew 4.5.0\n");
      }
      return result(1, "", `${key} missing`);
    });

    const checks = buildGlobalToolChecks(tmpDir);
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("global.docker-compose")?.level).toBe("error");
    expect(byId.get("global.docker-compose")?.suggestion).toContain("Compose v2");
    expect(byId.get("global.mkcert")?.level).toBe("warn");
    expect(byId.get("global.mkcert")?.suggestion).toBe("Install mkcert: brew install mkcert");
    expect(byId.get("global.devpod")?.level).toBe("warn");
    expect(byId.get("global.devpod")?.suggestion).toContain("brew install devpod");
    expect(byId.get("global.node-toolchain")?.level).toBe("warn");
    expect(byId.get("global.node-toolchain")?.suggestion).toContain("pnpm@11.6.0");
  });
});

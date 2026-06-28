import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDevcontainerChecks } from "../devcontainer-diagnostics";
import type { DevrouterConfig } from "../../types";

let tmpDir: string;

function writeCompose(options: { aliases?: string[]; external?: boolean; ports?: string } = {}): void {
  const aliases = options.aliases ?? ["${WORKSPACE:-sample}-app"];
  const external = options.external ?? true;
  const ports = options.ports ? `    ports:\n      - ${options.ports}\n` : "";
  const composePath = path.join(tmpDir, ".devcontainer", "docker-compose.yml");
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(
    composePath,
    `services:
  app:
${ports}    networks:
      devnet:
        aliases:
${aliases.map((alias) => `          - ${alias}`).join("\n")}
networks:
  devnet:
    external: ${String(external)}
`,
    "utf-8"
  );
}

function config(upstream: string): DevrouterConfig {
  return {
    version: 1,
    apps: [
      {
        name: "app",
        host: "sample.localhost",
        protocol: "http",
        runtime: "proxy",
        dependencies: [],
        upstream,
      },
    ],
  };
}

function checkLevel(checks: ReturnType<typeof buildDevcontainerChecks>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.level;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devcontainer-diagnostics-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildDevcontainerChecks", () => {
  it("matches defaulted workspace aliases to concrete default upstreams", () => {
    writeCompose();

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.upstream-alias-match")).toBe("ok");
  });

  it("matches defaulted workspace aliases to active workspace upstreams", () => {
    writeCompose();

    const checks = buildDevcontainerChecks(tmpDir, config("feature-x-app:3000"), "feature-x");

    expect(checkLevel(checks, "repo.devcontainer.upstream-alias-match")).toBe("ok");
  });

  it("warns when top-level devnet is not external", () => {
    writeCompose({ external: false });

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.aliases")).toBe("warn");
  });

  it("errors on published host ports including long syntax", () => {
    writeCompose({ ports: "{ target: 3000, published: 3000 }" });

    const checks = buildDevcontainerChecks(tmpDir, config("sample-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.no-published-ports")).toBe("error");
  });

  it("warns when proxy upstreams do not match aliases", () => {
    writeCompose();

    const checks = buildDevcontainerChecks(tmpDir, config("other-app:3000"));

    expect(checkLevel(checks, "repo.devcontainer.upstream-alias-match")).toBe("warn");
  });
});

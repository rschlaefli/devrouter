import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDevcontainerChecks } from "../devcontainer-diagnostics";
import type { DevrouterConfig } from "../../types";

let tmpDir: string;

function writeCompose(content: string): void {
  const devcontainerDir = path.join(tmpDir, ".devcontainer");
  fs.mkdirSync(devcontainerDir, { recursive: true });
  fs.writeFileSync(path.join(devcontainerDir, "docker-compose.yml"), content, "utf-8");
}

function config(upstream = "${WORKSPACE}-app:3000"): DevrouterConfig {
  return {
    version: 1,
    apps: [
      {
        name: "app",
        host: "app.localhost",
        protocol: "http",
        runtime: "proxy",
        upstream,
        dependencies: [],
      },
    ],
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devcontainer-diagnostics-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildDevcontainerChecks", () => {
  it("reports ok when proxy upstreams match workspace-aware devnet aliases", () => {
    writeCompose(`services:
  app:
    image: node:24
    networks:
      devnet:
        aliases:
          - \${WORKSPACE:-demo}-app
networks:
  devnet:
    external: true
`);

    const checks = buildDevcontainerChecks(tmpDir, config());
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get("repo.devcontainer.aliases")?.level).toBe("ok");
    expect(byId.get("repo.devcontainer.no-published-ports")?.level).toBe("ok");
    expect(byId.get("repo.devcontainer.upstream-alias-match")?.level).toBe("ok");
  });

  it("reports published host ports as blocking diagnostics", () => {
    writeCompose(`services:
  app:
    image: node:24
    ports:
      - "3000:3000"
    networks:
      devnet:
        aliases:
          - \${WORKSPACE:-demo}-app
networks:
  devnet:
    external: true
`);

    const checks = buildDevcontainerChecks(tmpDir, config());
    const portCheck = checks.find((check) => check.id === "repo.devcontainer.no-published-ports");

    expect(portCheck?.level).toBe("error");
    expect(portCheck?.details).toContain("app: 3000:3000");
    expect(portCheck?.suggestion).toContain("Remove published ports");
  });

  it("reports Compose long-syntax published host ports as blocking diagnostics", () => {
    writeCompose(`services:
  app:
    image: node:24
    ports:
      - target: 3000
        published: 3000
        protocol: tcp
    networks:
      devnet:
        aliases:
          - \${WORKSPACE:-demo}-app
networks:
  devnet:
    external: true
`);

    const checks = buildDevcontainerChecks(tmpDir, config());
    const portCheck = checks.find((check) => check.id === "repo.devcontainer.no-published-ports");

    expect(portCheck?.level).toBe("error");
    expect(portCheck?.details).toContain("app: 3000:3000");
  });

  it("warns when devnet aliases are not attached to an external devnet network", () => {
    writeCompose(`services:
  app:
    image: node:24
    networks:
      devnet:
        aliases:
          - \${WORKSPACE:-demo}-app
networks:
  devnet: {}
`);

    const checks = buildDevcontainerChecks(tmpDir, config());
    const aliasCheck = checks.find((check) => check.id === "repo.devcontainer.aliases");

    expect(aliasCheck?.level).toBe("warn");
    expect(aliasCheck?.summary).toContain("top-level devnet is not marked external");
    expect(aliasCheck?.details).toContain("devnetExternal=false");
  });

  it("warns when devrouter upstreams do not match devcontainer aliases", () => {
    writeCompose(`services:
  app:
    image: node:24
    networks:
      devnet:
        aliases:
          - \${WORKSPACE:-demo}-app
networks:
  devnet:
    external: true
`);

    const checks = buildDevcontainerChecks(tmpDir, config("${WORKSPACE}-web:3000"));
    const matchCheck = checks.find((check) => check.id === "repo.devcontainer.upstream-alias-match");

    expect(matchCheck?.level).toBe("warn");
    expect(matchCheck?.details).toContain("app: ${WORKSPACE}-web");
  });
});

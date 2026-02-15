import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initRepoConfig,
  loadRepoConfig,
  removeRepoApp,
  resolveAppDependencies,
  upsertRepoApp,
} from "../repo-config";
import type { DevrouterApp, DevrouterConfig } from "../../types";

// -- helpers --

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-test-"));
}

function writeConfig(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, ".devrouter.yml"), content, "utf-8");
}

function readConfig(dir: string): string {
  return fs.readFileSync(path.join(dir, ".devrouter.yml"), "utf-8");
}

/** Minimal valid YAML config string */
const VALID_MINIMAL = `
version: 1
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: docker
    docker:
      service: web
      internalPort: 3000
`;

const VALID_HOST_APP = `
version: 1
apps:
  - name: api
    host: api.localhost
    protocol: http
    runtime: host
    hostRun:
      command: node server.js
      cwd: .
`;

const VALID_TCP_POSTGRES = `
version: 1
apps:
  - name: db
    host: db.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: docker
    docker:
      service: db
      internalPort: 5432
`;

const VALID_DOCKER_DEPENDENCY = `
version: 1
apps:
  - name: redis
    kind: dependency
    runtime: docker
    docker:
      service: redis
      composeFiles:
        - docker-compose.yml
`;

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- loadRepoConfig ----

describe("loadRepoConfig", () => {
  it("loads valid YAML config", () => {
    writeConfig(tmpDir, VALID_MINIMAL);
    const config = loadRepoConfig(tmpDir);
    expect(config.version).toBe(1);
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe("web");
  });

  it("throws on missing config file", () => {
    expect(() => loadRepoConfig(tmpDir)).toThrow("Missing .devrouter.yml");
  });

  it("throws on malformed YAML", () => {
    writeConfig(tmpDir, "version: 1\napps: not-an-array");
    expect(() => loadRepoConfig(tmpDir)).toThrow("apps must be an array");
  });

  it("rejects unknown top-level fields", () => {
    writeConfig(tmpDir, "version: 1\napps: []\nextraField: true");
    expect(() => loadRepoConfig(tmpDir)).toThrow("extraField is not supported");
  });

  it("rejects version != 1", () => {
    writeConfig(tmpDir, "version: 2\napps: []");
    expect(() => loadRepoConfig(tmpDir)).toThrow("version must be 1");
  });

  it("loads config with project name", () => {
    writeConfig(
      tmpDir,
      "version: 1\nproject:\n  name: my-project\napps: []"
    );
    const config = loadRepoConfig(tmpDir);
    expect(config.project?.name).toBe("my-project");
  });

  it("loads config with devrouter.version metadata", () => {
    writeConfig(
      tmpDir,
      "version: 1\ndevrouter:\n  version: 0.0.14\napps: []"
    );
    const config = loadRepoConfig(tmpDir);
    expect(config.devrouter?.version).toBe("0.0.14");
  });

  it("rejects invalid devrouter.version values", () => {
    writeConfig(
      tmpDir,
      "version: 1\ndevrouter:\n  version: latest\napps: []"
    );
    expect(() => loadRepoConfig(tmpDir)).toThrow("devrouter.version must be a semantic version");
  });

  it("rejects unknown keys under devrouter", () => {
    writeConfig(
      tmpDir,
      "version: 1\ndevrouter:\n  channel: stable\napps: []"
    );
    expect(() => loadRepoConfig(tmpDir)).toThrow("devrouter.channel is not supported");
  });
});

// ---- hostname validation ----

describe("hostname validation", () => {
  it("rejects host without .localhost suffix", () => {
    const yaml = VALID_MINIMAL.replace("web.localhost", "web.example.com");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("must end with .localhost");
  });

  it("rejects underscores in host", () => {
    const yaml = VALID_MINIMAL.replace("web.localhost", "my_app.localhost");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("invalid characters");
  });

  it("accepts hyphenated host", () => {
    const yaml = VALID_MINIMAL.replace("web.localhost", "my-app.localhost");
    writeConfig(tmpDir, yaml);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0];
    if (app.kind === "dependency") {
      throw new Error("Expected routed app");
    }
    expect(app.host).toBe("my-app.localhost");
  });

  it("accepts multi-segment host", () => {
    const yaml = VALID_MINIMAL.replace(
      "web.localhost",
      "api.v2.my-app.localhost"
    );
    writeConfig(tmpDir, yaml);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0];
    if (app.kind === "dependency") {
      throw new Error("Expected routed app");
    }
    expect(app.host).toBe("api.v2.my-app.localhost");
  });
});

// ---- protocol / runtime combos ----

describe("protocol/runtime combinations", () => {
  it("accepts host + http", () => {
    writeConfig(tmpDir, VALID_HOST_APP);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0];
    if (app.kind === "dependency") {
      throw new Error("Expected routed app");
    }
    expect(app.runtime).toBe("host");
    expect(app.protocol).toBe("http");
  });

  it("rejects host + tcp", () => {
    const yaml = `
version: 1
apps:
  - name: bad
    host: bad.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: host
    hostRun:
      command: node server.js
`;
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow(
      "host runtime currently supports only protocol=http"
    );
  });

  it("accepts docker + tcp + postgres", () => {
    writeConfig(tmpDir, VALID_TCP_POSTGRES);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0] as Extract<
      DevrouterApp,
      { protocol: "tcp" }
    >;
    expect(app.protocol).toBe("tcp");
    expect(app.tcpProtocol).toBe("postgres");
    expect(app.runtime).toBe("docker");
  });

  it("rejects docker + tcp + non-postgres", () => {
    const yaml = VALID_TCP_POSTGRES.replace("postgres", "mysql");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow(
      "tcpProtocol must be 'postgres'"
    );
  });

  it("accepts dependency kind app", () => {
    writeConfig(tmpDir, VALID_DOCKER_DEPENDENCY);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0];
    expect(app.kind).toBe("dependency");
    if (app.kind !== "dependency") {
      throw new Error("Expected dependency app");
    }
    expect(app.runtime).toBe("docker");
    expect(app.docker.service).toBe("redis");
    expect(app.docker.composeFiles).toEqual(["docker-compose.yml"]);
  });

  it("rejects dependency kind with host/protocol fields", () => {
    const yaml = `
version: 1
apps:
  - name: redis
    kind: dependency
    host: redis.localhost
    protocol: http
    runtime: docker
    docker:
      service: redis
`;
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("host is not supported when kind=dependency");
  });

  it("rejects dependency kind with non-docker runtime", () => {
    const yaml = `
version: 1
apps:
  - name: redis
    kind: dependency
    runtime: host
    docker:
      service: redis
`;
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("runtime must be 'docker' when kind=dependency");
  });
});

// ---- resolveAppDependencies ----

describe("resolveAppDependencies", () => {
  function makeApp(
    name: string,
    deps: string[] = []
  ): DevrouterApp {
    return {
      name,
      host: `${name}.localhost`,
      protocol: "http",
      runtime: "docker",
      dependencies: deps.map((d) => ({ app: d })),
      docker: { service: name, internalPort: 3000, composeFiles: ["docker-compose.yml"] },
    } as DevrouterApp;
  }

  function makeConfig(...apps: DevrouterApp[]): DevrouterConfig {
    return { version: 1, apps };
  }

  it("resolves linear chain A -> B -> C", () => {
    const c = makeApp("c");
    const b = makeApp("b", ["c"]);
    const a = makeApp("a", ["b"]);
    const config = makeConfig(a, b, c);
    const deps = resolveAppDependencies(config, a);
    expect(deps.map((d) => d.name)).toEqual(["b", "c"]);
  });

  it("resolves diamond A -> B,C ; B -> D ; C -> D", () => {
    const d = makeApp("d");
    const b = makeApp("b", ["d"]);
    const c = makeApp("c", ["d"]);
    const a = makeApp("a", ["b", "c"]);
    const config = makeConfig(a, b, c, d);
    const deps = resolveAppDependencies(config, a);
    const names = deps.map((dep) => dep.name);
    expect(names).toContain("b");
    expect(names).toContain("c");
    expect(names).toContain("d");
    // d should only appear once
    expect(names.filter((n) => n === "d")).toHaveLength(1);
  });

  it("detects cycle", () => {
    const a = makeApp("a", ["b"]);
    const b = makeApp("b", ["a"]);
    const config = makeConfig(a, b);
    expect(() => resolveAppDependencies(config, a)).toThrow(
      "Dependency cycle detected"
    );
  });

  it("throws on missing dependency", () => {
    const a = makeApp("a", ["nonexistent"]);
    const config = makeConfig(a);
    expect(() => resolveAppDependencies(config, a)).toThrow(
      "does not exist in config"
    );
  });

  it("returns empty for app with no dependencies", () => {
    const a = makeApp("a");
    const config = makeConfig(a);
    expect(resolveAppDependencies(config, a)).toEqual([]);
  });
});

// ---- upsertRepoApp / removeRepoApp ----

describe("upsertRepoApp / removeRepoApp", () => {
  beforeEach(() => {
    initRepoConfig(tmpDir);
  });

  const baseOptions = {
    name: "myapp",
    host: "myapp.localhost",
    protocol: "http" as const,
    runtime: "docker" as const,
    service: "myapp",
    port: 3000,
    composeFiles: [] as string[],
    dependsOn: [] as string[],
  };

  it("adds a new app", () => {
    const { app } = upsertRepoApp(tmpDir, baseOptions);
    expect(app.name).toBe("myapp");
    const config = loadRepoConfig(tmpDir);
    expect(config.apps).toHaveLength(1);
  });

  it("updates existing app (upsert)", () => {
    upsertRepoApp(tmpDir, baseOptions);
    upsertRepoApp(tmpDir, { ...baseOptions, port: 4000 });
    const config = loadRepoConfig(tmpDir);
    expect(config.apps).toHaveLength(1);
    const app = config.apps[0];
    if (app.kind === "dependency") {
      throw new Error("Expected routed app");
    }
    if (app.runtime !== "docker") {
      throw new Error("Expected docker app");
    }
    expect(app.docker.internalPort).toBe(4000);
  });

  it("removes an app", () => {
    upsertRepoApp(tmpDir, baseOptions);
    const { removed } = removeRepoApp(tmpDir, "myapp");
    expect(removed).toBe(true);
    const config = loadRepoConfig(tmpDir);
    expect(config.apps).toHaveLength(0);
  });

  it("returns removed=false for nonexistent app", () => {
    const { removed } = removeRepoApp(tmpDir, "ghost");
    expect(removed).toBe(false);
  });
});

// ---- initRepoConfig ----

describe("initRepoConfig", () => {
  it("creates config if missing", () => {
    const result = initRepoConfig(tmpDir);
    expect(result.created).toBe(true);
    expect(fs.existsSync(result.configPath)).toBe(true);
  });

  it("does not overwrite existing config", () => {
    writeConfig(tmpDir, VALID_MINIMAL);
    const result = initRepoConfig(tmpDir);
    expect(result.created).toBe(false);
    // original content preserved
    expect(readConfig(tmpDir)).toContain("web");
  });

  it("writes devrouter.version when provided", () => {
    const result = initRepoConfig(tmpDir, { devrouterVersion: "0.0.14" });
    expect(result.created).toBe(true);

    const config = loadRepoConfig(tmpDir);
    expect(config.devrouter?.version).toBe("0.0.14");
  });
});

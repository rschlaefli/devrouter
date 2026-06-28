import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyWorkspace,
  initRepoConfig,
  loadRepoConfig,
  removeRepoApp,
  resolveAppByName,
  resolveAppDependencies,
  upsertRepoApp,
} from "../repo-config";
import { formatSupportedTcpProtocols } from "../capabilities";
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

const VALID_PROXY_APP = `
version: 1
apps:
  - name: app
    host: app.localhost
    protocol: http
    runtime: proxy
    upstream: 127.0.0.1:3000
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

  it("accepts proxy + http + upstream", () => {
    writeConfig(tmpDir, VALID_PROXY_APP);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0] as Extract<DevrouterApp, { runtime: "proxy" }>;
    expect(app.runtime).toBe("proxy");
    expect(app.protocol).toBe("http");
    expect(app.host).toBe("app.localhost");
    expect(app.upstream).toBe("127.0.0.1:3000");
  });

  it("rejects proxy without upstream", () => {
    const yaml = VALID_PROXY_APP.split("\n").filter((l) => !l.includes("upstream")).join("\n");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("upstream");
  });

  it("rejects proxy with malformed upstream", () => {
    const yaml = VALID_PROXY_APP.replace("127.0.0.1:3000", "not-a-valid-upstream");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("host:port");
  });

  it("rejects proxy with out-of-range upstream port", () => {
    const yaml = VALID_PROXY_APP.replace("127.0.0.1:3000", "127.0.0.1:70000");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("between 1 and 65535");
  });

  it("accepts proxy + tcp + tcpProtocol + upstream", () => {
    const yaml = `
version: 1
apps:
  - name: db
    host: db.app.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: proxy
    upstream: app-db:5432
`;
    writeConfig(tmpDir, yaml);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0] as Extract<DevrouterApp, { runtime: "proxy"; protocol: "tcp" }>;
    expect(app.runtime).toBe("proxy");
    expect(app.protocol).toBe("tcp");
    expect(app.tcpProtocol).toBe("postgres");
    expect(app.upstream).toBe("app-db:5432");
  });

  it("rejects proxy + tcp without tcpProtocol", () => {
    const yaml = VALID_PROXY_APP.replace("protocol: http", "protocol: tcp");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("tcpProtocol");
  });

  it("rejects proxy + tcp with unsupported tcpProtocol", () => {
    const yaml = VALID_PROXY_APP.replace("protocol: http", "protocol: tcp\n    tcpProtocol: mongodb");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow(
      `tcpProtocol must be one of: ${formatSupportedTcpProtocols()}`
    );
  });

  it("rejects proxy with dependencies", () => {
    const yaml = `
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
  - name: app
    host: app.localhost
    protocol: http
    runtime: proxy
    upstream: 127.0.0.1:3000
    dependencies:
      - app: db
`;
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("dependencies is not supported when runtime=proxy");
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

  it("accepts docker + tcp + redis", () => {
    const yaml = VALID_TCP_POSTGRES.replace("postgres", "redis");
    writeConfig(tmpDir, yaml);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0] as Extract<DevrouterApp, { protocol: "tcp" }>;
    expect(app.tcpProtocol).toBe("redis");
  });

  it("accepts docker + tcp + mariadb", () => {
    const yaml = VALID_TCP_POSTGRES.replace("postgres", "mariadb");
    writeConfig(tmpDir, yaml);
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0] as Extract<DevrouterApp, { protocol: "tcp" }>;
    expect(app.tcpProtocol).toBe("mariadb");
  });

  it("rejects docker + tcp + unsupported protocol", () => {
    const yaml = VALID_TCP_POSTGRES.replace("postgres", "cassandra");
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow(
      `tcpProtocol must be one of: ${formatSupportedTcpProtocols()}`
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

  it("accepts dependency reference with envMap", () => {
    const yaml = `
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
  - name: web
    host: web.localhost
    protocol: http
    runtime: docker
    dependencies:
      - app: db
        envMap:
          DATABASE_URL: DB_URL
          SHADOW_DATABASE_URL: DB_SHADOW_URL
    docker:
      service: web
      internalPort: 3000
`;
    writeConfig(tmpDir, yaml);
    const config = loadRepoConfig(tmpDir);
    expect(config.apps[1].dependencies[0].envMap).toEqual({
      DATABASE_URL: "DB_URL",
      SHADOW_DATABASE_URL: "DB_SHADOW_URL",
    });
  });

  it("rejects envMap with invalid env var names", () => {
    const yaml = `
version: 1
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: docker
    dependencies:
      - app: db
        envMap:
          bad-name: DB_URL
    docker:
      service: web
      internalPort: 3000
`;
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("not a valid environment variable name");
  });

  it("rejects envMap with invalid source env var names", () => {
    const yaml = `
version: 1
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: docker
    dependencies:
      - app: db
        envMap:
          DATABASE_URL: bad-source
    docker:
      service: web
      internalPort: 3000
`;
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("not a valid environment variable name");
  });

  it("rejects unknown keys in dependency object", () => {
    const yaml = `
version: 1
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: docker
    dependencies:
      - app: db
        unknown: true
    docker:
      service: web
      internalPort: 3000
`;
    writeConfig(tmpDir, yaml);
    expect(() => loadRepoConfig(tmpDir)).toThrow("unknown is not supported");
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

// ---- secretManager validation ----

describe("secretManager validation", () => {
  it("accepts valid secretManager config", () => {
    writeConfig(tmpDir, "version: 1\nsecretManager:\n  command: infisical run --env dev --\napps: []");
    const config = loadRepoConfig(tmpDir);
    expect(config.secretManager?.command).toBe("infisical run --env dev --");
  });

  it("omits secretManager when not configured", () => {
    writeConfig(tmpDir, "version: 1\napps: []");
    const config = loadRepoConfig(tmpDir);
    expect(config.secretManager).toBeUndefined();
  });

  it("rejects empty secretManager command", () => {
    writeConfig(tmpDir, 'version: 1\nsecretManager:\n  command: ""\napps: []');
    expect(() => loadRepoConfig(tmpDir)).toThrow("must be a non-empty string");
  });

  it("rejects unknown keys under secretManager", () => {
    writeConfig(tmpDir, "version: 1\nsecretManager:\n  command: infisical run --\n  timeout: 30\napps: []");
    expect(() => loadRepoConfig(tmpDir)).toThrow("timeout is not supported");
  });

  it("rejects secretManager.command exceeding max length", () => {
    const longCommand = "x".repeat(4097);
    writeConfig(tmpDir, `version: 1\nsecretManager:\n  command: "${longCommand}"\napps: []`);
    expect(() => loadRepoConfig(tmpDir)).toThrow("exceeds maximum length");
  });

  it("accepts secretManager with defaultEnv", () => {
    writeConfig(tmpDir, "version: 1\nsecretManager:\n  command: infisical run --env {env} --\n  defaultEnv: dev\napps: []");
    const config = loadRepoConfig(tmpDir);
    expect(config.secretManager?.command).toBe("infisical run --env {env} --");
    expect(config.secretManager?.defaultEnv).toBe("dev");
  });

  it("requires defaultEnv when command contains {env}", () => {
    writeConfig(tmpDir, "version: 1\nsecretManager:\n  command: infisical run --env {env} --\napps: []");
    expect(() => loadRepoConfig(tmpDir)).toThrow("defaultEnv is required when command contains {env}");
  });

  it("allows defaultEnv to be omitted when no {env} placeholder", () => {
    writeConfig(tmpDir, "version: 1\nsecretManager:\n  command: infisical run --env dev --\napps: []");
    const config = loadRepoConfig(tmpDir);
    expect(config.secretManager?.defaultEnv).toBeUndefined();
  });

  it("rejects defaultEnv exceeding 64 characters", () => {
    const longEnv = "a".repeat(65);
    writeConfig(tmpDir, `version: 1\nsecretManager:\n  command: infisical run --env {env} --\n  defaultEnv: ${longEnv}\napps: []`);
    expect(() => loadRepoConfig(tmpDir)).toThrow("exceeds maximum length of 64");
  });

  it("rejects defaultEnv with invalid characters", () => {
    writeConfig(tmpDir, "version: 1\nsecretManager:\n  command: infisical run --env {env} --\n  defaultEnv: dev@prod\napps: []");
    expect(() => loadRepoConfig(tmpDir)).toThrow("must be alphanumeric with hyphens");
  });

  it("preserves secretManager through save/load roundtrip", () => {
    writeConfig(tmpDir, "version: 1\nsecretManager:\n  command: doppler run --\napps:\n  - name: web\n    host: web.localhost\n    protocol: http\n    runtime: docker\n    docker:\n      service: web\n      internalPort: 3000\n");
    const config = loadRepoConfig(tmpDir);
    expect(config.secretManager?.command).toBe("doppler run --");
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

  it("rejects unsupported tcpProtocol in app add options", () => {
    expect(() =>
      upsertRepoApp(tmpDir, {
        ...baseOptions,
        protocol: "tcp",
        tcpProtocol: "mongodb",
      })
    ).toThrow(`--tcp-protocol must be one of: ${formatSupportedTcpProtocols()}`);
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

  // Regression: add/rm must not round-trip the whole file through the serializer
  // (which strips comments, reorders apps, and injects empty `dependencies: []`).
  const COMMENTED_CONFIG = `version: 1
project:
  name: demo

# psql needs sslnegotiation=direct for TLS/SNI multiplexing on :5432
apps:
  - name: db
    host: db.localhost
    protocol: tcp
    tcpProtocol: postgres # SNI-routed
    runtime: docker
    docker:
      service: db
      internalPort: 5432

  # api serves the public REST surface
  - name: api
    host: api.localhost
    protocol: http
    runtime: docker
    docker:
      service: api
      internalPort: 3000
`;

  it("preserves comments and app order when adding an app", () => {
    writeConfig(tmpDir, COMMENTED_CONFIG);
    upsertRepoApp(tmpDir, {
      ...baseOptions,
      name: "web",
      host: "web.localhost",
      service: "web",
    });
    const raw = readConfig(tmpDir);
    expect(raw).toContain("# psql needs sslnegotiation=direct for TLS/SNI multiplexing on :5432");
    expect(raw).toContain("tcpProtocol: postgres # SNI-routed");
    // Existing apps keep their order; the new app is appended last.
    expect(raw.indexOf("name: db")).toBeLessThan(raw.indexOf("name: api"));
    expect(raw.indexOf("name: api")).toBeLessThan(raw.indexOf("name: web"));
  });

  it("does not inject empty dependencies: []", () => {
    writeConfig(tmpDir, COMMENTED_CONFIG);
    upsertRepoApp(tmpDir, {
      ...baseOptions,
      name: "web",
      host: "web.localhost",
      service: "web",
    });
    expect(readConfig(tmpDir)).not.toContain("dependencies:");
  });

  it("preserves comments on untouched apps when removing one", () => {
    writeConfig(tmpDir, COMMENTED_CONFIG);
    const { removed } = removeRepoApp(tmpDir, "api");
    expect(removed).toBe(true);
    const raw = readConfig(tmpDir);
    expect(raw).toContain("# psql needs sslnegotiation=direct for TLS/SNI multiplexing on :5432");
    expect(raw).toContain("tcpProtocol: postgres # SNI-routed");
    expect(raw).not.toContain("name: api");
    // The removal is still reflected in the parsed config.
    expect(loadRepoConfig(tmpDir).apps.map((a) => a.name)).toEqual(["db"]);
  });

  it("keeps the comment above an app when that app is updated in place", () => {
    writeConfig(tmpDir, COMMENTED_CONFIG);
    upsertRepoApp(tmpDir, {
      ...baseOptions,
      name: "api",
      host: "api.localhost",
      service: "api",
      port: 4000,
    });
    const raw = readConfig(tmpDir);
    expect(raw).toContain("# api serves the public REST surface");
    // The update is applied (port changed) without reordering.
    expect(raw.indexOf("name: db")).toBeLessThan(raw.indexOf("name: api"));
    const api = loadRepoConfig(tmpDir).apps.find((a) => a.name === "api");
    expect(api && api.kind !== "dependency" && api.runtime === "docker" && api.docker.internalPort).toBe(4000);
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

// ---- workspace templating + applyWorkspace ----

describe("workspace templating (parse)", () => {
  it("accepts ${WORKSPACE} in a proxy upstream", () => {
    writeConfig(
      tmpDir,
      `version: 1
apps:
  - name: app
    host: app.localhost
    protocol: http
    runtime: proxy
    upstream: \${WORKSPACE}-app:3000
`
    );
    const config = loadRepoConfig(tmpDir);
    const app = config.apps[0];
    expect(app.kind !== "dependency" && app.runtime === "proxy" && app.upstream).toBe("${WORKSPACE}-app:3000");
  });

  it("rejects ${WORKSPACE} in host", () => {
    writeConfig(
      tmpDir,
      `version: 1
apps:
  - name: app
    host: \${WORKSPACE}.app.localhost
    protocol: http
    runtime: proxy
    upstream: app:3000
`
    );
    expect(() => loadRepoConfig(tmpDir)).toThrow(/must not contain template placeholders/);
  });

  it("rejects a malformed upstream template", () => {
    writeConfig(
      tmpDir,
      `version: 1
apps:
  - name: app
    host: app.localhost
    protocol: http
    runtime: proxy
    upstream: \${WORKSPACE}-app
`
    );
    expect(() => loadRepoConfig(tmpDir)).toThrow(/valid host:port template/);
  });
});

describe("applyWorkspace", () => {
  const baseConfig: DevrouterConfig = {
    version: 1,
    project: { name: "myapp" },
    apps: [
      {
        name: "web",
        host: "web.localhost",
        protocol: "http",
        runtime: "docker",
        dependencies: [],
        docker: { service: "web", internalPort: 3000, composeFiles: ["docker-compose.yml"] },
      },
      {
        name: "api",
        host: "api.localhost",
        protocol: "http",
        runtime: "proxy",
        dependencies: [],
        upstream: "${WORKSPACE}-api:4000",
      } as DevrouterApp,
    ],
  };

  it("namespaces hosts, substitutes upstream, and uniquifies docker router when a workspace is active", () => {
    const result = applyWorkspace(baseConfig, "feat-x", "/repo/myapp");
    const web = result.apps[0];
    const api = result.apps[1];
    expect(web.kind !== "dependency" && web.host).toBe("web.feat-x.localhost");
    expect(web.kind !== "dependency" && web.runtime === "docker" && web.docker.router).toBe("web-feat-x");
    expect(api.kind !== "dependency" && api.host).toBe("api.feat-x.localhost");
    expect(api.kind !== "dependency" && api.runtime === "proxy" && api.upstream).toBe("feat-x-api:4000");
  });

  it("does not mutate the input config", () => {
    const snapshot = JSON.parse(JSON.stringify(baseConfig));
    applyWorkspace(baseConfig, "feat-x", "/repo/myapp");
    expect(baseConfig).toEqual(snapshot);
  });

  it("with no workspace: keeps bare hosts but resolves ${WORKSPACE} to the project name", () => {
    const result = applyWorkspace(baseConfig, undefined, "/repo/myapp");
    const web = result.apps[0];
    const api = result.apps[1];
    expect(web.kind !== "dependency" && web.host).toBe("web.localhost"); // unchanged
    expect(web.kind !== "dependency" && web.runtime === "docker" && web.docker.router).toBeUndefined(); // unchanged
    expect(api.kind !== "dependency" && api.runtime === "proxy" && api.upstream).toBe("myapp-api:4000");
  });

  it("is a structural no-op for a config with no templates and no workspace", () => {
    const noTemplate: DevrouterConfig = {
      version: 1,
      apps: [
        {
          name: "web",
          host: "web.localhost",
          protocol: "http",
          runtime: "docker",
          dependencies: [],
          docker: { service: "web", internalPort: 3000, composeFiles: ["docker-compose.yml"] },
        },
      ],
    };
    expect(applyWorkspace(noTemplate, undefined, "/repo/myapp")).toEqual(noTemplate);
  });
});

describe("resolveAppByName + workspace (B1 data path)", () => {
  afterEach(() => {
    delete process.env.DEVROUTER_WORKSPACE;
  });

  it("returns a namespaced host so the TLS coverage list carries the workspace host", () => {
    writeConfig(
      tmpDir,
      `version: 1
project:
  name: myapp
apps:
  - name: web
    host: web.localhost
    protocol: http
    runtime: proxy
    upstream: \${WORKSPACE}-web:3000
`
    );
    process.env.DEVROUTER_WORKSPACE = "feat-x";
    const { config, app, workspace } = resolveAppByName(tmpDir, "web");
    expect(workspace).toBe("feat-x");
    expect(app.kind !== "dependency" && app.host).toBe("web.feat-x.localhost");
    expect(app.kind !== "dependency" && app.runtime === "proxy" && app.upstream).toBe("feat-x-web:3000");
    // The hosts the run path feeds to mkcert come from this same config.
    expect(config.apps.map((a) => (a.kind !== "dependency" ? a.host : undefined))).toContain(
      "web.feat-x.localhost"
    );
  });
});

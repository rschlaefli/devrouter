import { describe, expect, it } from "vitest";
import type {
  DevrouterDockerDependencyApp,
  DevrouterDockerHttpApp,
  DevrouterDockerTcpApp,
  DevrouterHostHttpApp
} from "../../types";
import {
  applyDependencyEnvMap,
  buildDependencyEnv,
  planDependencyRuntime,
  planDependencyStart
} from "../dependency-runtime-plan";

const HOST_APP: DevrouterHostHttpApp = {
  name: "web",
  host: "web.localhost",
  protocol: "http",
  runtime: "host",
  dependencies: [],
  hostRun: {
    command: "pnpm dev",
    cwd: ".",
    strategy: {
      type: "auto",
      denyPorts: [80, 443, 5432],
      allowPortRange: "1024-65535"
    }
  }
};

const POSTGRES_DEP: DevrouterDockerTcpApp = {
  name: "db",
  host: "db.localhost",
  protocol: "tcp",
  tcpProtocol: "postgres",
  runtime: "docker",
  dependencies: [],
  docker: {
    service: "db",
    internalPort: 5432,
    composeFiles: ["docker-compose.yml"]
  }
};

const ANALYTICS_DEP: DevrouterDockerTcpApp = {
  ...POSTGRES_DEP,
  name: "analytics-db",
  host: "analytics-db.localhost",
  docker: {
    ...POSTGRES_DEP.docker,
    service: "analytics-db"
  }
};

const DOCKER_APP: DevrouterDockerHttpApp = {
  name: "web-docker",
  host: "web-docker.localhost",
  protocol: "http",
  runtime: "docker",
  dependencies: [],
  docker: {
    service: "app",
    internalPort: 3000,
    composeFiles: ["docker-compose.yml"]
  }
};

const REDIS_DEP: DevrouterDockerDependencyApp = {
  kind: "dependency",
  name: "redis",
  runtime: "docker",
  dependencies: [],
  docker: {
    service: "redis",
    composeFiles: ["docker-compose.yml"]
  }
};

describe("dependency runtime planning", () => {
  it("plans host TCP dependencies and envMap aliases", () => {
    const app = {
      ...HOST_APP,
      dependencies: [
        {
          app: POSTGRES_DEP.name,
          envMap: {
            DATABASE_URL: "DB_URL",
            SHADOW_DATABASE_URL: "DB_SHADOW_URL"
          }
        }
      ]
    };
    const runtimePlan = planDependencyRuntime({
      app,
      dependencies: [POSTGRES_DEP]
    });

    expect(runtimePlan.selectedDockerApps).toEqual([POSTGRES_DEP]);
    expect(runtimePlan.services).toEqual(["db"]);
    expect(runtimePlan.dependencyServices).toEqual(["db"]);
    expect(runtimePlan.hasTcpDeps).toBe(true);
    expect(runtimePlan.shouldPromptForDependencies).toBe(true);

    const startPlan = planDependencyStart(runtimePlan, true);
    expect(startPlan.shouldRunComposeUp).toBe(true);
    expect(startPlan.startedServices).toEqual(["db"]);
    expect(startPlan.dependencyApps).toEqual(["db"]);
    expect(startPlan.ownershipWarning).toBeUndefined();

    const depEnv = applyDependencyEnvMap(
      app,
      buildDependencyEnv([{ app: POSTGRES_DEP, mappedPort: 55432 }])
    );
    expect(depEnv.DB_HOST).toBe("localhost");
    expect(depEnv.DB_PORT).toBe("55432");
    expect(depEnv.DB_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(depEnv.DB_SHADOW_URL).toBe("postgres://prisma:prisma@localhost:55432/shadow");
    expect(depEnv.DATABASE_URL).toBe("postgres://prisma:prisma@localhost:55432/prisma");
    expect(depEnv.SHADOW_DATABASE_URL).toBe("postgres://prisma:prisma@localhost:55432/shadow");
  });

  it("skips prompt and compose up when dependency services are already running", () => {
    const app = {
      ...HOST_APP,
      dependencies: [{ app: POSTGRES_DEP.name }]
    };
    const runtimePlan = planDependencyRuntime({
      app,
      dependencies: [POSTGRES_DEP],
      runningServicesBefore: {
        status: "known",
        runningServices: new Set(["db"])
      }
    });

    expect(runtimePlan.allDependencyServicesRunning).toBe(true);
    expect(runtimePlan.shouldPromptForDependencies).toBe(false);

    const startPlan = planDependencyStart(runtimePlan, false);
    expect(startPlan.shouldRunComposeUp).toBe(false);
    expect(startPlan.startedServices).toEqual([]);
    expect(startPlan.dependencyApps).toEqual([]);
  });

  it("plans exec teardown for only services that were not already running", () => {
    const app = {
      ...HOST_APP,
      dependencies: [{ app: POSTGRES_DEP.name }, { app: ANALYTICS_DEP.name }]
    };
    const runtimePlan = planDependencyRuntime({
      app,
      dependencies: [POSTGRES_DEP, ANALYTICS_DEP],
      stopPolicy: "stop-only-newly-started",
      runningServicesBefore: {
        status: "known",
        runningServices: new Set(["db"])
      }
    });

    const startPlan = planDependencyStart(runtimePlan, true);
    expect(startPlan.shouldRunComposeUp).toBe(true);
    expect(startPlan.startedServices).toEqual(["analytics-db"]);
    expect(startPlan.ownershipWarning).toBeUndefined();
  });

  it("keeps exec-started services running when ownership detection is unknown", () => {
    const app = {
      ...HOST_APP,
      dependencies: [{ app: POSTGRES_DEP.name }]
    };
    const runtimePlan = planDependencyRuntime({
      app,
      dependencies: [POSTGRES_DEP],
      stopPolicy: "stop-only-newly-started",
      runningServicesBefore: {
        status: "unknown",
        reason: "docker compose ps failed"
      }
    });

    const startPlan = planDependencyStart(runtimePlan, true);
    expect(startPlan.shouldRunComposeUp).toBe(true);
    expect(startPlan.startedServices).toEqual([]);
    expect(startPlan.ownershipWarning).toContain("docker compose ps failed");
  });

  it("plans docker app targets without dependency teardown", () => {
    const runtimePlan = planDependencyRuntime({
      app: DOCKER_APP,
      dependencies: []
    });

    const startPlan = planDependencyStart(runtimePlan, false);
    expect(runtimePlan.selectedDockerApps).toEqual([DOCKER_APP]);
    expect(startPlan.shouldRunComposeUp).toBe(true);
    expect(startPlan.startedServices).toEqual(["app"]);
    expect(startPlan.dependencyApps).toEqual([]);
  });

  it("does not build env vars for dependency-only services", () => {
    const runtimePlan = planDependencyRuntime({
      app: { ...HOST_APP, dependencies: [{ app: REDIS_DEP.name }] },
      dependencies: [REDIS_DEP]
    });

    expect(runtimePlan.selectedDockerApps).toEqual([REDIS_DEP]);
    expect(runtimePlan.hasTcpDeps).toBe(false);
    expect(buildDependencyEnv([])).toEqual({});
  });

  it("throws when an envMap source is missing from dependency env", () => {
    const app = {
      ...HOST_APP,
      dependencies: [
        {
          app: POSTGRES_DEP.name,
          envMap: {
            DATABASE_URL: "MISSING"
          }
        }
      ]
    };

    expect(() => applyDependencyEnvMap(app, {})).toThrow(
      "source variable 'MISSING' not found in dependency env"
    );
  });
});

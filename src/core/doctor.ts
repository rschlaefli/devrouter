import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { listContainers } from "./docker";
import { listHostRoutes } from "./host-routes";
import { loadRuntimeConfig, resolveRepoPath, compareSemver } from "./repo-config";

declare const __VERSION__: string;
import { getRouterFileLayout, isTLSEnabled } from "./router";
import { collectRouterStatus } from "./status";
import { discoverRoutes, findDuplicateHosts } from "./routes";
import { assertPathWithinRepo } from "./paths";
import { getTLSHostCoverage } from "./tls";
import {
  findOrphanedWorkspaceProxyRoutes,
  findStaleProcessRoutes
} from "./route-state";
import { buildGlobalToolChecks } from "./tool-diagnostics";
import { buildDevcontainerChecks } from "./devcontainer-diagnostics";
import {
  DevrouterApp,
  DevrouterConfig,
  DevrouterDockerDependencyApp,
  DevrouterDockerTcpApp,
  DiagnosticCheck,
  DoctorReport
} from "../types";

type DoctorOptions = {
  repo?: string;
};

const POSTGRES_DEFAULTS = {
  POSTGRES_USER: "prisma",
  POSTGRES_PASSWORD: "prisma",
  POSTGRES_DB: "prisma"
} as const;

type PostgresCredentialMismatch = {
  appName: string;
  serviceName: string;
  composeFiles: string[];
  key: keyof typeof POSTGRES_DEFAULTS;
  actualValue: string;
  expectedValue: string;
};

type PostgresCredentialInspection = {
  mismatches: PostgresCredentialMismatch[];
  parseErrors: string[];
};

type HostCommandPrecedenceRisk = {
  appName: string;
  variables: string[];
};

type HostCommandPrecedenceInspection = {
  inspectedCount: number;
  riskyApps: HostCommandPrecedenceRisk[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseComposeEnvironment(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = entry.slice(0, separator).trim();
      const val = entry.slice(separator + 1).trim();
      if (key.length > 0) {
        env[key] = val;
      }
    }
    return env;
  }

  const objectValue = asRecord(value);
  if (!objectValue) {
    return env;
  }

  for (const [key, raw] of Object.entries(objectValue)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      env[key] = String(raw).trim();
    }
  }

  return env;
}

function isExplicitLiteralValue(value: string): boolean {
  return !value.includes("${") && !value.includes("$(");
}

function inspectPostgresCredentials(repoPath: string, config: DevrouterConfig): PostgresCredentialInspection {
  const postgresApps = config.apps.filter(
    (app): app is DevrouterDockerTcpApp =>
      app.runtime === "docker" &&
      app.kind !== "dependency" &&
      app.protocol === "tcp" &&
      app.tcpProtocol === "postgres"
  );

  const mismatches: PostgresCredentialMismatch[] = [];
  const parseErrors: string[] = [];
  const postgresKeys = Object.keys(POSTGRES_DEFAULTS) as Array<keyof typeof POSTGRES_DEFAULTS>;

  for (const app of postgresApps) {
    let serviceFound = false;
    const mergedEnv: Record<string, string> = {};

    for (const composeFile of app.docker.composeFiles) {
      let absolutePath: string;
      try {
        absolutePath = assertPathWithinRepo(composeFile, repoPath, "composeFiles");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        parseErrors.push(`${app.name}: ${composeFile} (${message})`);
        continue;
      }

      if (!fs.existsSync(absolutePath)) {
        continue;
      }

      try {
        const raw = fs.readFileSync(absolutePath, "utf-8");
        const parsed = YAML.parse(raw) as unknown;
        const root = asRecord(parsed);
        const services = asRecord(root?.services);
        const service = asRecord(services?.[app.docker.service]);
        if (!service) {
          continue;
        }
        serviceFound = true;
        Object.assign(mergedEnv, parseComposeEnvironment(service.environment));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        parseErrors.push(`${app.name}: ${composeFile} (${message})`);
      }
    }

    if (!serviceFound) {
      continue;
    }

    for (const key of postgresKeys) {
      const actualValue = mergedEnv[key];
      if (actualValue === undefined || !isExplicitLiteralValue(actualValue)) {
        continue;
      }

      const expectedValue = POSTGRES_DEFAULTS[key];
      if (actualValue !== expectedValue) {
        mismatches.push({
          appName: app.name,
          serviceName: app.docker.service,
          composeFiles: app.docker.composeFiles,
          key,
          actualValue,
          expectedValue
        });
      }
    }
  }

  return { mismatches, parseErrors };
}

function findDbAssignmentsBeforeWrapperBoundary(command: string): string[] {
  const boundary = command.search(/\brun\s+--/);
  if (boundary < 0) {
    return [];
  }

  const beforeBoundary = command.slice(0, boundary);
  const matches = Array.from(beforeBoundary.matchAll(/\b(DATABASE_URI|DATABASE_URL)\s*=/g)).map(
    (match) => match[1]
  );

  return Array.from(new Set(matches.values()));
}

function inspectHostCommandPrecedence(config: DevrouterConfig): HostCommandPrecedenceInspection {
  const byName = new Map(config.apps.map((entry) => [entry.name, entry]));
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  const dependsOnPostgres = (appName: string): boolean => {
    const cached = memo.get(appName);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(appName)) {
      return false;
    }

    const app = byName.get(appName);
    if (!app) {
      memo.set(appName, false);
      return false;
    }

    if (app.runtime === "docker" && app.kind !== "dependency" && app.protocol === "tcp" && app.tcpProtocol === "postgres") {
      memo.set(appName, true);
      return true;
    }

    visiting.add(appName);
    let result = false;
    for (const dependency of app.dependencies) {
      if (dependsOnPostgres(dependency.app)) {
        result = true;
        break;
      }
    }
    visiting.delete(appName);
    memo.set(appName, result);
    return result;
  };

  const riskyApps: HostCommandPrecedenceRisk[] = [];
  let inspectedCount = 0;

  for (const app of config.apps) {
    if (app.runtime !== "host" || app.protocol !== "http") {
      continue;
    }

    const hasPostgresDependency = app.dependencies.some((dependency) => dependsOnPostgres(dependency.app));
    if (!hasPostgresDependency) {
      continue;
    }

    inspectedCount += 1;
    const riskyVariables = findDbAssignmentsBeforeWrapperBoundary(app.hostRun.command);
    if (riskyVariables.length > 0) {
      riskyApps.push({
        appName: app.name,
        variables: riskyVariables
      });
    }
  }

  return { inspectedCount, riskyApps };
}

function addCheck(
  checks: DiagnosticCheck[],
  check: DiagnosticCheck
): void {
  checks.push(check);
}

function collectSummary(checks: DiagnosticCheck[]): DoctorReport["summary"] {
  return checks.reduce(
    (acc, check) => {
      acc[check.level] += 1;
      return acc;
    },
    { ok: 0, warn: 0, error: 0 }
  );
}

function collectNextSteps(checks: DiagnosticCheck[], statusNextSteps: string[]): string[] {
  const steps = new Set<string>();
  for (const check of checks) {
    if (check.level === "ok") {
      continue;
    }
    if (check.suggestion) {
      steps.add(check.suggestion);
    }
  }

  for (const step of statusNextSteps) {
    steps.add(step);
  }

  return Array.from(steps.values());
}

export async function buildDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DiagnosticCheck[] = [];
  const fileLayout = getRouterFileLayout();
  const resolvedRepoPath = resolveRepoPath(options.repo);
  const explicitRepo = typeof options.repo === "string" && options.repo.trim().length > 0;
  let loadedConfig: DevrouterConfig | undefined;
  let loadedWorkspace: string | undefined;

  if (fileLayout.missing.length === 0) {
    addCheck(checks, {
      id: "global.router-files",
      level: "ok",
      summary: "Global router files are present."
    });
  } else {
    addCheck(checks, {
      id: "global.router-files",
      level: "warn",
      summary: `Missing ${fileLayout.missing.length} global router file(s).`,
      details: fileLayout.missing.join(", "),
      suggestion: "Run: dev up"
    });
  }

  for (const check of buildGlobalToolChecks(resolvedRepoPath)) {
    addCheck(checks, check);
  }

  let statusNextSteps: string[] = [];
  try {
    const status = await collectRouterStatus(options.repo);
    statusNextSteps = status.insights.nextSteps;

    addCheck(checks, {
      id: "global.docker-context",
      level: "ok",
      summary: `Docker context: ${status.dockerContext}`
    });

    addCheck(checks, {
      id: "global.router-running",
      level: status.routerRunning ? "ok" : "warn",
      summary: status.routerRunning
        ? "Router container is running."
        : "Router container is not running.",
      suggestion: status.routerRunning ? undefined : "Run: dev up"
    });

    if (status.routerRunning) {
      const missingPorts: string[] = [];
      if (!status.boundPorts.web80) {
        missingPorts.push("80");
      }
      if (!status.boundPorts.web443) {
        missingPorts.push("443");
      }
      for (const [protocol, bound] of Object.entries(status.boundPorts.tcp)) {
        if (!bound) {
          missingPorts.push(`${protocol}`);
        }
      }

      const activeTcpPorts = Object.keys(status.boundPorts.tcp);
      const portSummary = ["80", "443", ...activeTcpPorts].join("/");

      addCheck(checks, {
        id: "global.port-bindings",
        level: missingPorts.length === 0 ? "ok" : "error",
        summary: missingPorts.length === 0
          ? `Router has required port bindings (${portSummary}).`
          : `Router is running but missing bound port(s): ${missingPorts.join(", ")}.`,
        suggestion: missingPorts.length === 0 ? undefined : "Restart router: dev down && dev up"
      });
    }

    addCheck(checks, {
      id: "global.devnet",
      level: status.networkExists ? "ok" : "error",
      summary: status.networkExists ? "Shared network devnet exists." : "Shared network devnet is missing.",
      suggestion: status.networkExists ? undefined : "Run: dev up"
    });

    if (status.tlsEnabled) {
      addCheck(checks, {
        id: "global.tls",
        level: "ok",
        summary: "TLS is enabled (certs + Traefik TLS config)."
      });
    } else if (status.certPresent || status.tlsConfigured) {
      addCheck(checks, {
        id: "global.tls",
        level: "warn",
        summary: "TLS is partially configured.",
        details: `certPresent=${status.certPresent}, tlsConfigured=${status.tlsConfigured}`,
        suggestion: "Run: dev tls install"
      });
    } else {
      addCheck(checks, {
        id: "global.tls",
        level: "warn",
        summary: "TLS is not enabled.",
        suggestion: "Run: dev tls install"
      });
    }

    const repo = status.repo;
    if (!repo) {
      addCheck(checks, {
        id: "repo.config",
        level: "warn",
        summary: "No .devrouter.yml found in current directory.",
        suggestion: `Run: dev repo init --repo ${resolvedRepoPath}`
      });
    } else if (!repo.exists) {
      addCheck(checks, {
        id: "repo.config",
        level: explicitRepo ? "error" : "warn",
        summary: `Missing .devrouter.yml in ${repo.path}.`,
        suggestion: `Run: dev repo init --repo ${repo.path}`
      });
    } else if (!repo.valid) {
      addCheck(checks, {
        id: "repo.config",
        level: "error",
        summary: ".devrouter.yml exists but is invalid.",
        details: repo.error,
        suggestion: "Fix config errors and re-run: dev doctor --repo <path>"
      });
    } else {
      addCheck(checks, {
        id: "repo.config",
        level: "ok",
        summary: `.devrouter.yml is valid (${repo.appCount} app(s)).`
      });

      if (repo.appCount === 0) {
        addCheck(checks, {
          id: "repo.apps",
          level: "warn",
          summary: "No apps are configured in .devrouter.yml.",
          suggestion: "Run: dev app add --name <name> --host <name>.localhost --protocol http --runtime host"
        });
      }

      const runtimeConfig = loadRuntimeConfig(repo.path);
      const config = runtimeConfig.config;
      loadedConfig = config;
      loadedWorkspace = runtimeConfig.workspace;

      const cliVersion = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";
      const configVersion = config.devrouter?.version;
      if (configVersion && cliVersion !== "0.0.0-dev" && compareSemver(configVersion, cliVersion) > 0) {
        addCheck(checks, {
          id: "repo.cli-outdated",
          level: "error",
          summary: `Installed CLI (${cliVersion}) is older than required repo version (${configVersion}).`,
          suggestion: "Upgrade CLI: npm install -g @devrouter/cli"
        });
      } else {
        addCheck(checks, {
          id: "repo.cli-outdated",
          level: "ok",
          summary: "Installed CLI version is compatible with repo configuration."
        });
      }

      const appNames = new Set(config.apps.map((app) => app.name));
      const missingDependencies = config.apps.flatMap((app) =>
        app.dependencies
          .filter((dependency) => !appNames.has(dependency.app))
          .map((dependency) => `${app.name}->${dependency.app}`)
      );
      addCheck(checks, {
        id: "repo.dependencies",
        level: missingDependencies.length === 0 ? "ok" : "error",
        summary: missingDependencies.length === 0
          ? "All app dependencies resolve to configured app names."
          : `Missing dependency target(s): ${missingDependencies.join(", ")}.`,
        suggestion: missingDependencies.length === 0 ? undefined : "Fix dependencies in .devrouter.yml"
      });

      const missingComposeFiles = config.apps
        .filter((app) => app.runtime === "docker")
        .flatMap((app) => app.docker.composeFiles.map((filePath) => ({
          app: app.name,
          filePath,
          absolutePath: path.resolve(repo.path, filePath)
        })))
        .filter((entry) => !fs.existsSync(entry.absolutePath));

      addCheck(checks, {
        id: "repo.compose-files",
        level: missingComposeFiles.length === 0 ? "ok" : "error",
        summary: missingComposeFiles.length === 0
          ? "All referenced docker compose files exist."
          : `${missingComposeFiles.length} compose file reference(s) are missing.`,
        details:
          missingComposeFiles.length > 0
            ? missingComposeFiles
                .map((entry) => `${entry.app}: ${entry.filePath}`)
                .join(", ")
            : undefined,
        suggestion: missingComposeFiles.length === 0 ? undefined : "Fix docker.composeFiles paths in .devrouter.yml"
      });

      const postgresAppCount = config.apps.filter(
        (app) => app.kind !== "dependency" && app.protocol === "tcp" && app.tcpProtocol === "postgres"
      ).length;
      if (postgresAppCount > 0) {
        const inspection = inspectPostgresCredentials(repo.path, config);
        if (inspection.mismatches.length > 0) {
          const details = inspection.mismatches
            .map((mismatch) =>
              `${mismatch.appName}/${mismatch.serviceName} ${mismatch.key}=${mismatch.actualValue} (expected ${mismatch.expectedValue})`
            )
            .join(", ");
          addCheck(checks, {
            id: "repo.postgres-credentials",
            level: "warn",
            summary: `Detected ${inspection.mismatches.length} postgres credential setting(s) that differ from devrouter defaults.`,
            details,
            suggestion:
              "Align POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB with prisma defaults or override injected DATABASE_URL values. " +
              "If a persistent volume was initialized with older credentials, reconcile data or recreate volumes when safe (for example: docker compose down -v)."
          });
        } else if (inspection.parseErrors.length > 0) {
          addCheck(checks, {
            id: "repo.postgres-credentials",
            level: "warn",
            summary: "Could not fully inspect postgres credentials in compose files.",
            details: inspection.parseErrors.join(", "),
            suggestion: "Verify postgres service environment values match devrouter defaults (prisma/prisma/prisma)."
          });
        } else {
          addCheck(checks, {
            id: "repo.postgres-credentials",
            level: "ok",
            summary: "Postgres compose credentials match devrouter defaults or are not explicitly set."
          });
        }
      }

      const missingHostCwds = config.apps
        .filter((app) => app.runtime === "host")
        .map((app) => ({
          app: app.name,
          cwd: app.hostRun.cwd,
          absolutePath: path.resolve(repo.path, app.hostRun.cwd)
        }))
        .filter((entry) => !fs.existsSync(entry.absolutePath));

      addCheck(checks, {
        id: "repo.host-cwd",
        level: missingHostCwds.length === 0 ? "ok" : "error",
        summary: missingHostCwds.length === 0
          ? "All host runtime cwd paths exist."
          : `${missingHostCwds.length} host runtime cwd path(s) are missing.`,
        details:
          missingHostCwds.length > 0
            ? missingHostCwds
                .map((entry) => `${entry.app}: ${entry.cwd}`)
                .join(", ")
            : undefined,
        suggestion: missingHostCwds.length === 0 ? undefined : "Fix hostRun.cwd paths in .devrouter.yml"
      });

      const hostCommandInspection = inspectHostCommandPrecedence(config);
      if (hostCommandInspection.inspectedCount > 0) {
        const riskyCount = hostCommandInspection.riskyApps.length;
        addCheck(checks, {
          id: "repo.host-command-env-precedence",
          level: riskyCount > 0 ? "warn" : "ok",
          summary: riskyCount > 0
            ? `Detected ${riskyCount} host app command(s) with DB env assignment before a 'run --' wrapper boundary.`
            : "No risky pre-wrapper DB env assignments detected in host app commands with postgres dependencies.",
          details:
            riskyCount > 0
              ? hostCommandInspection.riskyApps
                  .map((risk) => `${risk.appName}: ${risk.variables.join(", ")}`)
                  .join(", ")
              : undefined,
          suggestion:
            riskyCount > 0
              ? "Move DB assignment after wrapper boundary (example: infisical run --env=dev -- env DATABASE_URI=${DB_URL:?missing DB_URL} pnpm dev). Then verify effective values with: dev app exec <app> --yes -- infisical run --env=<env> -- printenv DB_URL DB_SHADOW_URL DB_HOST DB_PORT"
              : undefined
        });
      }

      if (repo.tcpAppCount > 0 && !status.tlsEnabled) {
        addCheck(checks, {
          id: "repo.tcp-tls",
          level: "error",
          summary: `Repo defines ${repo.tcpAppCount} TCP app(s), but TLS is not enabled.`,
          suggestion: "Run: dev tls install"
        });
      } else if (repo.tcpAppCount > 0) {
        addCheck(checks, {
          id: "repo.tcp-tls",
          level: "ok",
          summary: `TLS is ready for ${repo.tcpAppCount} TCP app(s).`
        });
      }

      if (status.tlsEnabled) {
        try {
          const configuredHosts = config.apps
            .filter((entry): entry is Exclude<DevrouterApp, DevrouterDockerDependencyApp> => entry.kind !== "dependency")
            .map((entry) => entry.host.toLowerCase());
          const coverage = getTLSHostCoverage(configuredHosts);
          const configuredHostSet = new Set(configuredHosts);
          const uncoveredConfiguredHosts = coverage.uncoveredHosts.filter((host) =>
            configuredHostSet.has(host)
          );

          addCheck(checks, {
            id: "repo.tls-host-coverage",
            level: uncoveredConfiguredHosts.length === 0 ? "ok" : "warn",
            summary:
              uncoveredConfiguredHosts.length === 0
                ? "TLS cert covers all configured .localhost hosts."
                : `TLS cert does not cover ${uncoveredConfiguredHosts.length} configured host(s).`,
            details:
              uncoveredConfiguredHosts.length === 0
                ? undefined
                : `Uncovered: ${uncoveredConfiguredHosts.join(", ")}`,
            suggestion:
              uncoveredConfiguredHosts.length === 0
                ? undefined
                : `Run: dev app run <name> --repo ${repo.path} --yes (auto-refresh), or run: dev tls install`
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addCheck(checks, {
            id: "repo.tls-host-coverage",
            level: "warn",
            summary: "Could not evaluate TLS host coverage.",
            details: message,
            suggestion: "Run: dev tls install"
          });
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addCheck(checks, {
      id: "global.status",
      level: "error",
      summary: "Failed to collect router status diagnostics.",
      details: message
    });
  }

  for (const check of buildDevcontainerChecks(resolvedRepoPath, loadedConfig, loadedWorkspace)) {
    addCheck(checks, check);
  }

  try {
    const tlsEnabled = isTLSEnabled();
    const containers = await listContainers(true);
    const dockerRoutes = discoverRoutes(containers, tlsEnabled, "devnet").routes;
    const hostRoutes = listHostRoutes(tlsEnabled);
    const duplicates = findDuplicateHosts([...dockerRoutes, ...hostRoutes]);
    addCheck(checks, {
      id: "routes.duplicates",
      level: duplicates.length === 0 ? "ok" : "error",
      summary: duplicates.length === 0
        ? "No duplicate hostnames detected across active routes."
        : `Duplicate hostname(s): ${duplicates.join(", ")}.`,
      suggestion: duplicates.length === 0 ? undefined : "Rename hosts in .devrouter.yml so each hostname is unique"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addCheck(checks, {
      id: "routes.duplicates",
      level: "warn",
      summary: "Could not evaluate duplicate hostnames.",
      details: message
    });
  }

  const staleHostRoutes = findStaleProcessRoutes();
  const staleCount = staleHostRoutes.length;
  addCheck(checks, {
    id: "routes.stale-host-routes",
    level: staleCount === 0 ? "ok" : "warn",
    summary: staleCount === 0
      ? "No stale host route entries detected."
      : `${staleCount} stale host route entr${staleCount === 1 ? "y" : "ies"} detected (dead PID).`,
    suggestion: staleCount === 0 ? undefined : "Re-run the affected host app(s) or remove routes with: dev app rm <name> --repo <path> --keep-config"
  });

  const orphanedWorkspaceRoutes = findOrphanedWorkspaceProxyRoutes();
  addCheck(checks, {
    id: "routes.orphaned-workspace-routes",
    level: orphanedWorkspaceRoutes.length === 0 ? "ok" : "warn",
    summary: orphanedWorkspaceRoutes.length === 0
      ? "No orphaned workspace proxy routes detected."
      : `${orphanedWorkspaceRoutes.length} orphaned workspace proxy route entr${orphanedWorkspaceRoutes.length === 1 ? "y" : "ies"} detected (worktree removed without 'dev workspace down').`,
    suggestion:
      orphanedWorkspaceRoutes.length === 0
        ? undefined
        : "Run: dev workspace down <workspace>"
  });

  const summary = collectSummary(checks);
  const nextSteps = collectNextSteps(checks, statusNextSteps);

  return {
    generatedAt: new Date().toISOString(),
    repoPath: resolvedRepoPath,
    summary,
    checks,
    nextSteps
  };
}

import fs from "node:fs";
import path from "node:path";
import type { DevrouterApp, DevrouterConfig, DiagnosticCheck, DoctorReport } from "../types";
import { WORKSPACE_PLACEHOLDER } from "./capabilities";
import { buildDoctorReport } from "./doctor";
import { probeHttpRoute } from "./http-route-probe";
import { applyWorkspace, loadRepoConfig, loadRuntimeConfig, resolveRepoPath } from "./repo-config";
import { proxyAppsFromConfig, replacePublishedProxyRoutes } from "./route-publication";
import { TCP_PROTOCOL_REGISTRY } from "./router";
import { tlsSetupCommand } from "./tls";

type VerifySummary = DoctorReport["summary"];

export type DevcontainerVerifyEvidence = {
  doctorSummary: VerifySummary;
  blockingDoctorChecks: string[];
  proxyApps: Array<{
    name: string;
    protocol: "http" | "tcp";
    host: string;
    upstream: string;
  }>;
  workspacePreview?: Array<{
    name: string;
    host: string;
    upstream?: string;
  }>;
  liveRoutes?: Array<{
    name: string;
    host: string;
    status: "registered" | "reachable" | "failed";
    details?: string;
  }>;
};

export type DevcontainerVerifyReport = {
  generatedAt: string;
  repoPath: string;
  live: boolean;
  summary: VerifySummary;
  checks: DiagnosticCheck[];
  evidence: DevcontainerVerifyEvidence;
  nextSteps: string[];
};

type VerifyOptions = {
  repo?: string;
  live?: boolean;
  yes?: boolean;
};

type RoutedApp = Exclude<DevrouterApp, { kind: "dependency" }>;
type ProxyApp = Extract<RoutedApp, { runtime: "proxy" }>;

function collectSummary(checks: DiagnosticCheck[]): VerifySummary {
  return checks.reduce(
    (acc, check) => {
      acc[check.level] += 1;
      return acc;
    },
    { ok: 0, warn: 0, error: 0 },
  );
}

function collectNextSteps(checks: DiagnosticCheck[]): string[] {
  const steps = new Set<string>();
  for (const check of checks) {
    if (check.level !== "ok" && check.suggestion) {
      steps.add(check.suggestion);
    }
  }
  return Array.from(steps.values());
}

function proxyApps(config: DevrouterConfig | undefined): ProxyApp[] {
  return (config?.apps ?? []).filter(
    (app): app is ProxyApp => app.kind !== "dependency" && app.runtime === "proxy",
  );
}

function routedApps(config: DevrouterConfig): RoutedApp[] {
  return config.apps.filter((app): app is RoutedApp => app.kind !== "dependency");
}

function requiredFileChecks(repoPath: string): DiagnosticCheck {
  const required = [
    ".devcontainer/devcontainer.json",
    ".devcontainer/docker-compose.yml",
    ".devrouter.yml",
  ];
  const missing = required.filter((fileName) => !fs.existsSync(path.join(repoPath, fileName)));
  return {
    id: "repo.devcontainer.verify-files",
    level: missing.length === 0 ? "ok" : "error",
    summary:
      missing.length === 0
        ? "Required devcontainer/devrouter files are present."
        : `Missing required devcontainer/devrouter file(s): ${missing.join(", ")}.`,
    suggestion:
      missing.length === 0 ? undefined : "Run: devrouter repo devcontainer write --dry-run --json",
  };
}

function proxyConfigCheck(apps: ProxyApp[]): DiagnosticCheck {
  return {
    id: "repo.devcontainer.verify-proxy-apps",
    level: apps.length > 0 ? "ok" : "error",
    summary:
      apps.length > 0
        ? `Found ${apps.length} proxy app(s) for devcontainer routing.`
        : "No proxy app entries found for devcontainer routing.",
    suggestion:
      apps.length > 0
        ? undefined
        : "Add runtime: proxy app entries to .devrouter.yml or run: devrouter repo devcontainer write --dry-run --json",
  };
}

function workspaceTemplateCheck(apps: ProxyApp[]): DiagnosticCheck {
  const templated = apps.filter((app) => app.upstream.includes(WORKSPACE_PLACEHOLDER));
  return {
    id: "repo.devcontainer.verify-workspace-upstreams",
    level: apps.length > 0 && templated.length === apps.length ? "ok" : "warn",
    summary:
      apps.length === 0
        ? "No proxy upstreams to inspect for workspace templating."
        : templated.length === apps.length
          ? "All proxy upstreams use the ${WORKSPACE} placeholder."
          : `${apps.length - templated.length} proxy upstream(s) do not use the \${WORKSPACE} placeholder.`,
    details:
      apps.length > 0 && templated.length !== apps.length
        ? apps
            .filter((app) => !app.upstream.includes(WORKSPACE_PLACEHOLDER))
            .map((app) => app.name)
            .join(", ")
        : undefined,
    suggestion:
      apps.length > 0 && templated.length !== apps.length
        ? "Use ${WORKSPACE} in devcontainer proxy upstreams so parallel worktrees do not collide."
        : undefined,
  };
}

function workspacePreview(
  repoPath: string,
  config: DevrouterConfig,
): DevcontainerVerifyEvidence["workspacePreview"] {
  const preview = applyWorkspace(config, "verify", repoPath);
  return routedApps(preview).map((app) => ({
    name: app.name,
    host: app.host,
    upstream: app.runtime === "proxy" ? app.upstream : undefined,
  }));
}

function workspacePreviewCheck(
  preview: DevcontainerVerifyEvidence["workspacePreview"],
): DiagnosticCheck {
  const missingNamespacedHosts = (preview ?? []).filter(
    (app) => !app.host.endsWith(".verify.localhost"),
  );
  return {
    id: "repo.devcontainer.verify-workspace-preview",
    level: (preview ?? []).length > 0 && missingNamespacedHosts.length === 0 ? "ok" : "warn",
    summary:
      (preview ?? []).length === 0
        ? "No routed app entries found for workspace preview."
        : missingNamespacedHosts.length === 0
          ? "Workspace preview namespaces configured hosts without rewriting .devrouter.yml."
          : `${missingNamespacedHosts.length} workspace preview host(s) were not namespaced.`,
    details:
      missingNamespacedHosts.length > 0
        ? missingNamespacedHosts.map((app) => `${app.name}: ${app.host}`).join(", ")
        : undefined,
    suggestion:
      missingNamespacedHosts.length > 0
        ? "Use valid .localhost hosts and let devrouter namespace them at runtime."
        : undefined,
  };
}

function blockingDoctorChecks(doctor: DoctorReport): DiagnosticCheck[] {
  return doctor.checks.filter(
    (check) =>
      check.level === "error" &&
      (check.id.startsWith("repo.devcontainer") ||
        check.id === "repo.config" ||
        check.id === "repo.tcp-tls" ||
        check.id === "global.devnet"),
  );
}

function doctorGateCheck(doctor: DoctorReport): DiagnosticCheck {
  const blocking = blockingDoctorChecks(doctor);
  return {
    id: "repo.devcontainer.verify-doctor",
    level: blocking.length === 0 ? "ok" : "error",
    summary:
      blocking.length === 0
        ? "Doctor has no blocking devcontainer diagnostics."
        : `Doctor reported ${blocking.length} blocking devcontainer diagnostic(s).`,
    details: blocking.length > 0 ? blocking.map((check) => check.id).join(", ") : undefined,
    suggestion: blocking.length > 0 ? "Run: devrouter doctor --repo <path> --json" : undefined,
  };
}

async function liveChecks(
  repoPath: string,
  yes: boolean,
): Promise<{
  checks: DiagnosticCheck[];
  routes: DevcontainerVerifyEvidence["liveRoutes"];
}> {
  if (!yes) {
    return {
      routes: [],
      checks: [
        {
          id: "repo.devcontainer.verify-live-confirmation",
          level: "error",
          summary: "Live devcontainer verification requires --yes.",
          suggestion: "Run: devrouter repo devcontainer verify --live --yes --json",
        },
      ],
    };
  }

  let runtime: ReturnType<typeof loadRuntimeConfig>;
  try {
    runtime = loadRuntimeConfig(repoPath);
  } catch (error) {
    return {
      routes: [],
      checks: [
        {
          id: "repo.devcontainer.verify-live-config",
          level: "error",
          summary: "Could not load runtime config for live verification.",
          details: error instanceof Error ? error.message : String(error),
          suggestion:
            "Fix .devrouter.yml and re-run: devrouter repo devcontainer verify --live --yes --json",
        },
      ],
    };
  }
  let apps: ProxyApp[];
  try {
    apps = proxyAppsFromConfig(runtime.config);
    await replacePublishedProxyRoutes(repoPath, runtime.config, runtime.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      routes: [],
      checks: [
        {
          id: "repo.devcontainer.verify-live-routes",
          level: "error",
          summary: "Could not publish proxy routes for live verification.",
          details: message,
          suggestion: `Run: ${tlsSetupCommand(repoPath)}, start the devcontainer, then retry live verification.`,
        },
      ],
    };
  }
  const checks: DiagnosticCheck[] = [];
  const routes: DevcontainerVerifyEvidence["liveRoutes"] = [];
  for (const app of apps) {
    try {
      if (app.protocol === "http") {
        const curl = probeHttpRoute(app.host, { repoPath });
        routes.push({
          name: app.name,
          host: app.host,
          status: curl.ok ? "reachable" : "failed",
          details: curl.details,
        });
        checks.push({
          id: `repo.devcontainer.verify-live-http.${app.name}`,
          level: curl.ok ? "ok" : "error",
          summary: curl.ok
            ? `HTTP proxy route '${app.name}' responded.`
            : `HTTP proxy route '${app.name}' did not respond.`,
          details: curl.ok ? undefined : curl.details,
          suggestion: curl.ok
            ? undefined
            : "Start the devcontainer app process, then re-run live verification.",
        });
      } else {
        routes.push({
          name: app.name,
          host: app.host,
          status: "registered",
          details: `${app.tcpProtocol} route registered on port ${String(TCP_PROTOCOL_REGISTRY[app.tcpProtocol]?.port ?? 5432)}.`,
        });
        checks.push({
          id: `repo.devcontainer.verify-live-tcp.${app.name}`,
          level: "ok",
          summary: `TCP proxy route '${app.name}' registered.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      routes.push({
        name: app.name,
        host: app.host,
        status: "failed",
        details: message,
      });
      checks.push({
        id: `repo.devcontainer.verify-live-route.${app.name}`,
        level: "error",
        summary: `Could not register proxy route '${app.name}'.`,
        details: message,
        suggestion: `Run: ${tlsSetupCommand(repoPath)}, start the devcontainer, then retry live verification.`,
      });
    }
  }

  return { checks, routes };
}

export async function verifyDevcontainer(
  options: VerifyOptions = {},
): Promise<DevcontainerVerifyReport> {
  const repoPath = resolveRepoPath(options.repo);
  const doctor = await buildDoctorReport({ repo: repoPath });
  const checks: DiagnosticCheck[] = [doctorGateCheck(doctor), requiredFileChecks(repoPath)];
  let config: DevrouterConfig | undefined;
  let workspaceEvidence: DevcontainerVerifyEvidence["workspacePreview"];
  let apps: ProxyApp[] = [];

  try {
    config = loadRepoConfig(repoPath);
    apps = proxyApps(config);
    workspaceEvidence = workspacePreview(repoPath, config);
    checks.push(proxyConfigCheck(apps));
    checks.push(workspaceTemplateCheck(apps));
    checks.push(workspacePreviewCheck(workspaceEvidence));
  } catch (error) {
    checks.push({
      id: "repo.devcontainer.verify-config",
      level: "error",
      summary: "Could not load .devrouter.yml for devcontainer verification.",
      details: error instanceof Error ? error.message : String(error),
      suggestion: "Fix .devrouter.yml and re-run: devrouter repo devcontainer verify --json",
    });
  }

  let liveRoutes: DevcontainerVerifyEvidence["liveRoutes"];
  if (options.live) {
    process.stderr.write(
      "Warning: 'repo devcontainer verify --live' is deprecated; use 'devrouter ensure' for reconciliation.\n",
    );
    const live = await liveChecks(repoPath, Boolean(options.yes));
    checks.push(...live.checks);
    liveRoutes = live.routes;
  }

  const summary = collectSummary(checks);
  return {
    generatedAt: new Date().toISOString(),
    repoPath,
    live: Boolean(options.live),
    summary,
    checks,
    evidence: {
      doctorSummary: doctor.summary,
      blockingDoctorChecks: blockingDoctorChecks(doctor).map((check) => check.id),
      proxyApps: apps.map((app) => ({
        name: app.name,
        protocol: app.protocol,
        host: app.host,
        upstream: app.upstream,
      })),
      workspacePreview: workspaceEvidence,
      liveRoutes,
    },
    nextSteps: collectNextSteps(checks),
  };
}

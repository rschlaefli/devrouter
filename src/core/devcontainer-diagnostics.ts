import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DevrouterApp, DevrouterConfig, DiagnosticCheck } from "../types";

type ComposeInspection = {
  aliases: string[];
  publishedPorts: string[];
  devnetExternal: boolean;
  parseError?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeWorkspaceToken(value: string): string {
  return value.replace(/\$\{WORKSPACE(?::-[^}]+)?\}/g, "${WORKSPACE}");
}

function expandAliasCandidates(value: string, workspace?: string): string[] {
  const candidates = new Set<string>([normalizeWorkspaceToken(value)]);
  const defaulted = value.replace(/\$\{WORKSPACE:-([^}]+)\}/g, "$1");
  if (defaulted !== value) {
    candidates.add(defaulted);
  }
  if (workspace) {
    const workspaceValue = value
      .replace(/\$\{WORKSPACE:-[^}]+\}/g, workspace)
      .replace(/\$\{WORKSPACE\}/g, workspace);
    candidates.add(workspaceValue);
  }
  return Array.from(candidates.values());
}

function formatPublishedPort(serviceName: string, value: unknown): string | undefined {
  if (typeof value === "string") {
    return `${serviceName}: ${value}`;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const target = record.target;
  const published = record.published;
  if (published !== undefined && target !== undefined) {
    return `${serviceName}: ${String(published)}:${String(target)}`;
  }
  if (target !== undefined) {
    return `${serviceName}: target ${String(target)}`;
  }
  return `${serviceName}: ${JSON.stringify(record)}`;
}

function upstreamHost(upstream: string): string {
  const separator = upstream.lastIndexOf(":");
  return separator > 0 ? upstream.slice(0, separator) : upstream;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "host.docker.internal";
}

function inspectCompose(composeFile: string, _workspace?: string): ComposeInspection {
  if (!fs.existsSync(composeFile)) {
    return {
      aliases: [],
      publishedPorts: [],
      devnetExternal: false,
      parseError: `.devcontainer/docker-compose.yml is missing.`,
    };
  }

  try {
    const raw = fs.readFileSync(composeFile, "utf-8");
    const parsed = YAML.parse(raw) as unknown;
    const root = asRecord(parsed);
    const services = asRecord(root?.services);
    const networks = asRecord(root?.networks);
    const devnet = asRecord(networks?.devnet);
    const external = devnet?.external;
    const devnetExternal = external === true || asRecord(external) !== undefined;
    const aliases = new Set<string>();
    const publishedPorts: string[] = [];

    for (const [serviceName, serviceValue] of Object.entries(services ?? {})) {
      const service = asRecord(serviceValue);
      if (!service) {
        continue;
      }

      if (Array.isArray(service.ports)) {
        for (const port of service.ports) {
          const formatted = formatPublishedPort(serviceName, port);
          if (formatted) {
            publishedPorts.push(formatted);
          }
        }
      }

      const networks = service.networks;
      if (Array.isArray(networks)) {
        continue;
      }

      const networkMap = asRecord(networks);
      const devnet = asRecord(networkMap?.devnet);
      for (const alias of asStringArray(devnet?.aliases)) {
        aliases.add(alias);
      }
    }

    return {
      aliases: Array.from(aliases.values()).sort(),
      publishedPorts,
      devnetExternal,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      aliases: [],
      publishedPorts: [],
      devnetExternal: false,
      parseError: message,
    };
  }
}

function routedProxyApps(
  config: DevrouterConfig | undefined,
): Array<Extract<DevrouterApp, { runtime: "proxy" }>> {
  if (!config) {
    return [];
  }

  return config.apps.filter(
    (app): app is Extract<DevrouterApp, { runtime: "proxy" }> =>
      app.kind !== "dependency" && app.runtime === "proxy",
  );
}

export function buildDevcontainerChecks(
  repoPath: string,
  config?: DevrouterConfig,
  workspace?: string,
): DiagnosticCheck[] {
  const devcontainerDir = path.join(repoPath, ".devcontainer");
  if (!fs.existsSync(devcontainerDir)) {
    return [];
  }

  const compose = inspectCompose(path.join(devcontainerDir, "docker-compose.yml"), workspace);
  const checks: DiagnosticCheck[] = [];

  if (compose.parseError) {
    checks.push({
      id: "repo.devcontainer.aliases",
      level: "warn",
      summary: "Could not inspect devcontainer devnet aliases.",
      details: compose.parseError,
      suggestion:
        "Add .devcontainer/docker-compose.yml services on the external devnet network with aliases.",
    });
  } else {
    const aliasesReady = compose.aliases.length > 0 && compose.devnetExternal;
    checks.push({
      id: "repo.devcontainer.aliases",
      level: aliasesReady ? "ok" : "warn",
      summary: aliasesReady
        ? `Found ${compose.aliases.length} devnet alias(es) on the external devnet network.`
        : compose.aliases.length > 0
          ? "Devcontainer aliases exist, but top-level devnet is not marked external."
          : "No devnet aliases found in the devcontainer compose file.",
      details:
        compose.aliases.length > 0
          ? `aliases=${compose.aliases.join(", ")}, devnetExternal=${String(compose.devnetExternal)}`
          : undefined,
      suggestion: aliasesReady
        ? undefined
        : "Attach routable devcontainer services to an external devnet network and add stable aliases.",
    });
  }

  checks.push({
    id: "repo.devcontainer.no-published-ports",
    level: compose.parseError ? "warn" : compose.publishedPorts.length === 0 ? "ok" : "error",
    summary: compose.parseError
      ? "Could not inspect devcontainer compose file for published host ports."
      : compose.publishedPorts.length === 0
        ? "Devcontainer compose file does not publish host ports."
        : `Devcontainer compose file publishes ${compose.publishedPorts.length} host port(s).`,
    details: compose.publishedPorts.length > 0 ? compose.publishedPorts.join(", ") : undefined,
    suggestion:
      compose.parseError || compose.publishedPorts.length > 0
        ? "Remove published ports and route services through devnet aliases with devrouter proxy apps."
        : undefined,
  });

  const dockerfilePath = path.join(devcontainerDir, "Dockerfile");
  const dockerfileExists = fs.existsSync(dockerfilePath);
  const dockerfile = dockerfileExists ? fs.readFileSync(dockerfilePath, "utf-8") : "";
  const devrouterArtifacts = ["@devrouter/cli", "devrouter-process"].filter((artifact) =>
    dockerfile.includes(artifact),
  );
  checks.push({
    id: "repo.devcontainer.no-devrouter-image-install",
    level: !dockerfileExists ? "warn" : devrouterArtifacts.length === 0 ? "ok" : "error",
    summary: !dockerfileExists
      ? "No .devcontainer/Dockerfile found to inspect for devrouter artifacts."
      : devrouterArtifacts.length === 0
        ? "Consumer image does not install or extract devrouter artifacts."
        : "Consumer image installs or extracts devrouter artifacts.",
    details:
      devrouterArtifacts.length > 0 ? `artifacts=${devrouterArtifacts.join(", ")}` : undefined,
    suggestion: !dockerfileExists
      ? "Inspect the consumer image definition and keep devrouter package/helper installation out of it."
      : devrouterArtifacts.length > 0
        ? "Remove devrouter package/helper installation from the Dockerfile; devrouter ensure delivers the helper at runtime."
        : undefined,
  });

  if (!config) {
    checks.push({
      id: "repo.devcontainer.upstream-alias-match",
      level: "warn",
      summary: "Cannot compare devcontainer aliases to .devrouter.yml upstreams.",
      suggestion: "Add or fix .devrouter.yml proxy entries for the devcontainer services.",
    });
    return checks;
  }

  const aliasSet = new Set(
    compose.aliases
      .flatMap((alias) => expandAliasCandidates(alias, workspace))
      .map(normalizeWorkspaceToken),
  );
  const proxyApps = routedProxyApps(config);
  const nonLoopbackUpstreams = proxyApps
    .map((app) => ({
      app: app.name,
      host: normalizeWorkspaceToken(upstreamHost(app.upstream)),
    }))
    .filter((entry) => !isLoopbackHost(entry.host));
  const missing = nonLoopbackUpstreams.filter((entry) => !aliasSet.has(entry.host));

  checks.push({
    id: "repo.devcontainer.upstream-alias-match",
    level: proxyApps.length > 0 && missing.length === 0 ? "ok" : "warn",
    summary:
      proxyApps.length === 0
        ? "No devrouter proxy apps found for the devcontainer."
        : missing.length === 0
          ? "Devrouter proxy upstreams match devcontainer devnet aliases."
          : `${missing.length} devrouter proxy upstream(s) do not match devcontainer aliases.`,
    details:
      missing.length > 0
        ? missing.map((entry) => `${entry.app}: ${entry.host}`).join(", ")
        : undefined,
    suggestion:
      proxyApps.length === 0 || missing.length > 0
        ? "Align .devrouter.yml proxy upstream hosts with .devcontainer/docker-compose.yml devnet aliases."
        : undefined,
  });

  return checks;
}

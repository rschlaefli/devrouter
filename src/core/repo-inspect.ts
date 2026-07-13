import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DevrouterApp, DiagnosticCheck } from "../types";
import { getRepoConfigPath, loadRepoConfig, resolveRepoPath } from "./repo-config";

type Confidence = "high" | "medium" | "low";

export type RepoInspection = {
  repoPath: string;
  packageManager?: {
    name: string;
    version?: string;
    source: string;
  };
  node?: {
    version?: string;
    source: string;
  };
  scripts: Array<{
    name: string;
    command: string;
    evidence: string[];
  }>;
  apps: Array<{
    name: string;
    port?: number;
    confidence: Confidence;
    evidence: string[];
  }>;
  services: Array<{
    name: string;
    kind: string;
    source: string;
    image?: string;
    ports: string[];
    hasHealthcheck: boolean;
    envNames: string[];
    confidence: Confidence;
  }>;
  env: {
    files: Array<{
      path: string;
      names: string[];
    }>;
    authLikeNames: string[];
    databaseLikeNames: string[];
  };
  devcontainer: {
    exists: boolean;
    files: string[];
  };
  devrouter: {
    exists: boolean;
    configPath: string;
    valid: boolean;
    appCount: number;
    tcpAppCount: number;
    apps: Array<{
      name: string;
      runtime: string;
      protocol?: string;
      host?: string;
    }>;
    error?: string;
  };
  agentGuidance: Array<{
    path: string;
    kind: "agents" | "claude" | "skill";
  }>;
  issues: DiagnosticCheck[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function relative(repoPath: string, filePath: string): string {
  return path.relative(repoPath, filePath) || ".";
}

function redactEnvAssignments(value: string): string {
  return value.replace(
    /(^|\s)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/g,
    "$1$2=<redacted>",
  );
}

function sanitizeDiagnosticText(value: string): string {
  return redactEnvAssignments(value)
    .replace(/\bvalue\s+'[^']+'/g, "value '<redacted>'")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "<redacted-url>");
}

function parsePackageManager(value: unknown): { name: string; version?: string } | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0) {
    return { name: trimmed };
  }
  return {
    name: trimmed.slice(0, separator),
    version: trimmed.slice(separator + 1),
  };
}

function inspectPackageManager(
  repoPath: string,
  pkg?: Record<string, unknown>,
): RepoInspection["packageManager"] {
  const packageManager = parsePackageManager(pkg?.packageManager);
  if (packageManager) {
    return {
      ...packageManager,
      source: "package.json:packageManager",
    };
  }

  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ] as const;
  for (const [fileName, name] of lockfiles) {
    if (fs.existsSync(path.join(repoPath, fileName))) {
      return { name, source: fileName };
    }
  }
  return undefined;
}

function inspectNode(
  repoPath: string,
  pkg?: Record<string, unknown>,
): RepoInspection["node"] | undefined {
  const volta = asRecord(pkg?.volta);
  if (typeof volta?.node === "string") {
    return { version: volta.node, source: "package.json:volta.node" };
  }
  const engines = asRecord(pkg?.engines);
  if (typeof engines?.node === "string") {
    return { version: engines.node, source: "package.json:engines.node" };
  }
  const nvmrc = path.join(repoPath, ".nvmrc");
  if (fs.existsSync(nvmrc)) {
    const version = fs.readFileSync(nvmrc, "utf-8").trim();
    return { version, source: ".nvmrc" };
  }
  return undefined;
}

function inspectScripts(pkg?: Record<string, unknown>): RepoInspection["scripts"] {
  const scripts = asRecord(pkg?.scripts);
  if (!scripts) {
    return [];
  }
  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, command]) => ({
      name,
      command: redactEnvAssignments(command),
      evidence: [`package.json:scripts.${name}`],
    }));
}

function inferPort(command: string): { port?: number; confidence: Confidence; evidence: string[] } {
  const patterns = [/\bPORT=(\d{2,5})\b/, /--port[=\s]+(\d{2,5})\b/, /(?:^|\s)-p\s+(\d{2,5})\b/];
  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match) {
      return {
        port: Number(match[1]),
        confidence: "high",
        evidence: [`script command: ${match[0]}`],
      };
    }
  }

  const frameworkDefaults = [
    { pattern: /\bnext\b/, port: 3000, label: "next default port" },
    { pattern: /\bvite\b/, port: 5173, label: "vite default port" },
    { pattern: /\bastro\b/, port: 4321, label: "astro default port" },
    { pattern: /\bnuxt\b/, port: 3000, label: "nuxt default port" },
  ];
  for (const entry of frameworkDefaults) {
    if (entry.pattern.test(command)) {
      return { port: entry.port, confidence: "medium", evidence: [entry.label] };
    }
  }

  return { confidence: "low", evidence: ["No explicit port detected"] };
}

function inspectAppCandidates(scripts: RepoInspection["scripts"]): RepoInspection["apps"] {
  const candidates = scripts.filter((script) =>
    /(^dev$|:dev$|dev:|^start$|web|app|serve)/.test(script.name),
  );
  return candidates.map((script) => {
    const port = inferPort(script.command);
    return {
      name:
        script.name === "dev" || script.name === "start"
          ? "app"
          : script.name.replace(/[:_]/g, "-"),
      port: port.port,
      confidence: port.confidence,
      evidence: [...script.evidence, ...port.evidence],
    };
  });
}

function configuredComposeFiles(repoPath: string): string[] {
  try {
    const config = loadRepoConfig(repoPath);
    const files = config.apps
      .filter(
        (app): app is Extract<DevrouterApp, { runtime: "docker" }> => app.runtime === "docker",
      )
      .flatMap((app) => app.docker.composeFiles)
      .filter(
        (fileName) => !path.isAbsolute(fileName) && !path.normalize(fileName).startsWith(".."),
      );
    return Array.from(new Set(files));
  } catch {
    return [];
  }
}

function composeFiles(repoPath: string): string[] {
  const candidates = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    ".devcontainer/docker-compose.yml",
    ".devcontainer/docker-compose.yaml",
    ...configuredComposeFiles(repoPath),
  ];
  return Array.from(new Set(candidates)).filter((fileName) =>
    fs.existsSync(path.join(repoPath, fileName)),
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
}

function envNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.split("=")[0]?.trim())
      .filter((entry): entry is string => Boolean(entry));
  }
  const record = asRecord(value);
  return record ? Object.keys(record).sort() : [];
}

function inferServiceKind(name: string, image?: string): { kind: string; confidence: Confidence } {
  const source = `${name} ${image ?? ""}`.toLowerCase();
  const rules = [
    ["postgres", "postgres"],
    ["redis", "redis"],
    ["mysql", "mysql"],
    ["mariadb", "mariadb"],
    ["mock-oauth2", "oidc"],
    ["oidc", "oidc"],
    ["mailhog", "mail"],
  ] as const;
  for (const [needle, kind] of rules) {
    if (source.includes(needle)) {
      return { kind, confidence: "high" };
    }
  }
  return { kind: "unknown", confidence: "low" };
}

function inspectServices(repoPath: string): RepoInspection["services"] {
  const services: RepoInspection["services"] = [];
  for (const fileName of composeFiles(repoPath)) {
    try {
      const parsed = YAML.parse(fs.readFileSync(path.join(repoPath, fileName), "utf-8")) as unknown;
      const serviceMap = asRecord(asRecord(parsed)?.services);
      for (const [name, value] of Object.entries(serviceMap ?? {})) {
        const service = asRecord(value);
        if (!service) {
          continue;
        }
        const image = typeof service.image === "string" ? service.image : undefined;
        const kind = inferServiceKind(name, image);
        services.push({
          name,
          kind: kind.kind,
          source: fileName,
          image,
          ports: stringArray(service.ports),
          hasHealthcheck: service.healthcheck !== undefined,
          envNames: envNames(service.environment),
          confidence: kind.confidence,
        });
      }
    } catch {
      services.push({
        name: "(parse-error)",
        kind: "unknown",
        source: fileName,
        ports: [],
        hasHealthcheck: false,
        envNames: [],
        confidence: "low",
      });
    }
  }
  return services;
}

function inspectEnvFiles(repoPath: string): RepoInspection["env"] {
  const files = fs
    .readdirSync(repoPath)
    .filter((fileName) => /^\.env(\.|$)/.test(fileName))
    .sort()
    .map((fileName) => {
      const content = fs.readFileSync(path.join(repoPath, fileName), "utf-8");
      const names = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
        .map((line) => line.split("=")[0]?.trim())
        .filter((name): name is string => Boolean(name))
        .sort();
      return { path: fileName, names };
    });
  const allNames = Array.from(new Set(files.flatMap((file) => file.names))).sort();
  return {
    files,
    authLikeNames: allNames.filter((name) => /(AUTH|OIDC|ISSUER|CLERK|NEXTAUTH)/i.test(name)),
    databaseLikeNames: allNames.filter((name) =>
      /(DATABASE|POSTGRES|REDIS|MYSQL|MARIADB|DB_)/i.test(name),
    ),
  };
}

function inspectDevcontainer(repoPath: string): RepoInspection["devcontainer"] {
  const dir = path.join(repoPath, ".devcontainer");
  if (!fs.existsSync(dir)) {
    return { exists: false, files: [] };
  }
  return {
    exists: true,
    files: fs
      .readdirSync(dir)
      .filter((fileName) => fs.statSync(path.join(dir, fileName)).isFile())
      .sort()
      .map((fileName) => `.devcontainer/${fileName}`),
  };
}

function inspectDevrouter(repoPath: string): RepoInspection["devrouter"] {
  const configPath = getRepoConfigPath(repoPath);
  if (!fs.existsSync(configPath)) {
    return {
      exists: false,
      configPath,
      valid: false,
      appCount: 0,
      tcpAppCount: 0,
      apps: [],
    };
  }

  try {
    const config = loadRepoConfig(repoPath);
    return {
      exists: true,
      configPath,
      valid: true,
      appCount: config.apps.length,
      tcpAppCount: config.apps.filter((app) => app.kind !== "dependency" && app.protocol === "tcp")
        .length,
      apps: config.apps.map((app) => ({
        name: app.name,
        runtime: app.runtime,
        protocol: app.kind === "dependency" ? undefined : app.protocol,
        host: app.kind === "dependency" ? undefined : app.host,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exists: true,
      configPath,
      valid: false,
      appCount: 0,
      tcpAppCount: 0,
      apps: [],
      error: sanitizeDiagnosticText(message),
    };
  }
}

function inspectAgentGuidance(repoPath: string): RepoInspection["agentGuidance"] {
  const results: RepoInspection["agentGuidance"] = [];
  for (const [fileName, kind] of [
    ["AGENTS.md", "agents"],
    ["CLAUDE.md", "claude"],
  ] as const) {
    if (fs.existsSync(path.join(repoPath, fileName))) {
      results.push({ path: fileName, kind });
    }
  }
  const skillsDir = path.join(repoPath, ".agents", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir).sort()) {
      const skillPath = path.join(skillsDir, name, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        results.push({ path: relative(repoPath, skillPath), kind: "skill" });
      }
    }
  }
  return results;
}

function buildIssues(report: Omit<RepoInspection, "issues">): DiagnosticCheck[] {
  const issues: DiagnosticCheck[] = [];
  if (!report.packageManager) {
    issues.push({
      id: "repo.package-manager.missing",
      level: "warn",
      summary: "No package manager metadata or lockfile detected.",
    });
  }
  if (!report.devcontainer.exists) {
    issues.push({
      id: "repo.devcontainer.missing",
      level: "warn",
      summary: "No .devcontainer directory found.",
    });
  }
  if (!report.devrouter.exists) {
    issues.push({
      id: "repo.devrouter.missing",
      level: "warn",
      summary: "No .devrouter.yml found.",
      suggestion: `Run: dev repo init --repo ${report.repoPath}`,
    });
  } else if (!report.devrouter.valid) {
    issues.push({
      id: "repo.devrouter.invalid",
      level: "error",
      summary: ".devrouter.yml exists but is invalid.",
      details: report.devrouter.error,
      suggestion: "Fix .devrouter.yml validation errors.",
    });
  }
  return issues;
}

export function inspectRepo(options: { repo?: string } = {}): RepoInspection {
  const repoPath = resolveRepoPath(options.repo);
  const pkg = readJson(path.join(repoPath, "package.json"));
  const scripts = inspectScripts(pkg);
  const reportWithoutIssues = {
    repoPath,
    packageManager: inspectPackageManager(repoPath, pkg),
    node: inspectNode(repoPath, pkg),
    scripts,
    apps: inspectAppCandidates(scripts),
    services: inspectServices(repoPath),
    env: inspectEnvFiles(repoPath),
    devcontainer: inspectDevcontainer(repoPath),
    devrouter: inspectDevrouter(repoPath),
    agentGuidance: inspectAgentGuidance(repoPath),
  };

  return {
    ...reportWithoutIssues,
    issues: buildIssues(reportWithoutIssues),
  };
}

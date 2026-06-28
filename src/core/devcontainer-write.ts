import fs from "node:fs";
import path from "node:path";
import { inspectRepo } from "./repo-inspect";
import { resolveRepoPath } from "./repo-config";
import type { DiagnosticCheck } from "../types";

const MANAGED_MARKER = "devrouter:managed devcontainer";

type FileAction = "create" | "update" | "conflict" | "skip" | "suggest";

export type DevcontainerFilePlan = {
  path: string;
  action: FileAction;
  reason: string;
  bytes?: number;
};

export type DevcontainerWritePlan = {
  repoPath: string;
  projectName: string;
  profile: "node-postgres";
  dryRun: boolean;
  files: DevcontainerFilePlan[];
  issues: DiagnosticCheck[];
  nextSteps: string[];
};

type PlannedFile = {
  relativePath: string;
  content: string;
  executable?: boolean;
};

type WriteOptions = {
  repo?: string;
  dryRun?: boolean;
  yes?: boolean;
  installedVersion?: string;
};

const DEFAULT_DEVROUTER_VERSION = "0.0.0";
const DEFAULT_PNPM_VERSION = "11.6.0";
const VALID_PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function sanitizeProjectName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return sanitized || "app";
}

function majorVersion(value: string | undefined, fallback: string): string {
  const match = value?.match(/(\d+)/);
  return match ? match[1] : fallback;
}

function devrouterVersion(value: string | undefined): string {
  return value && /^\d+\.\d+\.\d+$/.test(value) ? value : DEFAULT_DEVROUTER_VERSION;
}

function inferDevScript(repo: ReturnType<typeof inspectRepo>): string {
  const script =
    repo.scripts.find((entry) => entry.name === "dev") ??
    repo.scripts.find((entry) => entry.name.endsWith(":dev"));
  if (!script) {
    return "pnpm dev";
  }
  return script.name === "dev" ? "pnpm dev" : `pnpm run -- ${shellSingleQuote(script.name)}`;
}

function inferPort(repo: ReturnType<typeof inspectRepo>): number {
  return repo.apps.find((app) => app.port)?.port ?? 3000;
}

function renderDockerfile(nodeMajor: string, pnpmVersion: string): string {
  const pnpmPackageSpec = `pnpm@${pnpmVersion}`;
  return `# ${MANAGED_MARKER}
FROM node:${nodeMajor}-bookworm-slim

RUN apt-get update \\
  && apt-get install -y --no-install-recommends git ca-certificates curl procps openssl \\
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g ${shellSingleQuote(pnpmPackageSpec)}

WORKDIR /workspaces/app
`;
}

function renderCompose(projectName: string): string {
  return `# ${MANAGED_MARKER}
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: prisma
      POSTGRES_PASSWORD: prisma
      POSTGRES_DB: prisma
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U prisma -d prisma"]
      interval: 5s
      timeout: 3s
      retries: 20
    networks:
      default: {}
      devnet:
        aliases:
          - \${WORKSPACE:-${projectName}}-db
    volumes:
      - ./init-db.sh:/docker-entrypoint-initdb.d/10-create-shadow-db.sh:ro
      - pgdata:/var/lib/postgresql/data

  app:
    build:
      context: .
      dockerfile: Dockerfile
    init: true
    env_file:
      - devcontainer.env
    command: sleep infinity
    networks:
      default: {}
      devnet:
        aliases:
          - \${WORKSPACE:-${projectName}}-app
    volumes:
      - ..:/workspaces/${projectName}:cached
      - node_modules:/workspaces/${projectName}/node_modules
    working_dir: /workspaces/${projectName}
    depends_on:
      postgres:
        condition: service_healthy

networks:
  devnet:
    external: true

volumes:
  pgdata:
  node_modules:
`;
}

function renderInitDb(): string {
  return `#!/usr/bin/env bash
# ${MANAGED_MARKER}
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE DATABASE shadow'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'shadow')\\gexec
SQL
`;
}

function renderDevcontainerJson(projectName: string): string {
  return `{
  "name": "${projectName}",
  "dockerComposeFile": "docker-compose.yml",
  "service": "app",
  "workspaceFolder": "/workspaces/${projectName}",
  "postCreateCommand": "bash .devcontainer/post-create.sh",
  "postStartCommand": "bash .devcontainer/post-start.sh",
  "customizations": {
    "devrouter": {
      "managed": "${MANAGED_MARKER}"
    },
    "vscode": {
      "extensions": []
    }
  }
}
`;
}

function renderEnv(projectName: string, port: number): string {
  return `# ${MANAGED_MARKER}
WORKSPACE=${projectName}
HOST=0.0.0.0
HOSTNAME=0.0.0.0
PORT=${port}
DATABASE_URL=postgres://prisma:prisma@postgres:5432/prisma
SHADOW_DATABASE_URL=postgres://prisma:prisma@postgres:5432/shadow
`;
}

function renderPostCreate(): string {
  return `#!/usr/bin/env bash
# ${MANAGED_MARKER}
set -euo pipefail

export CI=true
export npm_config_verify_deps_before_run=false

if [ -f package.json ]; then
  pnpm install --no-frozen-lockfile
fi
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function renderPostStart(devCommand: string): string {
  return `#!/usr/bin/env bash
# ${MANAGED_MARKER}
set -euo pipefail

export CI=true
export npm_config_verify_deps_before_run=false
set -a
. .devcontainer/devcontainer.env
set +a

if pgrep -f ${shellSingleQuote(devCommand)} >/dev/null 2>&1; then
  exit 0
fi

setsid bash -lc ${shellSingleQuote(devCommand)} >/tmp/devrouter-app.log 2>&1 </dev/null &
`;
}

function renderDevrouter(projectName: string, port: number, version: string): string {
  return `# ${MANAGED_MARKER}
version: 1
devrouter:
  version: ${version}
project:
  name: ${projectName}
apps:
  - name: app
    host: ${projectName}.localhost
    protocol: http
    runtime: proxy
    upstream: \${WORKSPACE}-app:${port}

  - name: db
    host: db.${projectName}.localhost
    protocol: tcp
    tcpProtocol: postgres
    runtime: proxy
    upstream: \${WORKSPACE}-db:5432
`;
}

function renderReadme(projectName: string): string {
  return `<!-- ${MANAGED_MARKER} -->
# Devcontainer

Use this repo through the devcontainer, with devrouter providing stable local routes.

\`\`\`bash
dev setup --yes
devpod up .
dev app run app --repo . --yes
dev app run db --repo . --yes
\`\`\`

- App: https://${projectName}.localhost
- Postgres: db.${projectName}.localhost:5432 (TLS/SNI)
`;
}

function postWriteNextSteps(repoPath: string): string[] {
  const quotedRepoPath = shellSingleQuote(repoPath);
  return [
    `Run: dev setup --repo ${quotedRepoPath} --yes`,
    `Run: cd ${quotedRepoPath} && devpod up .`,
    `Run: dev app run app --repo ${quotedRepoPath} --yes`,
    `Run: dev app run db --repo ${quotedRepoPath} --yes`,
    `Optional: dev repo agents --repo ${quotedRepoPath}`
  ];
}

function issueNextSteps(issues: DiagnosticCheck[]): string[] {
  const steps = issues
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.suggestion)
    .filter((suggestion): suggestion is string => Boolean(suggestion));
  if (steps.length > 0) {
    return [...steps, "Re-run: dev repo devcontainer write --dry-run --json"];
  }
  return ["Resolve reported errors, then re-run: dev repo devcontainer write --dry-run --json"];
}

function packageManagerIssues(repo: ReturnType<typeof inspectRepo>): DiagnosticCheck[] {
  if (!repo.packageManager) {
    return [
      {
        id: "repo.devcontainer.package-manager-unknown",
        level: "warn",
        summary: "Package manager could not be detected; pnpm scaffold will be generated.",
        suggestion: "Add packageManager: pnpm@<version> to package.json or add pnpm-lock.yaml before writing."
      }
    ];
  }
  if (repo.packageManager.name !== "pnpm") {
    return [
      {
        id: "repo.devcontainer.package-manager-unsupported",
        level: "error",
        summary: `Only pnpm repositories are supported by this devcontainer scaffold; detected ${repo.packageManager.name}.`,
        details: repo.packageManager.source,
        suggestion: "Use a pnpm repo for this scaffold, or adapt the generated plan manually before writing."
      }
    ];
  }
  if (repo.packageManager.version && !VALID_PACKAGE_VERSION_RE.test(repo.packageManager.version)) {
    return [
      {
        id: "repo.devcontainer.package-manager-version-unsupported",
        level: "error",
        summary: `Unsupported pnpm version '${repo.packageManager.version}' in packageManager.`,
        details: repo.packageManager.source,
        suggestion: "Use a pinned semver packageManager value such as pnpm@11.6.0 before writing the scaffold."
      }
    ];
  }
  return [];
}

function plannedFiles(
  repoPath: string,
  version: string
): { files: PlannedFile[]; projectName: string; issues: DiagnosticCheck[] } {
  const repo = inspectRepo({ repo: repoPath });
  const projectName = sanitizeProjectName(path.basename(repo.repoPath));
  const nodeMajor = majorVersion(repo.node?.version, "24");
  const pnpmVersion =
    repo.packageManager?.name === "pnpm" && repo.packageManager.version
      ? repo.packageManager.version
      : DEFAULT_PNPM_VERSION;
  const port = inferPort(repo);
  const devCommand = inferDevScript(repo);
  const issues = packageManagerIssues(repo);

  return {
    projectName,
    issues,
    files: [
      { relativePath: ".devcontainer/Dockerfile", content: renderDockerfile(nodeMajor, pnpmVersion) },
      { relativePath: ".devcontainer/docker-compose.yml", content: renderCompose(projectName) },
      { relativePath: ".devcontainer/init-db.sh", content: renderInitDb(), executable: true },
      { relativePath: ".devcontainer/devcontainer.json", content: renderDevcontainerJson(projectName) },
      { relativePath: ".devcontainer/devcontainer.env", content: renderEnv(projectName, port) },
      { relativePath: ".devcontainer/post-create.sh", content: renderPostCreate(), executable: true },
      { relativePath: ".devcontainer/post-start.sh", content: renderPostStart(devCommand), executable: true },
      { relativePath: ".devcontainer/README.md", content: renderReadme(projectName) },
      { relativePath: ".devrouter.yml", content: renderDevrouter(projectName, port, version) }
    ]
  };
}

function classifyFile(repoPath: string, file: PlannedFile): DevcontainerFilePlan {
  const absolutePath = path.join(repoPath, file.relativePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: file.relativePath,
      action: "create",
      reason: "file is missing",
      bytes: Buffer.byteLength(file.content)
    };
  }
  const current = fs.readFileSync(absolutePath, "utf-8");
  if (!current.includes(MANAGED_MARKER)) {
    return {
      path: file.relativePath,
      action: "conflict",
      reason: "existing file is not marked as devrouter-managed"
    };
  }
  if (current === file.content) {
    return {
      path: file.relativePath,
      action: "skip",
      reason: "managed file already matches",
      bytes: Buffer.byteLength(file.content)
    };
  }
  return {
    path: file.relativePath,
    action: "update",
    reason: "managed file differs",
    bytes: Buffer.byteLength(file.content)
  };
}

function buildPlan(
  repoPath: string,
  dryRun: boolean,
  version: string
): { plan: DevcontainerWritePlan; files: PlannedFile[] } {
  const rendered = plannedFiles(repoPath, version);
  const files = rendered.files;
  const filePlans = files.map((file) => classifyFile(repoPath, file));
  const issues: DiagnosticCheck[] = [...rendered.issues];
  if (filePlans.some((file) => file.action === "conflict")) {
    issues.push({
      id: "repo.devcontainer.write-conflict",
      level: "error",
      summary: "One or more target files already exist and are not devrouter-managed.",
      suggestion: "Review the conflicts, move custom files aside, or merge the devrouter-managed section manually."
    });
  }

  filePlans.push({
    path: "AGENTS.md",
    action: "suggest",
    reason: "run dev repo agents after reviewing the scaffold"
  });

  return {
    files,
    plan: {
      repoPath,
      projectName: rendered.projectName,
      profile: "node-postgres",
      dryRun,
      files: filePlans,
      issues,
      nextSteps:
        issues.some((issue) => issue.level === "error")
          ? issueNextSteps(issues)
          : dryRun
            ? [`Review this plan, then run: dev repo devcontainer write --repo ${shellSingleQuote(repoPath)} --yes`]
            : postWriteNextSteps(repoPath)
    }
  };
}

function writeFile(repoPath: string, file: PlannedFile): void {
  const absolutePath = path.join(repoPath, file.relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, file.content, "utf-8");
  if (file.executable) {
    fs.chmodSync(absolutePath, 0o755);
  }
}

export function planDevcontainerWrite(options: WriteOptions = {}): DevcontainerWritePlan {
  const repoPath = resolveRepoPath(options.repo);
  return buildPlan(repoPath, Boolean(options.dryRun), devrouterVersion(options.installedVersion)).plan;
}

export function writeDevcontainer(options: WriteOptions = {}): DevcontainerWritePlan {
  const repoPath = resolveRepoPath(options.repo);
  const dryRun = Boolean(options.dryRun);
  const { plan, files } = buildPlan(repoPath, dryRun, devrouterVersion(options.installedVersion));

  if (dryRun || plan.issues.some((issue) => issue.level === "error")) {
    return plan;
  }
  if (!options.yes) {
    return {
      ...plan,
      issues: [
        ...plan.issues,
        {
          id: "repo.devcontainer.confirmation",
          level: "error",
          summary: "Writing devcontainer files requires --yes.",
          suggestion: `Run: dev repo devcontainer write --repo ${shellSingleQuote(repoPath)} --yes`
        }
      ],
      nextSteps: [`Run: dev repo devcontainer write --repo ${shellSingleQuote(repoPath)} --yes`]
    };
  }

  for (const file of files) {
    const classification = classifyFile(repoPath, file);
    if (classification.action === "create" || classification.action === "update") {
      writeFile(repoPath, file);
    }
  }

  return {
    ...plan,
    nextSteps: postWriteNextSteps(repoPath)
  };
}

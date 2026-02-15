import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEVROUTER_SENTINEL = "<!-- devrouter -->";
const LINEAR_WORKFLOW_SENTINEL = "<!-- devrouter-linear-workflow -->";
const AGENTS_MD = "AGENTS.md";
const DEVROUTER_SKILL_REL_PATH = ".factory/skills/devrouter/SKILL.md";
const LINEAR_SKILL_REL_PATH = ".factory/skills/linear-workflow/SKILL.md";
const LINEAR_ISSUE_TEMPLATE_REL_PATH =
  ".factory/skills/linear-workflow/references/LINEAR_ISSUE_TEMPLATE.md";
const LINEAR_MILESTONE_TEMPLATE_REL_PATH =
  ".factory/skills/linear-workflow/references/MILESTONE_PLAN_TEMPLATE.md";
const LINEAR_PROGRESS_TEMPLATE_REL_PATH =
  ".factory/skills/linear-workflow/references/PROGRESS_UPDATE_TEMPLATE.md";

// Embedded skill content — must be self-contained in the built CLI bundle.
// Keep in sync with .factory/skills/devrouter/SKILL.md in the devrouter repo.
const DEVROUTER_SKILL_CONTENT = `---
name: devrouter
description: Work with devrouter for local dev routing (HTTP + TCP/Postgres on shared ports)
user-invocable: false
---

# devrouter

Local dev routing via a shared Traefik reverse proxy. Provides stable \`*.localhost\` hostnames for HTTP apps and TCP/Postgres multiplexing on shared ports (80, 443, 5432).

## How it works

- Shared Traefik router owns host ports 80 (HTTP), 443 (HTTPS), 5432 (Postgres TCP).
- Per-repo config: \`.devrouter.yml\` (single source of truth).
- Global runtime artifacts: \`~/.config/devrouter\` (never edit manually).
- Hostnames must end with \`.localhost\` (lowercase alphanumeric + hyphens only).

## \`.devrouter.yml\` entry schema

\`\`\`yaml
version: 1
project:
  name: <string>            # optional
apps:
  - name: <string>          # unique within repo
    host: <name>.localhost
    protocol: http | tcp
    runtime: host | docker
    dependencies:            # optional
      - app: <other-name>

    # if runtime=host (protocol must be http):
    hostRun:
      command: <string>
      cwd: <string>          # relative to repo root, must not escape it
      portTimeout: 120       # seconds, optional
      strategy:
        type: auto
        denyPorts: [80, 443, 5432]
        allowPortRange: "1024-65535"

    # if runtime=docker:
    docker:
      service: <string>
      internalPort: <number>
      composeFiles: [<string>]  # relative to repo root
      router: <string>          # optional

    # if protocol=tcp:
    tcpProtocol: postgres    # required; runtime must be docker
\`\`\`

Validation rules:
- \`host\` must end with \`.localhost\`
- \`runtime=host\` supports \`protocol=http\` only
- \`protocol=tcp\` requires \`runtime=docker\` and \`tcpProtocol=postgres\`
- Unknown keys rejected (strict schema)

## Docker compose requirements

- **Healthcheck required**: every dependency service must define a \`healthcheck\`. \`docker compose up --wait\` blocks until healthy; without one, wait returns immediately.
- **No published ports**: services must not publish host ports for devrouter-owned ports (80, 443, 5432). Avoid publishing ports at all -- devrouter handles routing via Traefik.
- **Postgres credentials**: use \`POSTGRES_USER=prisma\`, \`POSTGRES_PASSWORD=prisma\`, \`POSTGRES_DB=prisma\` and create a \`shadow\` database. devrouter injects \`DATABASE_URL\` / \`SHADOW_DATABASE_URL\` with these fixed credentials.
- **Persistent volume warning**: if postgres defaults changed on an existing volume, reconcile credentials/data or recreate volumes when safe (for example \`docker compose down -v\`).

Example healthcheck:
\`\`\`yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U prisma -d prisma"]
  interval: 5s
  timeout: 3s
  retries: 20
\`\`\`

## Env var injection

When a host app depends on a TCP/Postgres Docker service, \`dev app run\` and \`dev app exec\` inject:

| Variable | Value |
|---|---|
| \`<UPPER_NAME>_HOST\` | \`localhost\` |
| \`<UPPER_NAME>_PORT\` | random mapped port |
| \`DATABASE_URL\` | \`postgres://prisma:prisma@localhost:<port>/prisma\` (postgres deps only) |
| \`SHADOW_DATABASE_URL\` | \`postgres://prisma:prisma@localhost:<port>/shadow\` (postgres deps only) |

Host apps also receive \`PORT\` (random free port), \`HOSTNAME=0.0.0.0\`, \`HOST=0.0.0.0\`.

\`dev app exec --env-map TARGET=SOURCE\` applies deterministic alias mapping after dependency env injection (for example \`DATABASE_URI=DATABASE_URL\`).

## Secret manager interop (Infisical/Doppler)

- Prefer argv-safe command forms. Do not wrap \`infisical run\` or \`doppler run\` in \`sh -lc\` unless shell expansion is strictly required.
- Canonical Infisical migrate command:
\`dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate\`
- Canonical Infisical seed command:
\`dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload seed\`
- Canonical env probe command (run before migrate/seed):
\`dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL\`
- Canonical Doppler migrate command:
\`dev app exec <app> --yes --env-map DATABASE_URI=DATABASE_URL -- doppler run -- pnpm payload migrate\`
- Precedence best practice: avoid defining local \`DATABASE_URL\` / \`DATABASE_URI\` in Infisical/Doppler when you expect devrouter local DB injection.
- Precedence best practice: store remote/prod URLs under non-conflicting names (for example \`PROD_DATABASE_URL\`) and map intentionally in app config/scripts.
- Precedence best practice: if secret manager must define \`DATABASE_URL\`, run the env probe and verify values before any migration/seed.
- \`dev app run\` does not currently expose \`--env-map\`; if an app only accepts \`DATABASE_URI\`, prefer app-level fallback (\`DATABASE_URI\` then \`DATABASE_URL\`) or a small repo-local wrapper script.
- Use \`dev app exec --shell -- "<single command string>"\` only when shell expansion is required.
- \`--env-map\` fails fast when SOURCE is missing so migrations do not run with partial mapping.

## Upgrade handling (required)

- Always read the upstream devrouter release guidance at \`https://github.com/rolandhordos/devrouter/blob/main/CHANGELOG.md\` before applying devrouter changes to a repository.
- Treat the latest release section's **Agent Adaptation Prompt** in that upstream changelog as the canonical upgrade checklist.
- This is devrouter release guidance and does not require creating a \`CHANGELOG.md\` in the target repository unless that repository already has its own policy.
- Do not assume user-provided instructions include all required adaptation steps.
- Verify CLI version with \`dev --version\`, then align commands/workflows/docs to that version.
- After upgrading the CLI in a dependent repo, refresh discoverability artifacts with \`dev repo agents\` (or \`dev init --write-agents --write-skill\`).
- Re-run validation after upgrade: \`dev doctor --repo .\`, \`dev app ls --repo .\`, one representative \`dev app exec\` flow, and \`dev ls\`.

## Optional Linear workflow bootstrap

- To add Linear task-management workflow assets to a repo, run:
  - \`dev init --with-linear --write-agents --write-skill\`, or
  - \`dev repo agents --with-linear\`
- This writes \`.factory/skills/linear-workflow/SKILL.md\` and reference templates, plus an idempotent AGENTS section for milestone planning in Linear.

## Commands

- \`dev init [--write-agents] [--write-skill] [--with-linear]\`: print AI onboarding prompt (non-mutating by default)
- \`dev up\` / \`dev down\`: start/stop shared Traefik router
- \`dev status\`: router/container/network/TLS health
- \`dev doctor [--repo .]\`: deep diagnostics (global + repo)
- \`dev ls\`: list active HTTP + TCP routes
- \`dev open <name>\`: open HTTP route or print TCP connection hint (matches app name, then service/container/host identities)
- \`dev logs [-f]\`: Traefik access logs
- \`dev tls install\`: install mkcert certs, enable HTTPS + TCP/SNI
- \`dev repo init\`: create \`.devrouter.yml\`
- \`dev repo agents [--with-linear]\`: write devrouter section in AGENTS.md + install this skill (and optional Linear workflow assets)
- \`dev app add\`: add/update app entry in \`.devrouter.yml\`
- \`dev app ls\`: list app entries
- \`dev app run <name>\`: run app with dependency lifecycle
- \`dev app exec <name> [--shell] [--env-map TARGET=SOURCE] -- <cmd>\`: one-shot command with resolved dep env
- \`dev app rm <name>\`: remove app entry

## Validation workflow

1. \`dev up\` -- ensure shared router is running
2. For TCP/Postgres repos: \`dev tls install\`
3. \`dev doctor --repo .\` -- check global + repo health
4. \`dev app ls --repo .\` -- verify entries match expectations
5. \`dev app run <host-app> --repo . --yes\` -- start target app with deps
6. \`dev ls\` -- confirm routes are exposed
7. \`curl -I https://<host>.localhost\` -- HTTP reachability
8. For TCP/Postgres: use \`dev open <name>\` for connection hint

## Runtime behavior notes

- \`dev app run\` auto-starts Docker dependencies, waits for health, stops them on exit.
- Host-runtime dependencies are NOT auto-started (v1).
- Postgres on shared \`:5432\` requires TLS/SNI (\`dev tls install\`). Standard app clients should use the injected random port instead.
- \`dev app exec\` follows the same dep lifecycle for one-shot commands and preserves argv semantics by default (\`shell: false\`).
- \`dev app exec --shell\` is explicit and requires exactly one command string after \`--\`.
- Secret-manager overlap caveat: if Infisical/Doppler defines DB vars too, probe effective env (\`printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT\`) before migrate/seed.
`;

// Embedded linear workflow assets — optional, written only with --with-linear.
const LINEAR_WORKFLOW_SKILL_CONTENT = `---
name: linear-workflow
description: Use Linear as the persistent system of record for milestone planning and cross-session execution
user-invocable: false
---

# linear-workflow

Use this skill when planning or executing large milestones that span multiple sessions, contributors, or agents.

## Required policy

- Large milestones must be planned and tracked in Linear before implementation.
- Linear is the source of truth for plan status, scope changes, and progress.
- Keep issue status/assignee/priority current while work is active.
- Post progress comments after meaningful implementation checkpoints.

## Issue structure (canonical)

Every implementation issue should include:

1. Problem
2. Goal / expected outcome
3. Scope (in / out)
4. Technical approach
5. Acceptance criteria
6. Validation plan
7. Dependencies / blockers
8. Rollout risks

See templates:
- references/LINEAR_ISSUE_TEMPLATE.md
- references/MILESTONE_PLAN_TEMPLATE.md
- references/PROGRESS_UPDATE_TEMPLATE.md

## Milestone workflow

1. Create one tracker issue for the milestone.
2. Create child issues for implementation slices.
3. Link dependencies and blockers between issues.
4. Order execution explicitly in tracker comments.
5. Update tracker progress as child issues move.

## Session cadence

- Start of session:
  - confirm active issue + current status
  - confirm scope and acceptance criteria
- During session:
  - update status when moving phases
  - add progress comments with what changed and what is next
- End of session:
  - leave handoff comment with remaining tasks/risks
  - ensure next issue is clear and linked

## Cross-agent continuity

- Always link active work to a parent tracker issue.
- Keep latest plan/progress in Linear comments (not only local notes).
- If ownership changes, update assignee/delegate explicitly.

## Prioritization guidance

- Use Linear priority consistently across related issues.
- Runtime reliability and user-facing regressions should be prioritized above polish.
- Capture tradeoffs in issue body when deferring work.

## Reference guidance (official)

- Linear issue templates: https://linear.app/docs/issue-templates
- Linear parent/sub-issues: https://linear.app/docs/parent-and-sub-issues
- Linear issue relations: https://linear.app/docs/issue-relations
- Linear priorities: https://linear.app/docs/priorities
- GitHub issue forms syntax: https://docs.github.com/en/enterprise-server@3.17/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms

## Devrouter-specific note

If the repository uses devrouter, read the upstream devrouter release guidance at \`https://github.com/rolandhordos/devrouter/blob/main/CHANGELOG.md\` before planning implementation and use the latest Agent Adaptation Prompt there as required upgrade context. This is devrouter release guidance and does not require creating a \`CHANGELOG.md\` in the target repository unless that repository already has its own policy.
`;

const LINEAR_ISSUE_TEMPLATE_CONTENT = `# Linear Issue Template

## Problem

## Goal / Expected Outcome

## Scope
- In scope:
- Out of scope:

## Technical Approach

## Acceptance Criteria

## Validation Plan

## Dependencies / Blockers

## Rollout Risks
`;

const LINEAR_MILESTONE_TEMPLATE_CONTENT = `# Milestone Plan Template

## Milestone Goal

## Tracker Issue
- Identifier:
- Owner:

## Child Issues
- [ ] Issue 1:
- [ ] Issue 2:
- [ ] Issue 3:

## Sequencing
1.
2.
3.

## Risks and Mitigations

## Definition of Done
`;

const LINEAR_PROGRESS_TEMPLATE_CONTENT = `# Progress Update Template

## Summary

## Completed
- <item>

## In Progress
- <item>

## Next
- <item>

## Risks / Blockers
- <item>
`;

function buildDevrouterSection(): string {
  return [
    DEVROUTER_SENTINEL,
    "## devrouter",
    "",
    "This repository uses [devrouter](https://github.com/rolandhordos/devrouter) for local dev routing.",
    "All apps and dependencies are declared in `.devrouter.yml`.",
    "",
    "Full reference (config schema, docker requirements, env injection, commands):",
    `\`${DEVROUTER_SKILL_REL_PATH}\``,
    "",
    "Quick validation sequence:",
    "- `dev up`",
    "- `dev tls install` (required when repo defines tcp/postgres apps)",
    "- `dev app ls --repo .`",
    "- `dev app run <host-app> --repo . --yes`",
    "- `dev ls`",
  ].join("\n");
}

function buildLinearWorkflowSection(): string {
  return [
    LINEAR_WORKFLOW_SENTINEL,
    "## linear-workflow",
    "",
    "This repository can optionally use a Linear-centered workflow for milestone task management across sessions and agents.",
    "Use Linear as the system of record for large milestone planning and progress tracking.",
    "",
    "Skill and templates:",
    `- \`${LINEAR_SKILL_REL_PATH}\``,
    `- \`${LINEAR_ISSUE_TEMPLATE_REL_PATH}\``,
    `- \`${LINEAR_MILESTONE_TEMPLATE_REL_PATH}\``,
    `- \`${LINEAR_PROGRESS_TEMPLATE_REL_PATH}\``,
    "",
    "Bootstrap commands:",
    "- `dev init --with-linear --write-agents --write-skill`",
    "- `dev repo agents --with-linear`",
  ].join("\n");
}

function writeRepoFile(repoPath: string, relPath: string, content: string): string {
  const absolutePath = join(repoPath, relPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf-8");
  return absolutePath;
}

export function ensureAgentsMdSection(repoPath: string): { path: string; written: boolean } {
  const filePath = join(repoPath, AGENTS_MD);

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    if (content.includes(DEVROUTER_SENTINEL)) {
      return { path: filePath, written: false };
    }
    writeFileSync(filePath, content.trimEnd() + "\n\n" + buildDevrouterSection() + "\n", "utf-8");
    return { path: filePath, written: true };
  }

  writeFileSync(filePath, "# AGENTS.md\n\n" + buildDevrouterSection() + "\n", "utf-8");
  return { path: filePath, written: true };
}

export function ensureLinearWorkflowAgentsSection(repoPath: string): { path: string; written: boolean } {
  const filePath = join(repoPath, AGENTS_MD);

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    if (content.includes(LINEAR_WORKFLOW_SENTINEL)) {
      return { path: filePath, written: false };
    }
    writeFileSync(filePath, content.trimEnd() + "\n\n" + buildLinearWorkflowSection() + "\n", "utf-8");
    return { path: filePath, written: true };
  }

  writeFileSync(filePath, "# AGENTS.md\n\n" + buildLinearWorkflowSection() + "\n", "utf-8");
  return { path: filePath, written: true };
}

export function ensureSkillFile(repoPath: string): { path: string; written: boolean } {
  const filePath = writeRepoFile(repoPath, DEVROUTER_SKILL_REL_PATH, DEVROUTER_SKILL_CONTENT);
  return { path: filePath, written: true };
}

export function ensureLinearWorkflowSkillFiles(repoPath: string): { paths: string[]; written: true } {
  const paths = [
    writeRepoFile(repoPath, LINEAR_SKILL_REL_PATH, LINEAR_WORKFLOW_SKILL_CONTENT),
    writeRepoFile(repoPath, LINEAR_ISSUE_TEMPLATE_REL_PATH, LINEAR_ISSUE_TEMPLATE_CONTENT),
    writeRepoFile(repoPath, LINEAR_MILESTONE_TEMPLATE_REL_PATH, LINEAR_MILESTONE_TEMPLATE_CONTENT),
    writeRepoFile(repoPath, LINEAR_PROGRESS_TEMPLATE_REL_PATH, LINEAR_PROGRESS_TEMPLATE_CONTENT)
  ];
  return { paths, written: true };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LinearWorkflowMetadata } from './linear-onboarding'

const DEVROUTER_SENTINEL = '<!-- devrouter -->'
const LINEAR_WORKFLOW_SENTINEL = '<!-- devrouter-linear-workflow -->'
const LINEAR_WORKFLOW_CONFIG_START =
  '<!-- devrouter-linear-workflow-config:start -->'
const LINEAR_WORKFLOW_CONFIG_END =
  '<!-- devrouter-linear-workflow-config:end -->'
const AGENTS_MD = 'AGENTS.md'
const DEVROUTER_SKILL_REL_PATH = '.agents/skills/devrouter/SKILL.md'
const LINEAR_SKILL_REL_PATH = '.agents/skills/linear-workflow/SKILL.md'
const LINEAR_ISSUE_TEMPLATE_REL_PATH =
  '.agents/skills/linear-workflow/references/LINEAR_ISSUE_TEMPLATE.md'
const LINEAR_MILESTONE_TEMPLATE_REL_PATH =
  '.agents/skills/linear-workflow/references/MILESTONE_PLAN_TEMPLATE.md'
const LINEAR_PROGRESS_TEMPLATE_REL_PATH =
  '.agents/skills/linear-workflow/references/PROGRESS_UPDATE_TEMPLATE.md'

// Embedded skill content — must be self-contained in the built CLI bundle.
// Keep in sync with .agents/skills/devrouter/SKILL.md in the devrouter repo.
const DEVROUTER_SKILL_CONTENT = `---
name: devrouter
description: Work with devrouter for local dev routing (HTTP + TCP/Postgres + dependency-only Docker services)
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
devrouter:
  version: <semver> # required for devrouter -V / devrouter upgrade
project:
  name: <string> # optional
apps:
  - name: <string> # unique within repo
    kind: app | dependency # optional, default: app
    dependencies: # optional
      - app: <other-name>
        envMap: # optional; maps target env var name -> per-dep source var name
          DATABASE_URL: <UPPER_DEP_NAME>_URL

    # if kind=app:
    host: <name>.localhost
    protocol: http | tcp
    runtime: host | docker | proxy

    # if kind=app and runtime=proxy (protocol http or tcp):
    upstream: 127.0.0.1:3000 # already-running port to route to; no lifecycle/deps
    # Loopback (127.0.0.1/localhost) -> host.docker.internal (a published host
    # port). A non-loopback name is passed verbatim and resolved over devnet —
    # so a devcontainer container ON devnet (with a network alias) can be fronted
    # by NAME with NO published host port: upstream: <alias>:3000. This is the
    # collision-free way to run many apps at once (each its own *.localhost).
    # upstream may use the \${WORKSPACE} placeholder (e.g. \${WORKSPACE}-app:3000)
    # to target a per-workspace devcontainer alias — substituted with the resolved
    # workspace token at runtime. See "Workspace isolation" below. Do NOT put
    # \${WORKSPACE} in \`host\` (rejected); the host is auto-namespaced.
    #
    # proxy + tcp (front a DB in an externally-managed container, e.g. a
    # devcontainer's Postgres on devnet) — no per-DB host port:
    #   protocol: tcp
    #   tcpProtocol: postgres        # selects shared entrypoint :5432
    #   upstream: <db-alias>:5432    # devnet alias of the DB container
    # Requires \`devrouter tls install\` (SNI is read from the TLS ClientHello). Connect
    # with direct-SSL so the ClientHello carries SNI, e.g.:
    #   psql "host=db.<app>.localhost port=5432 sslmode=require sslnegotiation=direct ..."

    # if kind=app and runtime=host (protocol must be http):
    hostRun:
      command: <string>
      cwd: <string> # relative to repo root, must not escape it
      portTimeout: 120 # seconds, optional
      strategy:
        type: auto
        denyPorts: [80, 443, 5432]
        allowPortRange: '1024-65535'

    # if kind=app and runtime=docker:
    docker:
      service: <string>
      internalPort: <number>
      composeFiles: [<string>] # relative to repo root
      router: <string> # optional

    # if kind=app and protocol=tcp:
    tcpProtocol: postgres # required; runtime must be docker OR proxy

    # if kind=dependency:
    runtime: docker
    docker:
      service: <string>
      composeFiles: [<string>] # relative to repo root
\`\`\`

Validation rules:

- \`kind=app\`: \`host\` must end with \`.localhost\`
- \`kind=app\`: \`runtime=host\` supports \`protocol=http\` only
- \`kind=app\`: \`runtime=proxy\` supports \`protocol=http\` or \`protocol=tcp\`, requires \`upstream\` (\`host:port\`), and forbids \`hostRun\`/\`docker\`/\`dependencies\` (it only registers a route to an externally-managed upstream). \`protocol=tcp\` additionally requires \`tcpProtocol\` and TLS (\`devrouter tls install\`)
- \`kind=app\`: \`protocol=tcp\` requires \`runtime=docker\` (devrouter-managed container) or \`runtime=proxy\` (externally-managed upstream), plus a supported \`tcpProtocol\` (postgres/redis/mariadb/mysql)
- \`kind=dependency\`: must use \`runtime=docker\` and does not allow routed fields (\`host\`/\`protocol\`/\`tcpProtocol\`/\`hostRun\`/\`docker.internalPort\`/\`docker.router\`)
- Unknown keys rejected (strict schema)

## Docker compose requirements

- **Healthcheck required**: every dependency service must define a \`healthcheck\`. \`docker compose up --wait\` blocks until healthy; without one, wait returns immediately.
- **No published ports**: services must not publish host ports for devrouter-owned ports (80, 443, 5432). Avoid publishing ports at all -- devrouter handles routing via Traefik.
- **Postgres credentials**: use \`POSTGRES_USER=prisma\`, \`POSTGRES_PASSWORD=prisma\`, \`POSTGRES_DB=prisma\` and create a \`shadow\` database. devrouter injects per-dep \`{PREFIX}_URL\` / \`{PREFIX}_SHADOW_URL\` with these credentials.
- **Persistent volume warning**: if postgres defaults changed on an existing volume, reconcile credentials/data or recreate volumes when safe (for example \`docker compose down -v\`).

Example healthcheck:

\`\`\`yaml
healthcheck:
  test: ['CMD-SHELL', 'pg_isready -U prisma -d prisma']
  interval: 5s
  timeout: 3s
  retries: 20
\`\`\`

## Env var injection

When a host app depends on a TCP Docker service, \`devrouter app run\` and \`devrouter app exec\` inject per-dep deterministic vars (where \`{PREFIX} = dep.name.toUpperCase().replace(/-/g, "_")\`):

| Variable                | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| \`{PREFIX}_HOST\`         | \`localhost\`                                                 |
| \`{PREFIX}_PORT\`         | random mapped port                                          |
| \`{PREFIX}_URL\`          | protocol-specific URL (postgres, redis, mysql/mariadb)      |
| \`{PREFIX}_SHADOW_URL\`   | \`postgres://prisma:prisma@localhost:<port>/shadow\` (postgres only) |

Host apps also receive \`PORT\` (random free port), \`HOSTNAME=0.0.0.0\`, \`HOST=0.0.0.0\`.

Config-level \`envMap\` on dependency references aliases per-dep vars to app-expected names (for example \`DATABASE_URL: DB_URL\` maps the per-dep \`DB_URL\` to \`DATABASE_URL\`).

## Workspace isolation (parallel git worktrees / agents)

Run several worktrees of one repo in parallel without host/route collisions. A **workspace token** is a single identity spanning three layers: the devpod workspace id (\`devpod up --id <ws>\`), the routes devrouter registers, and the \`\${WORKSPACE}\` placeholder in \`.devrouter.yml\` upstreams + the devcontainer compose network alias.

- **Token resolution** (precedence): \`--workspace <slug>\` flag > \`DEVROUTER_WORKSPACE\` env var > auto-derived from a linked git worktree branch (sanitized: lowercase, non-alphanumeric → \`-\`, capped at 32 chars) > none. The primary checkout resolves to no token and routes exactly as before (back-compatible).
- **When active**: hosts auto-namespace (\`web.localhost\` → \`web.<ws>.localhost\`), \`\${WORKSPACE}\` in \`upstream\` is substituted with the token, and the docker \`router\` key is suffixed per workspace. The runtime config is computed in memory only — the committed \`.devrouter.yml\` is never rewritten.
- **TLS**: namespaced hosts (\`web.<ws>.localhost\`) are not covered by the \`*.localhost\` wildcard; devrouter auto-extends the mkcert cert SANs for active hosts when TLS is enabled.
- **devcontainer integration**: the devcontainer compose service exposes a devnet alias \`\${WORKSPACE}-app\` (default \`WORKSPACE=<project>\` in \`devcontainer.env\`); the proxy app uses \`upstream: \${WORKSPACE}-app:<port>\`. Workspace \`feat-a\` → alias \`feat-a-app\`, host \`app.feat-a.localhost\`.
- **Lifecycle**: \`devrouter workspace up <branch>\` (create worktree + devpod + routes), \`devrouter workspace ls\` (list worktrees/tokens/route counts), \`devrouter workspace down <workspace|branch>\` (free routes by state-file workspace tag + stop devpod + remove worktree). \`devrouter doctor\` reports orphaned workspace proxy routes whose worktree dir was removed without \`devrouter workspace down\`.

## Secret manager interop (Infisical/Doppler)

- Config-based SM integration: set \`secretManager.command\` in \`.devrouter.yml\` (include trailing \`--\`). devrouter wraps commands and re-injects dep env vars after the SM boundary.
- \`secretManager.defaultEnv\`: optional fallback environment for \`{env}\` template in command string.
- \`{env}\` template placeholder: \`secretManager.command: "infisical run --env {env} --"\` resolved at runtime. \`--env <env>\` CLI flag overrides \`defaultEnv\`.
- Example config:
  \`\`\`yaml
  secretManager:
    command: infisical run --env {env} --
    defaultEnv: dev
  \`\`\`
- Use \`envMap\` on dependency references to alias per-dep vars to app-expected names:
  \`\`\`yaml
  dependencies:
    - app: db
      envMap:
        DATABASE_URL: DB_URL
        DIRECT_URL: DB_URL
        SHADOW_DATABASE_URL: DB_SHADOW_URL
  \`\`\`
- Prefer argv-safe command forms. Do not wrap \`infisical run\` or \`doppler run\` in \`sh -lc\` unless shell expansion is strictly required.
- Canonical Infisical migrate command:
  \`devrouter app exec <app> --yes -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate\`
- Canonical env probe command (run before migrate/seed):
  \`devrouter app exec <app> --yes -- printenv DB_URL DB_HOST DB_PORT DB_SHADOW_URL\`
- Canonical Doppler migrate command:
  \`devrouter app exec <app> --yes -- doppler run -- pnpm payload migrate\`
- Precedence best practice: avoid defining per-dep var names in Infisical/Doppler when you expect devrouter local DB injection.
- Precedence best practice: store remote/prod URLs under non-conflicting names (for example \`PROD_DATABASE_URL\`) and map intentionally via \`envMap\`.
- Precedence best practice: if secret manager must define DB vars, run the env probe and verify values before any migration/seed.
- Use \`devrouter app exec --shell -- "<single command string>"\` only when shell expansion is required.
- \`envMap\` fails fast when source var is missing so migrations do not run with partial mapping.

## Upgrade handling (required)

- Keep \`.devrouter.yml\` metadata \`devrouter.version\` aligned with the currently applied devrouter release.
- Verify versions with \`devrouter -V\` (shows installed CLI version, local repo version, and next upgrade target).
- Use \`devrouter upgrade\` to list available upgrade targets and \`devrouter upgrade <version>\` to print that target's Agent Adaptation Prompt from \`upgrade-prompts/<version>.md\`.
- Do not assume user-provided instructions include all required adaptation steps.
- After upgrading the CLI in a dependent repo, refresh discoverability artifacts with \`devrouter repo agents\` (or \`devrouter init --write-agents --write-skill\`).
- Re-run validation after upgrade: \`devrouter doctor --repo .\`, \`devrouter app ls --repo .\`, one representative \`devrouter app exec\` flow, and \`devrouter ls\`.

## Optional Linear workflow bootstrap

- To add Linear task-management workflow assets to a repo, run:
  - \`devrouter init --with-linear --write-agents --write-skill\`, or
  - \`devrouter repo agents --with-linear\`
- This writes \`.agents/skills/linear-workflow/SKILL.md\` and reference templates, plus an idempotent AGENTS section.
- On AGENTS write flows, devrouter asks for minimal Linear mapping (workspace/team/project) and stores it in a managed AGENTS block:
  - \`<!-- devrouter-linear-workflow-config:start -->\`
  - \`<!-- devrouter-linear-workflow-config:end -->\`
- In non-interactive mode, placeholder values are written and should be replaced in the next interactive session.

## Commands

- \`devrouter init [--write-agents] [--write-skill] [--with-linear]\`: print AI onboarding prompt (non-mutating by default)
- \`devrouter -V [--repo .]\`: show installed CLI version, local repo version, and next upgrade target
- \`devrouter upgrade [version] [--repo .]\`: list upgrade targets or print target Agent Adaptation Prompt
- \`devrouter setup --yes [--repo .] [--json]\`: first-run machine setup plus structured diagnostics
- \`devrouter up\` / \`devrouter down\`: start/stop shared Traefik router
- \`devrouter status\`: router/container/network/TLS health
- \`devrouter doctor [--repo .]\`: deep diagnostics (global + repo)
- \`devrouter ls\`: list active HTTP + TCP routes
- \`devrouter open <name>\`: open HTTP route or print TCP connection hint (matches app name, then service/container/host identities)
- \`devrouter logs [-f]\`: Traefik access logs
- \`devrouter tls install\`: install mkcert certs, enable HTTPS + TCP/SNI
- \`devrouter repo init\`: create \`.devrouter.yml\`
- \`devrouter repo inspect [--json]\`: inspect package, scripts, compose services, env names, devcontainer, devrouter config, and agent guidance for onboarding
- \`devrouter repo devcontainer write --dry-run --json\`: plan conservative Node/pnpm/Postgres devcontainer/devrouter scaffold files without writing
- \`devrouter repo devcontainer write --yes\`: write managed Node/pnpm/Postgres devcontainer/devrouter scaffold files when no custom-file conflicts exist
- \`devrouter repo devcontainer verify --json\`: emit read-only onboarding evidence for PRs
- \`devrouter repo devcontainer verify --live --yes --json\`: register proxy routes and probe HTTP routes after the devcontainer is running
- \`devrouter repo agents [--with-linear]\`: write devrouter section in AGENTS.md + install this skill (and optional Linear workflow assets)
- \`devrouter app add\`: add/update app entry in \`.devrouter.yml\`
- \`devrouter app ls\`: list app entries
- \`devrouter app run <name> [--env <env>] [--workspace <slug>]\`: run app with dependency lifecycle (--env overrides SM defaultEnv; --workspace overrides the per-workspace token)
- \`devrouter app exec <name> [--shell] [--env <env>] [--workspace <slug>] -- <cmd>\`: one-shot command with resolved dep env
- \`devrouter app rm <name> [--keep-config]\`: remove app entry (\`--keep-config\` frees only the live route/hostname, leaves \`.devrouter.yml\` untouched)
- \`devrouter workspace up <branch> [--path <dir>] [--no-devpod] [--open]\`: create a worktree + devpod + namespaced routes
- \`devrouter workspace ls [--json]\`: list git worktrees with workspace token + route count
- \`devrouter workspace down <workspace|branch> [--keep-worktree] [--keep-devpod]\`: free routes + stop devpod + remove worktree

## Validation workflow

For devcontainer onboarding:

1. \`devrouter setup --repo . --yes --json\`
2. \`devrouter doctor --repo . --json\`
3. \`devrouter repo inspect --repo . --json\`
4. \`devrouter repo devcontainer write --repo . --dry-run --json\`
5. \`devrouter repo devcontainer write --repo . --yes\`
6. \`devrouter repo devcontainer verify --repo . --json\`
7. Start the devcontainer, for example \`devpod up .\`
8. \`devrouter repo devcontainer verify --repo . --live --yes --json\`

For existing host/docker runtime apps:

1. \`devrouter setup --repo . --yes\`
2. \`devrouter doctor --repo .\`
3. \`devrouter app ls --repo .\`
4. \`devrouter app run <host-app> --repo . --yes\`
5. \`devrouter ls\`
6. \`curl -I https://<host>.localhost\`
7. For TCP/Postgres, use \`devrouter open <name>\` for the connection hint.

## Runtime behavior notes

- \`devrouter app run\` auto-starts Docker dependencies and waits for health. Host app runs stop auto-started docker deps on exit; docker app runs leave target services running until explicit cleanup.
- Host-runtime dependencies are NOT auto-started (v1).
- \`kind=dependency\` entries do not create routes and cannot be direct targets for \`devrouter app run\`, \`devrouter app exec\`, or \`devrouter open\`.
- \`kind=dependency\` services start as declared in compose (no Traefik label wiring, no random port publishing, no injected env vars).
- Postgres on shared \`:5432\` requires TLS/SNI (\`devrouter tls install\`). Standard app clients should use the injected random port instead.
- \`devrouter app exec\` follows the same dep lifecycle for one-shot commands and preserves argv semantics by default (\`shell: false\`).
- \`devrouter app exec --shell\` is explicit and requires exactly one command string after \`--\`.
- Secret-manager overlap caveat: if Infisical/Doppler defines DB vars too, probe effective env (\`printenv DB_URL DB_HOST DB_PORT\`) before migrate/seed.
`
const LINEAR_WORKFLOW_SKILL_CONTENT = `---
name: linear-workflow
description: Use a minimal Linear workspace/team/project mapping for cross-session continuity
user-invocable: false
---

# linear-workflow

Use this skill when a repository enables Linear workflow via devrouter.

## First step: read AGENTS mapping

Check \`AGENTS.md\` for the managed Linear block:

- \`<!-- devrouter-linear-workflow-config:start -->\`
- \`<!-- devrouter-linear-workflow-config:end -->\`

Use that block as source of truth for:

- workspace name
- team name (and optional key)
- project name (and optional id)

## If mapping is missing or placeholder

Ask the user these guided questions and update the AGENTS managed block:

1. Which Linear workspace does this repository belong to?
2. Which Linear team owns this repository? (optional team key)
3. Which Linear project should milestones/issues be created in? (optional project id)

If non-interactive context prevents asking, keep placeholders and request values in the next interactive session.

## Usage rule

- Do not hardcode workspace/team/project assumptions.
- Always resolve them from AGENTS metadata first.

## Required execution hygiene

When working on Linear-tracked issues, this is required:

1. Set issue status at session start and update it at each phase transition.
2. Post progress comments at meaningful checkpoints during implementation.
3. Before ending a session, post a final comment with completed work, remaining work, risks, and next step.
4. Re-check status and comment freshness toward/at session end before stopping.

## Devrouter-specific note

If the repository uses devrouter, use \`devrouter upgrade\` to resolve the required Agent Adaptation Prompt for the target version before major changes (prompt files are versioned under \`upgrade-prompts/<version>.md\`).
`

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
`

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
`

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
`

function buildDevrouterSection(): string {
  return [
    DEVROUTER_SENTINEL,
    '## devrouter',
    '',
    'This repository uses [devrouter](https://github.com/rschlaefli/devrouter) for local dev routing.',
    'All apps and dependencies are declared in `.devrouter.yml`.',
    '',
    'Full reference (config schema, docker requirements, env injection, commands):',
    `\`${DEVROUTER_SKILL_REL_PATH}\``,
    '',
    'Quick validation sequence:',
    '- `devrouter up`',
    '- `devrouter tls install` (required when repo defines tcp/postgres apps)',
    '- `devrouter app ls --repo .`',
    '- `devrouter app run <host-app> --repo . --yes`',
    '- `devrouter ls`',
  ].join('\n')
}

function buildLinearWorkflowSection(): string {
  return [
    LINEAR_WORKFLOW_SENTINEL,
    '## linear-workflow',
    '',
    'This repository can optionally use a Linear-centered workflow with a minimal workspace/team/project mapping.',
    'Use the managed AGENTS metadata block as source of truth before creating/updating Linear issues.',
    '',
    'Skill and templates:',
    `- \`${LINEAR_SKILL_REL_PATH}\``,
    `- \`${LINEAR_ISSUE_TEMPLATE_REL_PATH}\``,
    `- \`${LINEAR_MILESTONE_TEMPLATE_REL_PATH}\``,
    `- \`${LINEAR_PROGRESS_TEMPLATE_REL_PATH}\``,
    '',
    'Managed metadata block:',
    `- \`${LINEAR_WORKFLOW_CONFIG_START}\``,
    `- \`${LINEAR_WORKFLOW_CONFIG_END}\``,
    '',
    'Required Linear execution hygiene:',
    '- Set issue status at session start and update it at each phase transition.',
    '- Post progress comments at meaningful checkpoints during implementation.',
    '- Before ending a session, post a final comment with completed work, remaining work, risks, and next step.',
    '- Re-check status and comment freshness toward/at session end before stopping.',
    '',
    'Bootstrap commands:',
    '- `devrouter init --with-linear --write-agents --write-skill`',
    '- `devrouter repo agents --with-linear`',
  ].join('\n')
}

function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

function renderLinearWorkflowConfig(metadata: LinearWorkflowMetadata): string {
  const lines = [
    'linear:',
    '  workspace:',
    `    name: ${yamlQuote(metadata.workspace.name)}`,
    '  team:',
    `    name: ${yamlQuote(metadata.team.name)}`,
  ]

  if (metadata.team.key) {
    lines.push(`    key: ${yamlQuote(metadata.team.key)}`)
  }

  lines.push('  project:')
  lines.push(`    name: ${yamlQuote(metadata.project.name)}`)

  if (metadata.project.id) {
    lines.push(`    id: ${yamlQuote(metadata.project.id)}`)
  }

  lines.push(`  updated_at: ${yamlQuote(metadata.updatedAt)}`)
  lines.push(`  capture_mode: ${yamlQuote(metadata.captureMode)}`)
  return lines.join('\n')
}

function renderLinearWorkflowConfigBlock(
  metadata: LinearWorkflowMetadata
): string {
  return [
    LINEAR_WORKFLOW_CONFIG_START,
    '```yaml',
    renderLinearWorkflowConfig(metadata),
    '```',
    LINEAR_WORKFLOW_CONFIG_END,
  ].join('\n')
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function upsertLinearWorkflowConfigBlock(
  content: string,
  metadata: LinearWorkflowMetadata
): string {
  const block = renderLinearWorkflowConfigBlock(metadata)
  const pattern = new RegExp(
    `${escapeRegExp(LINEAR_WORKFLOW_CONFIG_START)}[\\s\\S]*?${escapeRegExp(LINEAR_WORKFLOW_CONFIG_END)}\\n?`,
    'm'
  )

  if (pattern.test(content)) {
    return content.replace(pattern, `${block}\n`)
  }

  return `${content.trimEnd()}\n\n${block}\n`
}

function writeRepoFile(
  repoPath: string,
  relPath: string,
  content: string
): string {
  const absolutePath = join(repoPath, relPath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content, 'utf-8')
  return absolutePath
}

export function ensureAgentsMdSection(repoPath: string): {
  path: string
  written: boolean
} {
  const filePath = join(repoPath, AGENTS_MD)

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf-8')
    if (content.includes(DEVROUTER_SENTINEL)) {
      return { path: filePath, written: false }
    }
    writeFileSync(
      filePath,
      content.trimEnd() + '\n\n' + buildDevrouterSection() + '\n',
      'utf-8'
    )
    return { path: filePath, written: true }
  }

  writeFileSync(
    filePath,
    '# AGENTS.md\n\n' + buildDevrouterSection() + '\n',
    'utf-8'
  )
  return { path: filePath, written: true }
}

export function ensureLinearWorkflowAgentsSection(
  repoPath: string,
  metadata: LinearWorkflowMetadata
): { path: string; written: boolean } {
  const filePath = join(repoPath, AGENTS_MD)

  if (existsSync(filePath)) {
    let content = readFileSync(filePath, 'utf-8')
    let changed = false

    if (!content.includes(LINEAR_WORKFLOW_SENTINEL)) {
      content = content.trimEnd() + '\n\n' + buildLinearWorkflowSection() + '\n'
      changed = true
    }

    const withConfig = upsertLinearWorkflowConfigBlock(content, metadata)
    if (withConfig !== content) {
      changed = true
    }

    if (changed) {
      writeFileSync(filePath, withConfig, 'utf-8')
    }

    return { path: filePath, written: changed }
  }

  const initialContent = '# AGENTS.md\n\n' + buildLinearWorkflowSection() + '\n'
  const withConfig = upsertLinearWorkflowConfigBlock(initialContent, metadata)
  writeFileSync(filePath, withConfig, 'utf-8')
  return { path: filePath, written: true }
}

export function ensureSkillFile(repoPath: string): {
  path: string
  written: boolean
} {
  const filePath = writeRepoFile(
    repoPath,
    DEVROUTER_SKILL_REL_PATH,
    DEVROUTER_SKILL_CONTENT
  )
  return { path: filePath, written: true }
}

export function ensureLinearWorkflowSkillFiles(repoPath: string): {
  paths: string[]
  written: true
} {
  const paths = [
    writeRepoFile(
      repoPath,
      LINEAR_SKILL_REL_PATH,
      LINEAR_WORKFLOW_SKILL_CONTENT
    ),
    writeRepoFile(
      repoPath,
      LINEAR_ISSUE_TEMPLATE_REL_PATH,
      LINEAR_ISSUE_TEMPLATE_CONTENT
    ),
    writeRepoFile(
      repoPath,
      LINEAR_MILESTONE_TEMPLATE_REL_PATH,
      LINEAR_MILESTONE_TEMPLATE_CONTENT
    ),
    writeRepoFile(
      repoPath,
      LINEAR_PROGRESS_TEMPLATE_REL_PATH,
      LINEAR_PROGRESS_TEMPLATE_CONTENT
    ),
  ]
  return { paths, written: true }
}

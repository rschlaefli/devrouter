import {
  DEP_ENV_SUFFIXES,
  DEPENDENCY_ONLY_RUNTIME,
  formatSupportedProtocolsForRuntime,
  formatSupportedTcpProtocols,
  POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE,
  POSTGRES_DEPENDENCY_URL_TEMPLATE,
  SECRET_MANAGER_ENV_PLACEHOLDER,
  SUPPORTED_PROTOCOLS,
  SUPPORTED_RUNTIMES,
  SUPPORTED_TCP_PROTOCOLS,
  WORKSPACE_PLACEHOLDER,
} from "./capabilities";
import { resolveRepoPath } from "./repo-config";

export type InitPromptOptions = {
  repo?: string;
  entriesJson?: string;
};

export type CommandIntent = {
  command: string;
  purpose: string;
};

export const COMMAND_INTENTS: CommandIntent[] = [
  {
    command: "devrouter init",
    purpose: "Print the AI onboarding prompt template for a repository (non-mutating by default).",
  },
  {
    command: "devrouter -V",
    purpose: "Show installed CLI version, local repo version, and next upgrade target.",
  },
  {
    command: "devrouter upgrade [version]",
    purpose:
      "Show upgrade targets from .devrouter.yml devrouter.version and print target adaptation prompt.",
  },
  {
    command: "devrouter setup",
    purpose: "Run first-time devrouter machine setup and report structured diagnostics.",
  },
  {
    command: "devrouter up",
    purpose: "Start shared Traefik and ensure the shared devnet network.",
  },
  { command: "devrouter down", purpose: "Stop the shared Traefik router stack." },
  {
    command: "devrouter status",
    purpose: "Show router/container/network/TLS health and bound ports.",
  },
  {
    command: "devrouter doctor",
    purpose: "Run deep diagnostics across global router state and repo config.",
  },
  {
    command: "devrouter ls",
    purpose: "List active HTTP and TCP routes resolved by devrouter.",
  },
  {
    command: "devrouter open <name>",
    purpose: "Open HTTP routes or print connection hints for TCP routes (match app/service/host).",
  },
  {
    command: "devrouter tls install",
    purpose: "Install mkcert certs and enable TLS/HTTPS for local routing.",
  },
  {
    command: "devrouter repo init",
    purpose: "Create `.devrouter.yml` in a target repository.",
  },
  {
    command: "devrouter repo inspect",
    purpose:
      "Inspect package, scripts, compose services, env names, devcontainer, devrouter config, and agent guidance for onboarding.",
  },
  {
    command: "devrouter repo devcontainer write",
    purpose:
      "Dry-run or write conservative managed Node/pnpm/Postgres devcontainer/devrouter scaffold files.",
  },
  {
    command: "devrouter repo devcontainer verify",
    purpose: "Emit static onboarding evidence, or live route probes with --live --yes.",
  },
  {
    command: "devrouter app add",
    purpose: "Add or update one app entry in `.devrouter.yml`.",
  },
  { command: "devrouter app ls", purpose: "List app entries from `.devrouter.yml`." },
  {
    command: "devrouter app run [--env <env>]",
    purpose:
      "Run one configured app and reconcile its route at runtime (--env overrides SM defaultEnv).",
  },
  {
    command: "devrouter app exec [--shell] [--env <env>]",
    purpose:
      "Run a one-shot command with resolved dependency env vars (env aliasing via config-level envMap).",
  },
  {
    command: "devrouter app rm [--keep-config]",
    purpose:
      "Remove one app entry from `.devrouter.yml` and free its route. `--keep-config` frees only the live route/hostname (e.g. to release one claimed by another repo) and leaves the config file untouched.",
  },
  {
    command: "devrouter repo agents",
    purpose:
      "Write/update devrouter section in the repo's AGENTS.md and install the devrouter skill.",
  },
  {
    command: "devrouter workspace up <branch> [--path <dir>] [--no-devpod] [--open]",
    purpose:
      "Create a git worktree for <branch>, then run the proven workspace startup unless --no-devpod is set.",
  },
  {
    command: "devrouter workspace ensure [path] [--open]",
    purpose:
      "Start or reconcile the exact linked worktree DevPod, prove its runtime, and atomically register workspace routes.",
  },
  {
    command: "devrouter workspace ls [--json]",
    purpose: "List git worktrees with their resolved workspace token and active route count.",
  },
  {
    command: "devrouter workspace down <workspace|branch> [--keep-worktree] [--keep-devpod]",
    purpose:
      "Free a workspace's routes, stop its devpod, and remove its worktree (routes are freed by state-file workspace tag, no config load).",
  },
];

function normalizeEntriesJson(input?: string): string {
  if (!input) {
    return "<JSON_ARRAY_OF_APP_ENTRIES>";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("--entries-json must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("--entries-json must be a JSON array.");
  }

  return JSON.stringify(parsed);
}

function renderCommandIntentSection(): string {
  const lines = COMMAND_INTENTS.map((entry) => `- ${entry.command}: ${entry.purpose}`);
  return ["Command intent reference:", ...lines].join("\n");
}

function quotedUnion(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(" | ");
}

function formatDepEnvNames(): string {
  return DEP_ENV_SUFFIXES.map((suffix) => `\`{PREFIX}_${suffix}\``).join(", ");
}

function formatProtocolRule(runtime: "host" | "proxy"): string {
  return formatSupportedProtocolsForRuntime(runtime).replace(", ", " or ");
}

export function buildOnboardingPrompt(options: InitPromptOptions = {}): string {
  const repoPath = resolveRepoPath(options.repo);
  const entriesJson = normalizeEntriesJson(options.entriesJson);
  const projectName = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "repo";

  return [
    "You are adapting an existing repository to devrouter using the unified .devrouter.yml model.",
    "",
    "Objective:",
    "- Configure stable local hostnames (*.localhost) for app/database access through the shared devrouter.",
    "- Avoid manual/random host ports for app access.",
    "- Keep repo changes minimal, explicit, and reproducible.",
    "",
    "How devrouter works (must respect):",
    "- Shared Traefik router owns host ports 80 (HTTP), 443 (HTTPS), and 5432 (Postgres TCP).",
    "- Per-repo source of truth is REPO_PATH/.devrouter.yml only.",
    "- Global generated/runtime artifacts are managed under ~/.config/devrouter (do not edit these manually).",
    "",
    "Inputs:",
    `- REPO_PATH=${repoPath}`,
    `- ENTRIES_JSON=${entriesJson}`,
    "",
    "Top-level .devrouter.yml schema:",
    "- version: 1 (required)",
    "- devrouter.version: semantic version string (recommended; required for `devrouter -V`/`devrouter upgrade`)",
    "- project.name: string (optional)",
    `- secretManager.command: string (optional; SM command including trailing \`--\` boundary; supports \`${SECRET_MANAGER_ENV_PLACEHOLDER}\` template placeholder)`,
    `- secretManager.defaultEnv: string (optional; fallback env for \`${SECRET_MANAGER_ENV_PLACEHOLDER}\` template; required when command contains \`${SECRET_MANAGER_ENV_PLACEHOLDER}\`)`,
    "- apps: array (required)",
    "",
    "Canonical valid skeleton:",
    "```yaml",
    "version: 1",
    "project:",
    `  name: ${projectName}`,
    "apps: []",
    "```",
    "",
    "App entry schema (each object in apps):",
    "- name: string (unique in repo)",
    '- kind: "app" | "dependency" (optional, default: "app")',
    '- dependencies: [{ app: "<name>", envMap: { TARGET: "SOURCE" } }] (optional; envMap aliases per-dep vars to app-expected names)',
    "- if kind=app:",
    "  - host: <name>.localhost (single-label or multi-segment, for example `api.v2.app.localhost`)",
    `  - protocol: ${quotedUnion(SUPPORTED_PROTOCOLS)}`,
    `  - runtime: ${quotedUnion(SUPPORTED_RUNTIMES)}`,
    "- if kind=app and runtime=host:",
    "  - hostRun.command: string",
    "  - hostRun.cwd: string",
    '  - hostRun.strategy.type: "auto"',
    "  - hostRun.strategy.denyPorts: [80, 443, 5432]",
    '  - hostRun.strategy.allowPortRange: "1024-65535"',
    "- if kind=app and runtime=docker:",
    "  - docker.service: string",
    "  - docker.internalPort: number",
    "  - docker.composeFiles: string[]",
    "  - optional docker.router: string",
    "- if kind=app and runtime=proxy:",
    '  - upstream: "host:port" (an already-running port, e.g. a devcontainer published on 127.0.0.1:3000, or a container reachable by name on a shared Docker network such as `derivatives-db:5432`)',
    `  - upstream may use the \`${WORKSPACE_PLACEHOLDER}\` placeholder (e.g. \`${WORKSPACE_PLACEHOLDER}-app:3000\`) to target a per-workspace devcontainer alias; it is substituted with the resolved workspace token at runtime and re-validated. Do NOT put \`${WORKSPACE_PLACEHOLDER}\` in \`host\` (rejected) — the host is auto-namespaced.`,
    "  - protocol=http registers an HTTP route; protocol=tcp registers a TLS-SNI TCP route and additionally requires tcpProtocol",
    "  - do not set hostRun/docker/dependencies (proxy only registers a route to the upstream)",
    "  - loopback hosts (localhost/127.0.0.1/0.0.0.0) are rewritten to host.docker.internal for Traefik",
    "- if kind=app and protocol=tcp:",
    `  - tcpProtocol: ${quotedUnion(SUPPORTED_TCP_PROTOCOLS)}`,
    "- if kind=dependency:",
    `  - runtime: "${DEPENDENCY_ONLY_RUNTIME}"`,
    "  - docker.service: string",
    "  - docker.composeFiles: string[]",
    "  - do not set host/protocol/tcpProtocol/hostRun/docker.internalPort/docker.router",
    "",
    "Validation rules to enforce:",
    "- kind=app host must end with .localhost",
    `- kind=app runtime=host supports protocol=${formatProtocolRule("host")} only`,
    `- kind=app runtime=proxy supports protocol=${formatProtocolRule("proxy")}, requires upstream (host:port), and has no dependencies; protocol=tcp also requires tcpProtocol`,
    `- kind=app protocol=tcp requires runtime=docker or proxy, and tcpProtocol (${formatSupportedTcpProtocols()})`,
    `- kind=dependency requires runtime=${DEPENDENCY_ONLY_RUNTIME} and non-routed docker config only`,
    "- unknown keys are not allowed (strict schema)",
    "",
    "Docker compose file requirements:",
    "- Every service that acts as a dependency MUST define a healthcheck — devrouter uses `docker compose up --wait` which blocks until healthy; without a healthcheck the wait returns immediately and the dependent app may start before the service is ready.",
    "- Services MUST NOT publish host ports (`ports:` mapping) for any port owned by devrouter (80, 443, 5432) — Traefik owns these; conflicts cause bind failures.",
    "- Services SHOULD NOT publish host ports at all — devrouter handles external routing via Traefik labels; publishing ports creates conflicts when running multiple repos.",
    `- For TCP dependencies of host apps, devrouter automatically publishes a random host port and injects per-dep deterministic env vars: ${formatDepEnvNames()}. \`{PREFIX}_URL\` is protocol-specific, \`{PREFIX}_SHADOW_URL\` is postgres only. \`{PREFIX} = dep.name.toUpperCase().replace(/-/g, "_")\`.`,
    `- For postgres deps, \`{PREFIX}_URL=${POSTGRES_DEPENDENCY_URL_TEMPLATE}\` and \`{PREFIX}_SHADOW_URL=${POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE}\`. Use config-level \`envMap\` on the dependency reference to alias these to app-expected names (e.g. \`DATABASE_URL: DB_URL\`).`,
    "- The Postgres service in docker-compose must use matching credentials (`POSTGRES_USER=prisma`, `POSTGRES_PASSWORD=prisma`, `POSTGRES_DB=prisma`) and create the shadow database (e.g. via an init script or the app's migration tool). If existing credentials differ, either update them to match or override via `envMap` aliasing.",
    "- If you changed postgres credentials/database defaults on an existing persistent volume, startup may still fail due to stale data. Recommend reconciling credentials or recreating volumes (for example `docker compose down -v`) when safe.",
    "- The TLS/SNI route on :5432 remains available for tools supporting `sslnegotiation=direct` (psql 17+, pgAdmin).",
    '- Example healthcheck for postgres: `test: ["CMD-SHELL", "pg_isready -U <user> -d <db>"]` with `interval: 5s`, `timeout: 3s`, `retries: 20`.',
    "",
    "Runtime behavior to account for:",
    "- Docker dependencies can be auto-started by devrouter app run.",
    "- devrouter app run waits for Docker dependencies to become healthy before starting the host or docker app.",
    "- Docker dependencies are automatically stopped when a host app exits (Ctrl+C or error); docker app services remain running until explicit cleanup (`docker compose down`, `devrouter down`, or equivalent).",
    "- Recent dependency logs (last 20 lines) are printed after dependencies start.",
    "- Host-runtime dependencies are NOT auto-started in v1 (must be started manually).",
    "- kind=dependency entries are dependency-only: they do not create routes and cannot be direct targets for `devrouter app run`, `devrouter app exec`, or `devrouter open`.",
    "- kind=dependency services are started/stopped as declared in compose (no Traefik labels added, no env/port injection).",
    `- For TCP dependencies of host apps, devrouter publishes a random host port and injects per-dep deterministic vars: \`{PREFIX}_HOST=localhost\`, \`{PREFIX}_PORT=<port>\`, \`{PREFIX}_URL\` (protocol-specific), \`{PREFIX}_SHADOW_URL\` (postgres only). \`{PREFIX} = dep.name.toUpperCase().replace(/-/g, "_")\`.`,
    "- Config-level `envMap` on dependency references aliases per-dep vars to app-expected names. Example: `envMap: { DATABASE_URL: DB_URL }` maps per-dep `DB_URL` to `DATABASE_URL` in the app process.",
    "- If the repo's Postgres docker-compose service uses different credentials than the injected defaults (`prisma:prisma`), flag this to the user and recommend aligning the compose env vars or using `envMap` aliasing.",
    "- Postgres multiplexing on shared :5432 requires TLS/SNI (useful for psql 17+, pgAdmin, not standard app clients).",
    "- When TLS is enabled, `devrouter app run` and `devrouter app exec` auto-refresh cert SAN coverage for configured repo hosts before startup.",
    "- For TCP/Postgres, standard app frameworks should use the injected port env vars; only direct-TLS-capable tools should use sslmode=require on :5432.",
    "- `devrouter app exec <name> -- <command>` starts dependencies as needed, resolves env vars, and runs a one-shot command with the resolved env. Exec stops only dependencies started by that invocation (already-running dependencies stay running). If ownership detection fails, exec leaves selected dependencies running to avoid non-owned teardown. Exec preserves argv semantics by default (`shell: false`) and supports explicit shell mode via `--shell` when needed.",
    "- `envMap` on dependency references (config-level) aliases per-dep vars after dependency env resolution. `envMap` fails fast when source var is missing.",
    "",
    "Workspace isolation (parallel git worktrees / agents):",
    `- A "workspace token" lets several worktrees of one repo run in parallel without host/route collisions. Each linked worktree persists one authoritative identity spanning the DevPod id, devrouter routes, the \`${WORKSPACE_PLACEHOLDER}\` proxy upstream, and devcontainer aliases.`,
    "- First use reuses an exact-path DevPod or derives a sanitized branch/path identity. Later flags or `DEVROUTER_WORKSPACE` may repeat but cannot rename the persisted identity. Ambiguous identities fail closed. The primary checkout stays non-namespaced.",
    `- When a workspace is active: hosts auto-namespace (\`web.localhost\` → \`web.<ws>.localhost\`), \`${WORKSPACE_PLACEHOLDER}\` in \`upstream\` is substituted with the token, and the docker \`router\` key is suffixed per workspace. The runtime config is computed in memory only — the committed \`.devrouter.yml\` is never rewritten.`,
    "- TLS: namespaced hosts (`web.<ws>.localhost`) are not covered by the `*.localhost` wildcard; devrouter auto-extends the mkcert cert SANs for active hosts when TLS is enabled.",
    "- Lifecycle: `devrouter workspace up <branch>` creates and starts a new worktree; `devrouter workspace ensure .` is the canonical start/reconcile command inside an existing linked worktree; `workspace ls` reports state; `workspace down` serializes teardown with ensure.",
    "- devcontainer integration: `devcontainer.json` lists the base compose file then `${localEnv:DEVCONTAINER_COMPOSE_OVERLAY:docker-compose.default.yml}`. The default overlay contains `services: {}`; `.devcontainer/docker-compose.devrouter.yml` passes `WORKSPACE` and `DEVROUTER_WORKSPACE` into the app and bind-mounts `${DEVROUTER_GIT_COMMON_DIR}` to the same absolute app-container path. Ensure proves exact DevPod ownership, overlay/Git mounts, env, aliases, health, Git, HTTP route reachability, and unique running TCP upstream ownership before success.",
    "",
    "Secret Manager Integration (config-based):",
    "- Optional top-level `secretManager.command` in `.devrouter.yml` wraps `devrouter app run` and `devrouter app exec` commands with the SM command and re-applies devrouter-injected dep env vars after the SM boundary via `env KEY=VAL` prefix.",
    `- Example config: \`secretManager: { command: "infisical run --env ${SECRET_MANAGER_ENV_PLACEHOLDER} --", defaultEnv: "dev" }\`.`,
    `- \`${SECRET_MANAGER_ENV_PLACEHOLDER}\` template placeholder in \`secretManager.command\` is resolved at runtime. \`defaultEnv\` provides the fallback; \`--env\` CLI flag overrides it.`,
    "- When configured, the effective command becomes: `<secretManager.command> env {PREFIX}_URL=<val> ... <user-command>`.",
    "- This ensures devrouter-injected vars take precedence over SM-defined values without manual forwarding.",
    "- Config-level `envMap` targets are also included in the re-injection set.",
    "- The SM command string must include the trailing `--` boundary (user responsibility).",
    "",
    "Secret Manager Interop (manual fallback):",
    "- devrouter injects per-dep deterministic env vars (`{PREFIX}_HOST`, `{PREFIX}_PORT`, `{PREFIX}_URL`, and for postgres: `{PREFIX}_SHADOW_URL`).",
    "- Secret managers may also define DB variables. Do not assume secret-manager precedence. Confirm the effective values in the command process before migrate/seed.",
    "- For apps that require legacy names like `DATABASE_URL`, use config-level `envMap` on the dependency reference: `envMap: { DATABASE_URL: DB_URL }`.",
    "- Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values.",
    "- `devrouter doctor --repo <REPO_PATH>` warns on risky pre-wrapper DB assignments before `run --` for host apps that depend on postgres.",
    "- With TLS enabled, `devrouter doctor --repo <REPO_PATH>` also warns on cert SAN mismatches for configured hosts (`repo.tls-host-coverage`).",
    "- Robust one-shot migrate example (argv-safe, no nested shell quoting): `devrouter app exec <name> --repo <REPO_PATH> --yes -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate`.",
    "- Robust one-shot seed example: `devrouter app exec <name> --repo <REPO_PATH> --yes -- infisical run --projectId <id> --env=<env> -- pnpm payload seed`.",
    "- Environment probe/debug example (run before migrations): `devrouter app exec <name> --repo <REPO_PATH> --yes -- printenv DB_URL DB_HOST DB_PORT DB_SHADOW_URL`.",
    "- Use `--shell` only when shell expansion is required; it must receive exactly one command string after `--`.",
    "- Warning: Do not run migration/seed until env probe confirms expected DB variables and values.",
    "",
    "Required workflow:",
    "1) Run `devrouter setup --yes --json` for devrouter-owned machine state; use `devrouter doctor --repo <REPO_PATH> --json` to diagnose missing prerequisites without mutation.",
    "2) Run `devrouter repo inspect --repo <REPO_PATH> --json` before editing files.",
    "3) For the supported Node/pnpm/Postgres devcontainer shape, run `devrouter repo devcontainer write --repo <REPO_PATH> --dry-run --json`, review the plan, then run `devrouter repo devcontainer write --repo <REPO_PATH> --yes`.",
    "4) For unsupported shapes or custom existing files, make minimal manual edits and explain the assumptions.",
    "5) Verify static evidence with `devrouter repo devcontainer verify --repo <REPO_PATH> --json`; after the devcontainer is running, use `devrouter repo devcontainer verify --repo <REPO_PATH> --live --yes --json` for route probes.",
    "6) Keep edits minimal, explicit, and idempotent. Do not modify unrelated services.",
    "7) If required info is missing or ambiguous, stop and ask targeted questions.",
    "",
    "Validation commands to run/report for the devcontainer path:",
    "- devrouter setup --yes --json",
    "- devrouter doctor --repo <REPO_PATH> --json",
    "- devrouter repo inspect --repo <REPO_PATH> --json",
    "- devrouter repo devcontainer write --repo <REPO_PATH> --dry-run --json",
    "- devrouter repo devcontainer write --repo <REPO_PATH> --yes",
    "- devrouter repo devcontainer verify --repo <REPO_PATH> --json",
    "- In a linked worktree: devrouter workspace ensure <REPO_PATH>",
    "- In a primary checkout after `devpod up <REPO_PATH>`: devrouter repo devcontainer verify --repo <REPO_PATH> --live --yes --json",
    "",
    "Validation commands to run/report for host/docker runtime apps:",
    "- devrouter setup --yes --json",
    "- devrouter doctor --repo <REPO_PATH> --json",
    "- devrouter app ls --repo <REPO_PATH>",
    "- For each entry (when safe): devrouter app run <name> --repo <REPO_PATH> --yes",
    "- Run one-shot commands with dep env: devrouter app exec <name> --repo <REPO_PATH> --yes -- <command>",
    "- Probe effective env before migration/seed: devrouter app exec <name> --repo <REPO_PATH> --yes -- printenv DB_URL DB_HOST DB_PORT DB_SHADOW_URL",
    "- devrouter ls",
    "- For HTTP entries: curl -I http://<host>",
    '- For TCP postgres entries: provide connection hint (example: psql "... sslmode=require")',
    "",
    "Output format (strict):",
    "1) Repository structure summary relevant to routing.",
    "2) Proposed app mapping (name/host/protocol/runtime/deps) with assumptions.",
    "3) Exact file changes made (.devrouter.yml and any minimal related files you touched).",
    "4) Concise diff summary.",
    "5) Validation commands run + key outputs.",
    "6) Unresolved questions/risks (if any).",
    "7) Definition-of-done checklist status:",
    "   - .devrouter.yml exists and validates",
    "   - devrouter app ls matches expected entries",
    "   - devrouter ls exposes expected endpoints",
    "   - HTTP routes reachable",
    "   - TCP Postgres route configured with TLS requirement noted",
    "",
    renderCommandIntentSection(),
  ].join("\n");
}

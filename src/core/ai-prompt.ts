import { resolveRepoPath } from "./repo-config";

export type InitPromptOptions = {
  repo?: string;
  entriesJson?: string;
  withLinear?: boolean;
};

export type CommandIntent = {
  command: string;
  purpose: string;
};

export const COMMAND_INTENTS: CommandIntent[] = [
  {
    command: "dev init [--with-linear]",
    purpose: "Print the AI onboarding prompt template for a repository (non-mutating by default)."
  },
  { command: "dev up", purpose: "Start shared Traefik and ensure the shared devnet network." },
  { command: "dev down", purpose: "Stop the shared Traefik router stack." },
  { command: "dev status", purpose: "Show router/container/network/TLS health and bound ports." },
  { command: "dev doctor", purpose: "Run deep diagnostics across global router state and repo config." },
  { command: "dev ls", purpose: "List active HTTP and TCP routes resolved by devrouter." },
  { command: "dev open <name>", purpose: "Open HTTP routes or print connection hints for TCP routes (match app/service/host)." },
  { command: "dev tls install", purpose: "Install mkcert certs and enable TLS/HTTPS for local routing." },
  { command: "dev repo init", purpose: "Create `.devrouter.yml` in a target repository." },
  { command: "dev app add", purpose: "Add or update one app entry in `.devrouter.yml`." },
  { command: "dev app ls", purpose: "List app entries from `.devrouter.yml`." },
  { command: "dev app run", purpose: "Run one configured app and reconcile its route at runtime." },
  {
    command: "dev app exec [--shell] [--env-map TARGET=SOURCE]",
    purpose: "Run a one-shot command with resolved dependency env vars and optional env alias mappings."
  },
  { command: "dev app rm", purpose: "Remove one app entry from `.devrouter.yml`." },
  {
    command: "dev repo agents [--with-linear]",
    purpose: "Write/update devrouter section in the repo's AGENTS.md and optionally add Linear workflow assets."
  }
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

export function buildOnboardingPrompt(options: InitPromptOptions = {}): string {
  const repoPath = resolveRepoPath(options.repo);
  const entriesJson = normalizeEntriesJson(options.entriesJson);
  const projectName = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  const withLinear = Boolean(options.withLinear);

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
    "- project.name: string (optional)",
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
    "- host: <name>.localhost",
    "- protocol: \"http\" | \"tcp\"",
    "- runtime: \"host\" | \"docker\"",
    "- dependencies: [{ app: \"<name>\" }] (optional)",
    "- if runtime=host:",
    "  - hostRun.command: string",
    "  - hostRun.cwd: string",
    "  - hostRun.strategy.type: \"auto\"",
    "  - hostRun.strategy.denyPorts: [80, 443, 5432]",
    "  - hostRun.strategy.allowPortRange: \"1024-65535\"",
    "- if runtime=docker:",
    "  - docker.service: string",
    "  - docker.internalPort: number",
    "  - docker.composeFiles: string[]",
    "  - optional docker.router: string",
    "- if protocol=tcp:",
    "  - tcpProtocol: \"postgres\"",
    "",
    "Validation rules to enforce:",
    "- host must end with .localhost",
    "- runtime=host supports protocol=http only",
    "- protocol=tcp requires runtime=docker and tcpProtocol=postgres",
    "- unknown keys are not allowed (strict schema)",
    "",
    "Docker compose file requirements:",
    "- Every service that acts as a dependency MUST define a healthcheck — devrouter uses `docker compose up --wait` which blocks until healthy; without a healthcheck the wait returns immediately and the dependent app may start before the service is ready.",
    "- Services MUST NOT publish host ports (`ports:` mapping) for any port owned by devrouter (80, 443, 5432) — Traefik owns these; conflicts cause bind failures.",
    "- Services SHOULD NOT publish host ports at all — devrouter handles external routing via Traefik labels; publishing ports creates conflicts when running multiple repos.",
    "- For TCP dependencies of host apps, devrouter automatically publishes a random host port and injects `<UPPER_NAME>_HOST` and `<UPPER_NAME>_PORT` env vars (e.g. `DB_HOST=localhost`, `DB_PORT=54321`).",
    "- For postgres deps, devrouter also injects `DATABASE_URL=postgres://prisma:prisma@localhost:<port>/prisma` and `SHADOW_DATABASE_URL=postgres://prisma:prisma@localhost:<port>/shadow` with fixed credentials. Prisma projects work out of the box; other frameworks can use DATABASE_URL directly or override it.",
    "- The Postgres service in docker-compose must use matching credentials (`POSTGRES_USER=prisma`, `POSTGRES_PASSWORD=prisma`, `POSTGRES_DB=prisma`) and create the shadow database (e.g. via an init script or the app's migration tool). If existing credentials differ, either update them to match or override `DATABASE_URL`/`SHADOW_DATABASE_URL` in the host app's environment.",
    "- If you changed postgres credentials/database defaults on an existing persistent volume, startup may still fail due to stale data. Recommend reconciling credentials or recreating volumes (for example `docker compose down -v`) when safe.",
    "- The TLS/SNI route on :5432 remains available for tools supporting `sslnegotiation=direct` (psql 17+, pgAdmin).",
    "- Example healthcheck for postgres: `test: [\"CMD-SHELL\", \"pg_isready -U <user> -d <db>\"]` with `interval: 5s`, `timeout: 3s`, `retries: 20`.",
    "",
    "Runtime behavior to account for:",
    "- Docker dependencies can be auto-started by dev app run.",
    "- dev app run waits for Docker dependencies to become healthy before starting the host app.",
    "- Docker dependencies are automatically stopped when the host app exits (Ctrl+C or error).",
    "- Recent dependency logs (last 20 lines) are printed after dependencies start.",
    "- Host-runtime dependencies are NOT auto-started in v1 (must be started manually).",
    "- For TCP dependencies of host apps, devrouter publishes a random host port and injects `<UPPER_NAME>_HOST=localhost` and `<UPPER_NAME>_PORT=<port>` env vars into the host app process.",
    "- For postgres deps, `DATABASE_URL` and `SHADOW_DATABASE_URL` are also injected automatically (fixed credentials `prisma:prisma`, databases `prisma`/`shadow`). Prisma projects work without extra config.",
    "- If the repo's Postgres docker-compose service uses different credentials than the injected defaults (`prisma:prisma`), flag this to the user and recommend aligning the compose env vars or overriding the injected URLs.",
    "- Postgres multiplexing on shared :5432 requires TLS/SNI (useful for psql 17+, pgAdmin, not standard app clients).",
    "- For TCP/Postgres, standard app frameworks should use the injected port env vars; only direct-TLS-capable tools should use sslmode=require on :5432.",
    "- `dev app exec <name> -- <command>` starts dependencies, resolves env vars, runs a one-shot command with the resolved env, then stops dependencies. Exec preserves argv semantics by default (`shell: false`) and supports explicit shell mode via `--shell` when needed.",
    "- `--env-map TARGET=SOURCE` (repeatable) copies env var values after dependency env resolution. Example: `--env-map DATABASE_URI=DATABASE_URL` for frameworks that expect `DATABASE_URI`.",
    "",
    "Secret Manager Interop (Infisical/Doppler):",
    "- devrouter injects dependency env vars first (`<UPPER_NAME>_HOST`, `<UPPER_NAME>_PORT`, and for postgres: `DATABASE_URL`, `SHADOW_DATABASE_URL`).",
    "- Secret managers may also define DB variables. Do not assume secret-manager precedence. Confirm the effective values in the command process before migrate/seed.",
    "- For non-Prisma apps that require `DATABASE_URI`, use deterministic mapping: `--env-map DATABASE_URI=DATABASE_URL`.",
    "- Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`; wrapper-managed env may override those values.",
    "- Safe hostRun command pattern when wrapper also defines DATABASE_URI: `infisical run --projectId <id> --env=<env> -- env DATABASE_URI=${DATABASE_URL:?missing DATABASE_URL} pnpm dev`.",
    "- `dev doctor --repo <REPO_PATH>` warns on risky pre-wrapper DB assignments before `run --` for host apps that depend on postgres.",
    "- Robust one-shot migrate example (argv-safe, no nested shell quoting): `dev app exec <name> --repo <REPO_PATH> --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload migrate`.",
    "- Robust one-shot seed example: `dev app exec <name> --repo <REPO_PATH> --yes --env-map DATABASE_URI=DATABASE_URL -- infisical run --projectId <id> --env=<env> -- pnpm payload seed`.",
    "- Environment probe/debug example (run before migrations): `dev app exec <name> --repo <REPO_PATH> --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL`.",
    "- Use `--shell` only when shell expansion is required; it must receive exactly one command string after `--`.",
    "- Warning: Do not run migration/seed until env probe confirms expected DB variables and values.",
    "",
    "Required workflow:",
    "1) Inspect repository structure first (compose files, scripts, app folders, existing dev docs).",
    "2) Create/update REPO_PATH/.devrouter.yml. If required for compliance, make only minimal related edits (for example docker-compose.yml, db init scripts, or existing dev script wiring).",
    "3) For host apps, prefer existing repo dev scripts (pnpm dev/npm run dev/etc.) over handcrafted command chains.",
    "4) If any tcp/postgres app is configured, run `dev up` and `dev tls install` before runtime validation.",
    "5) Keep edits minimal, explicit, and idempotent. Do not modify unrelated services.",
    "6) If required info is missing or ambiguous, stop and ask targeted questions.",
    "",
    "Validation commands to run/report:",
    "- dev up",
    "- If tcp/postgres exists: dev tls install",
    "- dev app ls --repo <REPO_PATH>",
    "- For each entry (when safe): dev app run <name> --repo <REPO_PATH> --yes",
    "- Run one-shot commands with dep env: dev app exec <name> --repo <REPO_PATH> --yes -- <command>",
    "- Run non-Prisma mapping flow: dev app exec <name> --repo <REPO_PATH> --yes --env-map DATABASE_URI=DATABASE_URL -- <command>",
    "- Probe effective env before migration/seed: dev app exec <name> --repo <REPO_PATH> --yes --env-map DATABASE_URI=DATABASE_URL -- printenv DATABASE_URL DATABASE_URI DB_HOST DB_PORT SHADOW_DATABASE_URL",
    "- dev doctor --repo <REPO_PATH> --json",
    "- dev ls",
    "- For HTTP entries: curl -I http://<host>",
    "- For TCP postgres entries: provide connection hint (example: psql \"... sslmode=require\")",
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
    "   - dev app ls matches expected entries",
    "   - dev ls exposes expected endpoints",
    "   - HTTP routes reachable",
    "   - TCP Postgres route configured with TLS requirement noted",
    ...(withLinear
      ? [
          "",
          "Linear milestone workflow (enabled via --with-linear):",
          "- Before creating/updating Linear issues, confirm repository mapping basics with the user:",
          "  - Which Linear workspace does this repository belong to?",
          "  - Which Linear team owns this repository? (optional team key)",
          "  - Which Linear project should this work use? (optional project id)",
          "- When `--with-linear` is used together with AGENTS write flows, persist answers into the managed AGENTS block between:",
          "  - `<!-- devrouter-linear-workflow-config:start -->`",
          "  - `<!-- devrouter-linear-workflow-config:end -->`",
          "- If placeholders are present in that block, ask these questions again and update the mapping.",
          "- While implementing Linear-tracked work, set issue status at session start and at each phase transition.",
          "- Post progress comments at meaningful checkpoints during implementation (not only at the end).",
          "- Before ending a session, post a final recap comment with completed work, remaining work, risks, and next step, then re-check status/comment freshness.",
          "- Optional bootstrap commands for repo artifacts: `dev init --repo <REPO_PATH> --with-linear --write-agents --write-skill` or `dev repo agents --repo <REPO_PATH> --with-linear`.",
          "- If the repository uses devrouter, read the upstream devrouter release guidance at https://github.com/rolandhordos/devrouter/blob/main/CHANGELOG.md and apply the latest Agent Adaptation Prompt before major changes.",
          "- This is devrouter release guidance and does not require creating CHANGELOG.md in the target repository unless that repository already has its own policy."
        ]
      : []),
    "",
    renderCommandIntentSection()
  ].join("\n");
}

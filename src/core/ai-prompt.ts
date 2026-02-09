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
  { command: "dev init", purpose: "Print the AI onboarding prompt template for a repository." },
  { command: "dev up", purpose: "Start shared Traefik and ensure the shared devnet network." },
  { command: "dev down", purpose: "Stop the shared Traefik router stack." },
  { command: "dev status", purpose: "Show router/container/network/TLS health and bound ports." },
  { command: "dev doctor", purpose: "Run deep diagnostics across global router state and repo config." },
  { command: "dev ls", purpose: "List active HTTP and TCP routes resolved by devrouter." },
  { command: "dev open <name>", purpose: "Open HTTP routes or print connection hints for TCP routes." },
  { command: "dev tls install", purpose: "Install mkcert certs and enable TLS/HTTPS for local routing." },
  { command: "dev repo init", purpose: "Create `.devrouter.yml` in a target repository." },
  { command: "dev app add", purpose: "Add or update one app entry in `.devrouter.yml`." },
  { command: "dev app ls", purpose: "List app entries from `.devrouter.yml`." },
  { command: "dev app run", purpose: "Run one configured app and reconcile its route at runtime." },
  { command: "dev app exec", purpose: "Run a one-shot command with resolved dependency env vars (e.g. prisma migrate, seed)." },
  { command: "dev app rm", purpose: "Remove one app entry from `.devrouter.yml`." }
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
    "Entry schema (each object):",
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
    "- `dev app exec <name> -- <command>` starts dependencies, resolves env vars, runs a one-shot command with the resolved env, then stops dependencies. Use this for database migrations, seeding, or any CLI tool that needs dependency env vars (e.g. `dev app exec web --yes -- npx prisma migrate dev`).",
    "",
    "Required workflow:",
    "1) Inspect repository structure first (compose files, scripts, app folders, existing dev docs).",
    "2) Create/update only REPO_PATH/.devrouter.yml.",
    "3) Keep edits minimal and idempotent.",
    "4) Do not modify unrelated files/services.",
    "5) If required info is missing or ambiguous, stop and ask targeted questions.",
    "",
    "Validation commands to run/report:",
    "- dev app ls --repo <REPO_PATH>",
    "- For each entry (when safe): dev app run <name> --repo <REPO_PATH> --yes",
    "- Run one-shot commands with dep env: dev app exec <name> --repo <REPO_PATH> --yes -- <command>",
    "- dev doctor --repo <REPO_PATH> --json",
    "- dev ls",
    "- For HTTP entries: curl -I http://<host>",
    "- For TCP postgres entries: provide connection hint (example: psql \"... sslmode=require\")",
    "",
    "Output format (strict):",
    "1) Repository structure summary relevant to routing.",
    "2) Proposed app mapping (name/host/protocol/runtime/deps) with assumptions.",
    "3) Exact file changes made to .devrouter.yml.",
    "4) Concise diff summary.",
    "5) Validation commands run + key outputs.",
    "6) Unresolved questions/risks (if any).",
    "7) Definition-of-done checklist status:",
    "   - .devrouter.yml exists and validates",
    "   - dev app ls matches expected entries",
    "   - dev ls exposes expected endpoints",
    "   - HTTP routes reachable",
    "   - TCP Postgres route configured with TLS requirement noted",
    "",
    renderCommandIntentSection()
  ].join("\n");
}

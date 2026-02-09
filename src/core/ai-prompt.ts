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
    "- If a service needs to be reachable from host apps, use the devrouter hostname (e.g. `demo-db.localhost:5432`) instead of `localhost:<mapped-port>`.",
    "- Example healthcheck for postgres: `test: [\"CMD-SHELL\", \"pg_isready -U <user> -d <db>\"]` with `interval: 5s`, `timeout: 3s`, `retries: 20`.",
    "",
    "Runtime behavior to account for:",
    "- Docker dependencies can be auto-started by dev app run.",
    "- dev app run waits for Docker dependencies to become healthy before starting the host app.",
    "- Docker dependencies are automatically stopped when the host app exits (Ctrl+C or error).",
    "- Recent dependency logs (last 20 lines) are printed after dependencies start.",
    "- Host-runtime dependencies are NOT auto-started in v1 (must be started manually).",
    "- Postgres multiplexing on shared :5432 requires TLS/SNI.",
    "- For TCP/Postgres, expect clients to use sslmode=require (or stricter).",
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

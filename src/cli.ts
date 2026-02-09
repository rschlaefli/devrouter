#!/usr/bin/env node
import { Command } from "commander";

declare const __VERSION__: string;
const CLI_VERSION: string = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

function withErrorHandling<TArgs extends unknown[]>(
  action: (...args: TArgs) => Promise<void>
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await action(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  };
}

const program = new Command();
program
  .name("dev")
  .description("Local dev router CLI for stable .localhost routing across repositories")
  .version(CLI_VERSION)
  .showSuggestionAfterError(true)
  .showHelpAfterError();

program
  .command("init")
  .description("Print an AI onboarding prompt template for adapting a repository to devrouter")
  .option("--repo <path>", "Repository path to embed in the prompt (defaults to current directory)")
  .option("--entries-json <json>", "Optional JSON array of app entries to embed in the prompt")
  .option("--json", "Output prompt and command intents as JSON")
  .action(withErrorHandling(async (options: { repo?: string; entriesJson?: string; json?: boolean }) => {
    const { runInitCommand } = await import("./commands/init");
    await runInitCommand(options);
  }));

program
  .command("up")
  .description("Ensure devnet and start shared Traefik (reserves 80/443/5432)")
  .action(withErrorHandling(async () => {
    const { runUpCommand } = await import("./commands/up");
    await runUpCommand();
  }));

program
  .command("down")
  .description("Stop the shared Traefik router stack")
  .action(withErrorHandling(async () => {
    const { runDownCommand } = await import("./commands/down");
    await runDownCommand();
  }));

program
  .command("status")
  .description("Show router/container/network/TLS status and bound ports")
  .option("--json", "Output JSON")
  .option("--repo <path>", "Repository path for repo-specific readiness insights")
  .action(withErrorHandling(async (options: { json?: boolean; repo?: string }) => {
    const { runStatusCommand } = await import("./commands/status");
    await runStatusCommand(options);
  }));

program
  .command("doctor")
  .alias("verify")
  .description("Run global + repo diagnostics with actionable fixes for humans and AI agents")
  .option("--repo <path>", "Repository path to validate (defaults to current directory)")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { repo?: string; json?: boolean }) => {
    const { runDoctorCommand } = await import("./commands/doctor");
    await runDoctorCommand(options);
  }));

program
  .command("ls")
  .alias("list")
  .description("List active HTTP and TCP routes from Docker labels and host runtime state")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { json?: boolean }) => {
    const { runLsCommand } = await import("./commands/ls");
    await runLsCommand(Boolean(options.json));
  }));

program
  .command("open")
  .description("Open HTTP routes in browser or show TCP connection hints by name/host")
  .argument("<name>", "service name or host")
  .action(withErrorHandling(async (name: string) => {
    const { runOpenCommand } = await import("./commands/open");
    await runOpenCommand(name);
  }));

program
  .command("logs")
  .description("Show Traefik router logs (useful for diagnosing routing issues)")
  .option("-f, --follow", "Follow log output")
  .option("--tail <lines>", "Number of lines to show from end of logs", "100")
  .action(withErrorHandling(async (options: { follow?: boolean; tail?: string }) => {
    const { runLogsCommand } = await import("./commands/logs");
    await runLogsCommand(options);
  }));

const repoCommand = program.command("repo").description("Create and manage `.devrouter.yml` in repositories");

repoCommand
  .command("init")
  .description("Initialize `.devrouter.yml` in a repository")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (options: { repo?: string }) => {
    const { runRepoInitCommand } = await import("./commands/repo-init");
    await runRepoInitCommand(options);
  }));

repoCommand
  .command("agents")
  .description("Write/update devrouter section in the repo's AGENTS.md")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (options: { repo?: string }) => {
    const { runRepoAgentsCommand } = await import("./commands/repo-agents");
    await runRepoAgentsCommand(options);
  }));

const appCommand = program.command("app").description("Manage app entries and runtime actions from `.devrouter.yml`");

appCommand
  .command("add")
  .description("Add or update one app definition in `.devrouter.yml`")
  .requiredOption("--name <name>", "App name")
  .requiredOption("--host <host>", "Hostname ending with .localhost")
  .requiredOption("--protocol <protocol>", "http or tcp")
  .requiredOption("--runtime <runtime>", "host or docker")
  .option("--service <service>", "Docker service name (runtime=docker)")
  .option("--port <port>", "Internal port (runtime=docker)", (value) => Number(value))
  .option("--compose-file <file>", "Compose file path (repeatable)", (value, prev: string[] | undefined) => {
    const next = prev ?? [];
    next.push(value);
    return next;
  })
  .option("--router <id>", "Optional Traefik router ID")
  .option("--tcp-protocol <protocol>", "tcp protocol (postgres)")
  .option("--command <command>", "Host command (runtime=host)")
  .option("--cwd <path>", "Host command working directory (runtime=host)")
  .option("--depends-on <app>", "Dependency app name (repeatable)", (value, prev: string[] | undefined) => {
    const next = prev ?? [];
    next.push(value);
    return next;
  })
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (options: {
    name: string;
    host: string;
    protocol: "http" | "tcp";
    runtime: "host" | "docker";
    service?: string;
    port?: number;
    composeFile?: string[];
    router?: string;
    tcpProtocol?: "postgres";
    command?: string;
    cwd?: string;
    dependsOn?: string[];
    repo?: string;
  }) => {
    const { runAppAddCommand } = await import("./commands/app-add");
    await runAppAddCommand(options);
  }));

appCommand
  .command("ls")
  .description("List app definitions from `.devrouter.yml`")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { repo?: string; json?: boolean }) => {
    const { runAppLsCommand } = await import("./commands/app-ls");
    await runAppLsCommand(options);
  }));

appCommand
  .command("run")
  .description("Run one configured app and reconcile its active route")
  .argument("<name>", "Configured app name")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .option("--yes", "Auto-start dependencies without prompt")
  .action(withErrorHandling(async (name: string, _options: unknown, command: Command) => {
    const options = command.opts<{ repo?: string; yes?: boolean }>();
    const { runAppRunCommand } = await import("./commands/app-run");
    await runAppRunCommand({ name, repo: options.repo, yes: Boolean(options.yes) });
  }));

appCommand
  .command("exec")
  .description("Run a one-shot command with resolved dependency env vars (e.g. prisma migrate)")
  .argument("<name>", "Configured app name")
  .argument("<command...>", "Command to execute (use -- to separate)")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .option("--yes", "Auto-start dependencies without prompt")
  .action(withErrorHandling(async (name: string, commandParts: string[], _options: unknown, command: Command) => {
    const options = command.opts<{ repo?: string; yes?: boolean }>();
    const { runAppExecCommand } = await import("./commands/app-exec");
    await runAppExecCommand({
      name,
      repo: options.repo,
      yes: Boolean(options.yes),
      command: commandParts.join(" ")
    });
  }));

appCommand
  .command("rm")
  .description("Remove one app definition from `.devrouter.yml`")
  .argument("<name>", "Configured app name")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (name: string, _options: unknown, command: Command) => {
    const options = command.opts<{ repo?: string }>();
    const { runAppRmCommand } = await import("./commands/app-rm");
    await runAppRmCommand({ name, repo: options.repo });
  }));

const tlsCommand = program.command("tls").description("TLS helpers for HTTPS and Postgres SNI routing");

tlsCommand
  .command("install")
  .description("Install mkcert certs and enable HTTPS + TLS redirect behavior")
  .action(withErrorHandling(async () => {
    const { runTLSInstallCommand } = await import("./commands/tls");
    await runTLSInstallCommand();
  }));

program.parseAsync(process.argv);

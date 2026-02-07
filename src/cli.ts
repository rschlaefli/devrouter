#!/usr/bin/env node
import { Command } from "commander";

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
  .description("Local dev router CLI")
  .version("0.1.0")
  .showSuggestionAfterError(true)
  .showHelpAfterError();

program
  .command("up")
  .description("Ensure devnet and start shared Traefik router")
  .action(withErrorHandling(async () => {
    const { runUpCommand } = await import("./commands/up");
    await runUpCommand();
  }));

program
  .command("down")
  .description("Stop shared Traefik router")
  .action(withErrorHandling(async () => {
    const { runDownCommand } = await import("./commands/down");
    await runDownCommand();
  }));

program
  .command("status")
  .description("Show router status")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { json?: boolean }) => {
    const { runStatusCommand } = await import("./commands/status");
    await runStatusCommand(Boolean(options.json));
  }));

program
  .command("ls")
  .alias("list")
  .description("List discovered routed services")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { json?: boolean }) => {
    const { runLsCommand } = await import("./commands/ls");
    await runLsCommand(Boolean(options.json));
  }));

program
  .command("open")
  .description("Open a routed service by name/host")
  .argument("<name>", "service name or host")
  .action(withErrorHandling(async (name: string) => {
    const { runOpenCommand } = await import("./commands/open");
    await runOpenCommand(name);
  }));

const repoCommand = program.command("repo").description("Manage per-repository .devrouter.yml config");

repoCommand
  .command("init")
  .description("Initialize .devrouter.yml in a repository")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (options: { repo?: string }) => {
    const { runRepoInitCommand } = await import("./commands/repo-init");
    await runRepoInitCommand(options);
  }));

const appCommand = program.command("app").description("Manage configured apps in .devrouter.yml");

appCommand
  .command("add")
  .description("Add or update an app definition in .devrouter.yml")
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
  .description("List apps from .devrouter.yml")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { repo?: string; json?: boolean }) => {
    const { runAppLsCommand } = await import("./commands/app-ls");
    await runAppLsCommand(options);
  }));

appCommand
  .command("run")
  .description("Run an app by name from .devrouter.yml")
  .argument("<name>", "Configured app name")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .option("--yes", "Auto-start dependencies without prompt")
  .action(withErrorHandling(async (name: string, _options: unknown, command: Command) => {
    const options = command.opts<{ repo?: string; yes?: boolean }>();
    const { runAppRunCommand } = await import("./commands/app-run");
    await runAppRunCommand({ name, repo: options.repo, yes: Boolean(options.yes) });
  }));

appCommand
  .command("rm")
  .description("Remove an app from .devrouter.yml")
  .argument("<name>", "Configured app name")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (name: string, _options: unknown, command: Command) => {
    const options = command.opts<{ repo?: string }>();
    const { runAppRmCommand } = await import("./commands/app-rm");
    await runAppRmCommand({ name, repo: options.repo });
  }));

program
  .command("add")
  .description("Legacy alias (deprecated)")
  .allowUnknownOption(true)
  .action(withErrorHandling(async () => {
    const { runLegacyAddCommand } = await import("./commands/add");
    await runLegacyAddCommand();
  }));

const tlsCommand = program.command("tls").description("TLS helpers");

tlsCommand
  .command("install")
  .description("Install mkcert certs and enable HTTPS redirect")
  .action(withErrorHandling(async () => {
    const { runTLSInstallCommand } = await import("./commands/tls");
    await runTLSInstallCommand();
  }));

const hostCommand = program.command("host").description("Legacy host commands (deprecated)");

hostCommand
  .command("run")
  .description("Legacy command (deprecated)")
  .allowUnknownOption(true)
  .action(withErrorHandling(async () => {
    const { runHostRunCommand } = await import("./commands/host-run");
    await runHostRunCommand();
  }));

hostCommand
  .command("attach")
  .description("Legacy command (deprecated)")
  .allowUnknownOption(true)
  .action(withErrorHandling(async () => {
    const { runHostAttachCommand } = await import("./commands/host-attach");
    await runHostAttachCommand();
  }));

hostCommand
  .command("ls")
  .description("Legacy command (deprecated)")
  .allowUnknownOption(true)
  .action(withErrorHandling(async () => {
    const { runHostLsCommand } = await import("./commands/host-ls");
    await runHostLsCommand();
  }));

hostCommand
  .command("rm")
  .description("Legacy command (deprecated)")
  .allowUnknownOption(true)
  .action(withErrorHandling(async () => {
    const { runHostRmCommand } = await import("./commands/host-rm");
    await runHostRmCommand();
  }));

program.parseAsync(process.argv);

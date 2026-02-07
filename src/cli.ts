#!/usr/bin/env node
import { Command } from "commander";
import { runAddCommand } from "./commands/add";
import { runDownCommand } from "./commands/down";
import { runLsCommand } from "./commands/ls";
import { runOpenCommand } from "./commands/open";
import { runStatusCommand } from "./commands/status";
import { runTLSInstallCommand } from "./commands/tls";
import { runUpCommand } from "./commands/up";

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
  .action(withErrorHandling(() => runUpCommand()));

program
  .command("down")
  .description("Stop shared Traefik router")
  .action(withErrorHandling(() => runDownCommand()));

program
  .command("status")
  .description("Show router status")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { json?: boolean }) => {
    await runStatusCommand(Boolean(options.json));
  }));

program
  .command("ls")
  .alias("list")
  .description("List discovered routed services")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { json?: boolean }) => {
    await runLsCommand(Boolean(options.json));
  }));

program
  .command("open")
  .description("Open a routed service by name/host")
  .argument("<name>", "service name or host")
  .action(withErrorHandling(async (name: string) => {
    await runOpenCommand(name);
  }));

program
  .command("add")
  .description("Generate or update docker-compose.devrouter.yml for a service")
  .requiredOption("--service <service>", "Compose service name")
  .requiredOption("--port <port>", "Internal container port", (value) => Number(value))
  .option("--host <hostname>", "Hostname, defaults to <service>.localhost")
  .option("--router <id>", "Router id, defaults to <service>")
  .option("--file <path>", "Override file path", "docker-compose.devrouter.yml")
  .option("--force", "Allow non-.localhost hostnames")
  .action(withErrorHandling(async (options: {
    service: string;
    port: number;
    host?: string;
    router?: string;
    file?: string;
    force?: boolean;
  }) => {
    await runAddCommand({
      service: options.service,
      port: options.port,
      host: options.host,
      router: options.router,
      file: options.file,
      force: options.force
    });
  }));

const tlsCommand = program.command("tls").description("TLS helpers");

tlsCommand
  .command("install")
  .description("Install mkcert certs and enable HTTPS redirect")
  .action(withErrorHandling(() => runTLSInstallCommand()));

program.parseAsync(process.argv);

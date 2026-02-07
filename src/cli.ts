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
    const { runAddCommand } = await import("./commands/add");
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
  .action(withErrorHandling(async () => {
    const { runTLSInstallCommand } = await import("./commands/tls");
    await runTLSInstallCommand();
  }));

const hostCommand = program.command("host").description("Manage host-run app routes");

hostCommand
  .command("run")
  .description("Run configured host app command and keep route synced")
  .requiredOption("--name <name>", "Route name from devrouter.host.yml")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (options: { name: string; repo?: string }) => {
    const { runHostRunCommand } = await import("./commands/host-run");
    await runHostRunCommand(options);
  }));

hostCommand
  .command("attach")
  .description("Attach route sync to an already running host app process")
  .requiredOption("--name <name>", "Route name from devrouter.host.yml")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (options: { name: string; repo?: string }) => {
    const { runHostAttachCommand } = await import("./commands/host-attach");
    await runHostAttachCommand(options);
  }));

hostCommand
  .command("ls")
  .description("List host-run routes managed by devrouter")
  .option("--json", "Output JSON")
  .action(withErrorHandling(async (options: { json?: boolean }) => {
    const { runHostLsCommand } = await import("./commands/host-ls");
    await runHostLsCommand(Boolean(options.json));
  }));

hostCommand
  .command("rm")
  .description("Remove a host-run route from devrouter state")
  .requiredOption("--name <name>", "Route name from devrouter.host.yml")
  .option("--repo <path>", "Repository path (defaults to current directory)")
  .action(withErrorHandling(async (options: { name: string; repo?: string }) => {
    const { runHostRmCommand } = await import("./commands/host-rm");
    await runHostRmCommand(options);
  }));

program.parseAsync(process.argv);

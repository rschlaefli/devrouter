import { AppAddOptions } from "../types";
import { resolveRepoPath, upsertRepoApp } from "../core/repo-config";

type CliAppAddOptions = {
  name: string;
  kind?: "app" | "dependency";
  host?: string;
  protocol?: "http" | "tcp";
  runtime?: "host" | "docker";
  service?: string;
  port?: number;
  composeFile?: string[];
  router?: string;
  tcpProtocol?: "postgres";
  command?: string;
  cwd?: string;
  dependsOn?: string[];
  repo?: string;
};

function normalizeOptions(options: CliAppAddOptions): AppAddOptions {
  return {
    name: options.name,
    kind: options.kind,
    host: options.host,
    protocol: options.protocol,
    runtime: options.runtime,
    service: options.service,
    port: options.port,
    composeFiles: options.composeFile ?? [],
    router: options.router,
    tcpProtocol: options.tcpProtocol,
    command: options.command,
    cwd: options.cwd,
    dependsOn: options.dependsOn ?? []
  };
}

export async function runAppAddCommand(options: CliAppAddOptions): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  const result = upsertRepoApp(repoPath, normalizeOptions(options));
  process.stdout.write(`Updated ${result.configPath}\n`);
  if (result.app.kind === "dependency") {
    process.stdout.write(
      `App '${result.app.name}' (dependency/${result.app.runtime}) -> service ${result.app.docker.service}\n`
    );
    process.stdout.write(
      `Dependency-only apps are auto-started via --depends-on. They are not runnable directly.\n`
    );
  } else {
    const protocol = result.app.protocol === "tcp" ? `tcp/${result.app.tcpProtocol}` : result.app.protocol;
    process.stdout.write(
      `App '${result.app.name}' (${protocol}/${result.app.runtime}) -> ${result.app.host}\n`
    );
    process.stdout.write(`Run: dev app run ${result.app.name} --repo ${repoPath}\n`);
  }
}

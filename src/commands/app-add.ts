import { AppAddOptions } from "../types";
import { resolveRepoPath, upsertRepoApp } from "../core/repo-config";

type CliAppAddOptions = {
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
};

function normalizeOptions(options: CliAppAddOptions): AppAddOptions {
  return {
    name: options.name,
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
  process.stdout.write(
    `App '${result.app.name}' (${result.app.protocol}/${result.app.runtime}) -> ${result.app.host}\n`
  );
  process.stdout.write(`Run: dev app run ${result.app.name} --repo ${repoPath}\n`);
}

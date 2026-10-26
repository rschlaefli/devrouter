import { spawn } from "node:child_process";
import { constants } from "node:os";
import { collectHostEnvReport, type HostEnvReport, hostEnvVariables } from "../core/host-env";
import { assertManagedHostPortsAvailable } from "../core/managed-host-ports";
import { printJSON } from "../core/output";
import { resolveGitCheckoutPath } from "./environment-path";

export type EnvInvocation = { path?: string; json: boolean; command?: string[] };

const HOST_PORT_ENV_PREFIX = "DEVROUTER_HOST_PORT_";

export function parseEnvInvocation(args: string[]): EnvInvocation {
  const separator = args.indexOf("--");
  const before = separator < 0 ? args : args.slice(0, separator);
  const command = separator < 0 ? undefined : args.slice(separator + 1);
  const json = before.includes("--json");
  const positional = before.filter((arg) => arg !== "--json");
  const unknown = positional.find((arg) => arg.startsWith("-"));
  if (unknown) throw new Error(`Unknown option '${unknown}' for devrouter env.`);
  if (positional.length > 1) {
    throw new Error("devrouter env accepts at most one checkout path.");
  }
  if (command !== undefined && command.length === 0) {
    throw new Error("No command provided after `--`.");
  }
  if (command && json) {
    throw new Error("--json reports the environment; it cannot be combined with a command.");
  }
  return {
    ...(positional[0] ? { path: positional[0] } : {}),
    json,
    ...(command ? { command } : {}),
  };
}

function formatEnvReport(report: HostEnvReport): string {
  const lines = [
    `Checkout:  ${report.repoPath}`,
    `Workspace: ${report.workspace ?? "(primary checkout)"}`,
    `CA:        ${report.caPath ?? `unavailable (${report.caReason})`}`,
    "",
  ];
  for (const app of report.apps) {
    const state = app.active ? "active" : "inactive";
    if (app.protocol === "http") {
      lines.push(`${app.name}  ${app.url}  (${state})`);
      continue;
    }
    const params = new URLSearchParams(app.routed.params).toString();
    const loopback = app.loopback
      ? `loopback ${app.loopback.host}:${app.loopback.port}`
      : `loopback unavailable (${app.loopbackReason})`;
    lines.push(
      `${app.name}  ${app.tcpProtocol} routed ${app.routed.host}:${app.routed.port}${params ? ` ?${params}` : ""}; ${loopback}  (${state})`,
    );
  }
  if (report.hostPorts) {
    lines.push("", "Host ports:");
    for (const [name, port] of Object.entries(report.hostPorts)) {
      const target = `${port.service}:${port.target}`;
      if (port.status === "available" && port.endpoint) {
        lines.push(
          `  ${name}  ${target} -> ${port.endpoint.host}:${port.endpoint.port}  (available)`,
        );
        continue;
      }
      const detail = port.reason ? `${port.status}: ${port.reason}` : port.status;
      lines.push(`  ${name}  ${target}  (${detail})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function hostCommandEnvironment(
  report: HostEnvReport,
  processEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...processEnv };
  for (const name of Object.keys(env)) {
    if (name.startsWith(HOST_PORT_ENV_PREFIX)) delete env[name];
  }
  return Object.assign(env, hostEnvVariables(report, processEnv));
}

/** Runs argv without a shell and resolves to the child's exit code. */
export function runHostCommand(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers = [
      ["SIGINT", forward("SIGINT")],
      ["SIGTERM", forward("SIGTERM")],
    ] as const;
    for (const [signal, handler] of handlers) process.on(signal, handler);
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      process.stderr.write(`devrouter env: cannot run '${command[0]}': ${error.message}\n`);
      settle(error.code === "ENOENT" ? 127 : 126);
    });
    child.on("exit", (code, signal) => {
      settle(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}

export async function runEnvCommand(invocation: EnvInvocation): Promise<void> {
  const report = await collectHostEnvReport(resolveGitCheckoutPath(invocation.path));
  if (invocation.command) {
    assertManagedHostPortsAvailable(report.hostPorts ?? {});
    process.exitCode = await runHostCommand(
      invocation.command,
      hostCommandEnvironment(report, process.env),
    );
    return;
  }
  if (invocation.json) {
    printJSON(report);
    return;
  }
  process.stdout.write(formatEnvReport(report));
}

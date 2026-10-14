import { collectHostEnvReport, type HostEnvReport } from "../core/host-env";
import { printJSON } from "../core/output";
import { resolveGitCheckoutPath } from "./environment-path";

export type EnvInvocation = { path?: string; json: boolean };

export function parseEnvInvocation(args: string[]): EnvInvocation {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const unknown = positional.find((arg) => arg.startsWith("-"));
  if (unknown) throw new Error(`Unknown option '${unknown}' for devrouter env.`);
  if (positional.length > 1) {
    throw new Error("devrouter env accepts at most one checkout path.");
  }
  return { ...(positional[0] ? { path: positional[0] } : {}), json };
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
  return `${lines.join("\n")}\n`;
}

export async function runEnvCommand(invocation: EnvInvocation): Promise<void> {
  const report = await collectHostEnvReport(resolveGitCheckoutPath(invocation.path));
  if (invocation.json) {
    printJSON(report);
    return;
  }
  process.stdout.write(formatEnvReport(report));
}

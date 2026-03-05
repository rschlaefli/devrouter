import { clearActiveTcpProtocols, stopRouterStack } from "../core/router";

export async function runDownCommand(): Promise<void> {
  stopRouterStack();
  clearActiveTcpProtocols();
  process.stdout.write("devrouter is down.\n");
}

import { stopRouterStack } from "../core/router";

export async function runDownCommand(): Promise<void> {
  stopRouterStack();
  process.stdout.write("devrouter is down.\n");
}

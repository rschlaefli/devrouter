import { ensureNetwork, isContainerRunning } from "../core/docker";
import {
  DEVNET_NAME,
  ensureRouterFiles,
  ROUTER_CONTAINER_NAME,
  startRouterStack,
} from "../core/router";
import { findPortListeners } from "../util/ports";

function buildPortConflictMessage(): string {
  const listeners = [
    ...findPortListeners(80),
    ...findPortListeners(443),
    ...findPortListeners(5432),
  ];

  if (listeners.length === 0) {
    return "";
  }

  const details = listeners
    .map((listener) => {
      return `- port ${listener.port}: ${listener.command} (pid ${listener.pid}, user ${listener.user}, ${listener.address})`;
    })
    .join("\n");

  return `Cannot start devrouter because host ports 80/443/5432 are already in use:\n${details}\n\nMitigation:\n1) Stop the conflicting process/container\n2) Re-run: dev up\n\nDebug commands:\n- lsof -nP -iTCP:80 -sTCP:LISTEN\n- lsof -nP -iTCP:443 -sTCP:LISTEN\n- lsof -nP -iTCP:5432 -sTCP:LISTEN`;
}

export async function runUpCommand(): Promise<void> {
  await ensureNetwork(DEVNET_NAME);
  ensureRouterFiles();

  const routerRunning = await isContainerRunning(ROUTER_CONTAINER_NAME);
  if (!routerRunning) {
    const message = buildPortConflictMessage();
    if (message) {
      throw new Error(message);
    }
  }

  startRouterStack();
  process.stdout.write("devrouter is up.\n");
}

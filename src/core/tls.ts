import { spawnSync } from "node:child_process";
import {
  CERT_FILE,
  CERT_KEY_FILE,
  ensureRouterFiles,
  isTLSEnabled,
  setTLSEnabled,
  startRouterStack
} from "./router";
import { isContainerRunning, findContainerByName } from "./docker";
import { refreshHostRoutesDynamicFile } from "./host-routes";

function runOrThrow(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    encoding: "utf-8"
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${details || "unknown error"}`);
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf-8" });
  return result.status === 0;
}

function ensureMkcert(): void {
  if (commandExists("mkcert")) {
    return;
  }

  if (!commandExists("brew")) {
    throw new Error("mkcert is missing and Homebrew is not available.");
  }

  runOrThrow("brew", ["install", "mkcert"]);
}

export async function installTLS(): Promise<{ alreadyEnabled: boolean }> {
  ensureRouterFiles();
  const alreadyEnabled = isTLSEnabled();

  ensureMkcert();
  runOrThrow("mkcert", ["-install"]);
  runOrThrow("mkcert", [
    "-cert-file",
    CERT_FILE,
    "-key-file",
    CERT_KEY_FILE,
    "localhost",
    "*.localhost"
  ]);

  setTLSEnabled(true);
  refreshHostRoutesDynamicFile();

  const routerContainer = await findContainerByName("devrouter-traefik");
  if (routerContainer && (await isContainerRunning("devrouter-traefik"))) {
    startRouterStack();
  }

  return { alreadyEnabled };
}

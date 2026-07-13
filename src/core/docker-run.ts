import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type {
  DevrouterApp,
  DevrouterDockerDependencyApp,
  DevrouterDockerRoutedApp,
} from "../types";
import { withDockerFailureGuidance } from "./docker-error-guidance";
import { assertPathWithinRepo } from "./paths";
import { CACHE_DIR, TCP_PROTOCOL_REGISTRY } from "./router";

export type RunningComposeServicesResult =
  | {
      status: "known";
      runningServices: Set<string>;
    }
  | {
      status: "unknown";
      reason: string;
    };

function sanitizeRouterId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function repoHash(repoPath: string): string {
  return createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 12);
}

function asDockerApp(
  app: DevrouterApp,
): app is DevrouterDockerRoutedApp | DevrouterDockerDependencyApp {
  return app.runtime === "docker";
}

function asRoutedDockerApp(app: DevrouterApp): app is DevrouterDockerRoutedApp {
  return app.runtime === "docker" && app.kind !== "dependency";
}

function ensureComposeFiles(
  dockerApps: Array<DevrouterDockerRoutedApp | DevrouterDockerDependencyApp>,
): string[] {
  const files: string[] = [];
  for (const app of dockerApps) {
    for (const file of app.docker.composeFiles) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }
  }

  return files.length > 0 ? files : ["docker-compose.yml"];
}

function buildOverlayDocument(
  dockerApps: Array<DevrouterDockerRoutedApp | DevrouterDockerDependencyApp>,
  publishTcpPorts = false,
): Record<string, unknown> {
  const services: Record<string, Record<string, unknown>> = {};
  const routedDockerApps = dockerApps.filter(asRoutedDockerApp);

  for (const app of routedDockerApps) {
    const routerId = sanitizeRouterId(app.docker.router ?? app.name);
    const labels: Record<string, string> = {
      "traefik.enable": "true",
      "traefik.docker.network": "devnet",
      "devrouter.app.name": app.name,
    };

    if (app.protocol === "http") {
      labels[`traefik.http.routers.${routerId}.rule`] = `Host(\`${app.host}\`)`;
      labels[`traefik.http.routers.${routerId}.entrypoints`] = "web,websecure";
      labels[`traefik.http.routers.${routerId}.tls`] = "true";
      labels[`traefik.http.services.${routerId}.loadbalancer.server.port`] = String(
        app.docker.internalPort,
      );
    } else {
      const registryEntry = TCP_PROTOCOL_REGISTRY[app.tcpProtocol];
      const entrypoint = registryEntry?.entrypoint ?? app.tcpProtocol;
      labels[`traefik.tcp.routers.${routerId}.rule`] = `HostSNI(\`${app.host}\`)`;
      labels[`traefik.tcp.routers.${routerId}.entrypoints`] = entrypoint;
      labels[`traefik.tcp.routers.${routerId}.tls`] = "true";
      labels[`traefik.tcp.services.${routerId}.loadbalancer.server.port`] = String(
        app.docker.internalPort,
      );
    }

    const serviceEntry: Record<string, unknown> = {
      networks: ["devnet"],
      labels,
    };

    if (publishTcpPorts && app.protocol === "tcp") {
      serviceEntry.ports = [`0:${app.docker.internalPort}`];
    }

    services[app.docker.service] = serviceEntry;
  }

  for (const app of dockerApps) {
    if (app.kind === "dependency") {
      if (!services[app.docker.service]) {
        services[app.docker.service] = {};
      }
    }
  }

  if (routedDockerApps.length === 0) {
    return { services };
  }

  return {
    services,
    networks: {
      devnet: {
        external: true,
      },
    },
  };
}

export function prepareDockerOverlay(
  repoPath: string,
  appName: string,
  apps: DevrouterApp[],
  publishTcpPorts = false,
): {
  overlayPath: string;
  composeFiles: string[];
  dockerApps: Array<DevrouterDockerRoutedApp | DevrouterDockerDependencyApp>;
} {
  const dockerApps = apps.filter(asDockerApp);
  if (dockerApps.length === 0) {
    throw new Error("No docker apps selected to prepare compose overlay.");
  }

  const cachePath = path.join(CACHE_DIR, repoHash(repoPath), sanitizeRouterId(appName));
  fs.mkdirSync(cachePath, { recursive: true });
  const overlayPath = path.join(cachePath, "compose.devrouter.yml");
  const overlayDocument = buildOverlayDocument(dockerApps, publishTcpPorts);
  fs.writeFileSync(overlayPath, YAML.stringify(overlayDocument, { lineWidth: 0 }), "utf-8");

  return {
    overlayPath,
    composeFiles: ensureComposeFiles(dockerApps),
    dockerApps,
  };
}

export function runDockerComposeUp(
  repoPath: string,
  composeFiles: string[],
  overlayPath: string,
  services: string[],
): void {
  const fileArgs: string[] = [];
  for (const composeFile of composeFiles) {
    const resolved = assertPathWithinRepo(composeFile, repoPath, "composeFiles");
    fileArgs.push("-f", resolved);
  }

  const args = ["compose", ...fileArgs, "-f", overlayPath, "up", "-d", "--wait", ...services];
  const result = spawnSync("docker", args, {
    encoding: "utf-8",
    cwd: repoPath,
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `docker compose up failed: ${withDockerFailureGuidance(details || "unknown error")}`,
    );
  }
}

export function queryRunningComposeServices(
  repoPath: string,
  composeFiles: string[],
  overlayPath: string,
  services: string[],
): RunningComposeServicesResult {
  const fileArgs: string[] = [];
  for (const composeFile of composeFiles) {
    const resolved = assertPathWithinRepo(composeFile, repoPath, "composeFiles");
    fileArgs.push("-f", resolved);
  }

  const args = [
    "compose",
    ...fileArgs,
    "-f",
    overlayPath,
    "ps",
    "--status",
    "running",
    "--services",
    ...services,
  ];
  const result = spawnSync("docker", args, {
    encoding: "utf-8",
    cwd: repoPath,
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return {
      status: "unknown",
      reason: details || "docker compose ps returned non-zero status",
    };
  }

  const runningServices = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  return {
    status: "known",
    runningServices,
  };
}

export function runDockerComposeStop(
  repoPath: string,
  composeFiles: string[],
  overlayPath: string,
  services: string[],
): void {
  const fileArgs: string[] = [];
  for (const composeFile of composeFiles) {
    const resolved = assertPathWithinRepo(composeFile, repoPath, "composeFiles");
    fileArgs.push("-f", resolved);
  }

  const args = ["compose", ...fileArgs, "-f", overlayPath, "stop", ...services];
  const result = spawnSync("docker", args, {
    encoding: "utf-8",
    cwd: repoPath,
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    process.stderr.write(`Warning: docker compose stop failed: ${details || "unknown error"}\n`);
  }
}

export function runDockerComposeLogs(
  repoPath: string,
  composeFiles: string[],
  overlayPath: string,
  services: string[],
  tail: number = 20,
): void {
  const fileArgs: string[] = [];
  for (const composeFile of composeFiles) {
    const resolved = assertPathWithinRepo(composeFile, repoPath, "composeFiles");
    fileArgs.push("-f", resolved);
  }

  const args = [
    "compose",
    ...fileArgs,
    "-f",
    overlayPath,
    "logs",
    "--tail",
    String(tail),
    ...services,
  ];
  spawnSync("docker", args, {
    stdio: "inherit",
    cwd: repoPath,
  });
}

export function queryMappedPort(
  repoPath: string,
  composeFiles: string[],
  overlayPath: string,
  service: string,
  internalPort: number,
): number | undefined {
  const fileArgs: string[] = [];
  for (const composeFile of composeFiles) {
    const resolved = assertPathWithinRepo(composeFile, repoPath, "composeFiles");
    fileArgs.push("-f", resolved);
  }

  const args = ["compose", ...fileArgs, "-f", overlayPath, "port", service, String(internalPort)];
  const result = spawnSync("docker", args, {
    encoding: "utf-8",
    cwd: repoPath,
  });

  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }

  const match = result.stdout.trim().match(/:(\d+)$/);
  if (!match) {
    return undefined;
  }

  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

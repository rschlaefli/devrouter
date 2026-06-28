import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { DiagnosticCheck } from "../types";

type CommandResult = {
  ok: boolean;
  output?: string;
  error?: string;
};

function outputFromResult(result: ReturnType<typeof spawnSync>): string | undefined {
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  return output.length > 0 ? output : undefined;
}

export function runTool(command: string, args: string[] = []): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8"
  });

  if (result.error) {
    return {
      ok: false,
      error: result.error.message
    };
  }

  const output = outputFromResult(result);
  if (result.status === 0) {
    return { ok: true, output };
  }

  return {
    ok: false,
    output,
    error: output ?? `${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`
  };
}

function firstLine(value: string | undefined): string | undefined {
  return value?.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
}

function parsePackageManager(value: unknown): { name: string; version?: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0) {
    return { name: trimmed };
  }

  return {
    name: trimmed.slice(0, separator),
    version: trimmed.slice(separator + 1)
  };
}

function parseMajor(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function parseMinimumNodeMajor(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = value.match(/>=\s*(\d+)/);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

function readPackageJson(repoPath: string): Record<string, unknown> | undefined {
  const packagePath = path.join(repoPath, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function nodeToolchainCheck(repoPath: string): DiagnosticCheck {
  const pkg = readPackageJson(repoPath);
  if (!pkg) {
    return {
      id: "global.node-toolchain",
      level: "ok",
      summary: "No package.json found; Node toolchain check is not applicable."
    };
  }

  const engines = typeof pkg.engines === "object" && pkg.engines ? pkg.engines as Record<string, unknown> : {};
  const volta = typeof pkg.volta === "object" && pkg.volta ? pkg.volta as Record<string, unknown> : {};
  const nodeRequirement = typeof volta.node === "string" ? volta.node : engines.node;
  const minimumNodeMajor = parseMinimumNodeMajor(nodeRequirement) ?? parseMajor(String(nodeRequirement ?? ""));
  const currentNodeMajor = parseMajor(process.versions.node);
  const packageManager = parsePackageManager(pkg.packageManager);

  const details: string[] = [`node=${process.versions.node}`];
  const problems: string[] = [];

  if (minimumNodeMajor !== undefined) {
    details.push(`expectedNode=${String(nodeRequirement)}`);
    if (currentNodeMajor !== undefined && currentNodeMajor < minimumNodeMajor) {
      problems.push(`Node ${process.versions.node} is older than ${String(nodeRequirement)}`);
    }
  }

  if (packageManager?.name === "pnpm") {
    const pnpm = runTool("pnpm", ["--version"]);
    if (!pnpm.ok) {
      problems.push(`pnpm is missing (${pnpm.error ?? "not found"})`);
    } else {
      const actualPnpm = firstLine(pnpm.output) ?? "unknown";
      details.push(`pnpm=${actualPnpm}`);
      if (packageManager.version) {
        details.push(`expectedPnpm=${packageManager.version}`);
        const expectedMajor = parseMajor(packageManager.version);
        const actualMajor = parseMajor(actualPnpm);
        if (expectedMajor !== undefined && actualMajor !== undefined && expectedMajor !== actualMajor) {
          problems.push(`pnpm major ${actualMajor} does not match expected ${expectedMajor}`);
        }
      }
    }
  } else if (packageManager) {
    details.push(`packageManager=${packageManager.name}${packageManager.version ? `@${packageManager.version}` : ""}`);
  }

  if (problems.length > 0) {
    return {
      id: "global.node-toolchain",
      level: "warn",
      summary: "Node package toolchain may not match this repo.",
      details: [...details, ...problems].join(", "),
      suggestion: packageManager?.name === "pnpm" && packageManager.version
        ? `Install pnpm ${packageManager.version}: npm install -g pnpm@${packageManager.version}`
        : "Install the Node/package-manager versions declared by this repo."
    };
  }

  return {
    id: "global.node-toolchain",
    level: "ok",
    summary: "Node package toolchain is available for this repo.",
    details: details.join(", ")
  };
}

export function buildGlobalToolChecks(repoPath: string): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const compose = runTool("docker", ["compose", "version"]);
  checks.push({
    id: "global.docker-compose",
    level: compose.ok ? "ok" : "error",
    summary: compose.ok ? "Docker Compose v2 is reachable." : "Docker Compose v2 is not reachable.",
    details: firstLine(compose.output) ?? compose.error,
    suggestion: compose.ok
      ? undefined
      : "Install/start Docker with Compose v2, then run: dev setup --yes"
  });

  const mkcert = runTool("mkcert", ["-version"]);
  const brew = runTool("brew", ["--version"]);
  checks.push({
    id: "global.mkcert",
    level: mkcert.ok ? "ok" : "warn",
    summary: mkcert.ok ? "mkcert is installed." : "mkcert is not installed.",
    details: mkcert.ok ? firstLine(mkcert.output) : mkcert.error,
    suggestion: mkcert.ok
      ? undefined
      : brew.ok
        ? "Install mkcert: brew install mkcert"
        : "Install mkcert for local HTTPS, then run: dev setup --yes"
  });

  const devpod = runTool("devpod", ["version"]);
  checks.push({
    id: "global.devpod",
    level: devpod.ok ? "ok" : "warn",
    summary: devpod.ok ? "DevPod is installed." : "DevPod is not installed.",
    details: firstLine(devpod.output) ?? devpod.error,
    suggestion: devpod.ok
      ? undefined
      : "Install DevPod for devcontainer workspace flows: brew install devpod"
  });

  checks.push(nodeToolchainCheck(repoPath));

  return checks;
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiagnosticCheck } from "../types";
import {
  inspectWorkspaceRuntimeConfig,
  readWorkspaceRuntimeConfig,
  resolveWorkspaceRuntimeDetailed,
  WorkspaceRuntimeOwnershipError,
} from "./workspace-runtime";

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
    encoding: "utf-8",
  });

  if (result.error) {
    return {
      ok: false,
      error: result.error.message,
    };
  }

  const output = outputFromResult(result);
  if (result.status === 0) {
    return { ok: true, output };
  }

  return {
    ok: false,
    output,
    error:
      output ?? `${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`,
  };
}

function firstLine(value: string | undefined): string | undefined {
  return value
    ?.split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
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
    version: trimmed.slice(separator + 1),
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
      summary: "No package.json found; Node toolchain check is not applicable.",
    };
  }

  const engines =
    typeof pkg.engines === "object" && pkg.engines ? (pkg.engines as Record<string, unknown>) : {};
  const volta =
    typeof pkg.volta === "object" && pkg.volta ? (pkg.volta as Record<string, unknown>) : {};
  const nodeRequirement = typeof volta.node === "string" ? volta.node : engines.node;
  const minimumNodeMajor =
    parseMinimumNodeMajor(nodeRequirement) ?? parseMajor(String(nodeRequirement ?? ""));
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
        if (
          expectedMajor !== undefined &&
          actualMajor !== undefined &&
          expectedMajor !== actualMajor
        ) {
          problems.push(`pnpm major ${actualMajor} does not match expected ${expectedMajor}`);
        }
      }
    }
  } else if (packageManager) {
    details.push(
      `packageManager=${packageManager.name}${packageManager.version ? `@${packageManager.version}` : ""}`,
    );
  }

  if (problems.length > 0) {
    return {
      id: "global.node-toolchain",
      level: "warn",
      summary: "Node package toolchain may not match this repo.",
      details: [...details, ...problems].join(", "),
      suggestion:
        packageManager?.name === "pnpm" && packageManager.version
          ? `Install pnpm ${packageManager.version}: npm install -g pnpm@${packageManager.version}`
          : "Install the Node/package-manager versions declared by this repo.",
    };
  }

  return {
    id: "global.node-toolchain",
    level: "ok",
    summary: "Node package toolchain is available for this repo.",
    details: details.join(", "),
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
      : "Install/start Docker with Compose v2, then run: devrouter setup --yes",
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
        : "Install mkcert for local HTTPS, then run: devrouter setup --yes",
  });

  let ownershipProblem: string | undefined;
  let runtimeResolution: ReturnType<typeof resolveWorkspaceRuntimeDetailed>;
  try {
    runtimeResolution = resolveWorkspaceRuntimeDetailed(repoPath);
  } catch (error) {
    if (!(error instanceof WorkspaceRuntimeOwnershipError)) throw error;
    ownershipProblem = error.message;
    // Keep diagnosing the configured toolchain without treating that fallback
    // as authority to mutate this checkout.
    runtimeResolution = resolveWorkspaceRuntimeDetailed();
  }
  const workspaceRuntime = runtimeResolution.runtime;
  const machineConfig = readWorkspaceRuntimeConfig();
  const runtimeLabel = workspaceRuntime === "devsy" ? "Devsy" : "DevPod";
  const configInspection = inspectWorkspaceRuntimeConfig();
  // Devsy exposes only the global --version flag; DevPod accepts a version
  // subcommand. Probe each runtime with its supported spelling.
  const runtimeArgs = workspaceRuntime === "devsy" ? ["--version"] : ["version"];
  const runtimeTool = runTool(workspaceRuntime, runtimeArgs);
  if (ownershipProblem) {
    checks.push({
      id: "repo.workspace-runtime-ownership",
      level: "error",
      summary: "Workspace runtime ownership cannot be resolved safely.",
      details: ownershipProblem,
      suggestion: "Restore both registries and remove any duplicate checkout registration.",
    });
  }
  checks.push({
    id: "global.devpod",
    level: runtimeTool.ok ? "ok" : "warn",
    summary: runtimeTool.ok
      ? ownershipProblem
        ? `${runtimeLabel} is configured, but checkout ownership is unresolved.`
        : `${runtimeLabel} is the active workspace runtime (source: ${runtimeResolution.source}).`
      : `${runtimeLabel} is the active workspace runtime but is not installed.`,
    details: [
      firstLine(runtimeTool.output) ?? runtimeTool.error,
      `source=${runtimeResolution.source}`,
      ...(machineConfig.devsyInactivityTimeout
        ? [`devsyInactivityTimeout=${machineConfig.devsyInactivityTimeout}`]
        : []),
    ]
      .filter(Boolean)
      .join(", "),
    suggestion: runtimeTool.ok
      ? undefined
      : workspaceRuntime === "devsy"
        ? "Install Devsy for devcontainer workspace flows: brew install devsy-org/homebrew-tap/devsy"
        : "Install DevPod for devcontainer workspace flows: brew install devpod",
  });

  const configProblems = [...configInspection.problems];
  // A Devsy timeout alongside a path-owned DevPod checkout is a valid mixed
  // fleet: the timeout only governs new Devsy workspaces, so warn only when
  // machine-level resolution itself fell back to DevPod.
  const machineResolvedDevpod =
    workspaceRuntime === "devpod" &&
    (runtimeResolution.source === "auto-detect" || runtimeResolution.source === "default");
  if (machineConfig.devsyInactivityTimeout && machineResolvedDevpod) {
    configProblems.push(
      "devsyInactivityTimeout is configured but the active workspace runtime is DevPod.",
    );
  }
  const configDetails = configInspection.exists
    ? [
        `runtime=${machineConfig.runtime ?? "unset"}`,
        ...(machineConfig.devsyInactivityTimeout
          ? [`devsyInactivityTimeout=${machineConfig.devsyInactivityTimeout}`]
          : []),
      ].join(", ")
    : "Runtime selection falls back to auto-detection.";
  checks.push({
    id: "global.workspace-runtime-config",
    level: configProblems.length > 0 ? "warn" : "ok",
    summary: !configInspection.exists
      ? "No machine workspace-runtime preference is configured."
      : configProblems.length > 0
        ? "Machine workspace-runtime preference has problems."
        : "Machine workspace-runtime preference is valid.",
    details:
      configProblems.length > 0 ? [configDetails, ...configProblems].join(" ") : configDetails,
    suggestion:
      configProblems.length > 0
        ? "Run: devrouter setup --yes --workspace-runtime <devpod|devsy>"
        : undefined,
  });

  checks.push(nodeToolchainCheck(repoPath));

  return checks;
}

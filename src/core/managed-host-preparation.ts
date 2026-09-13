import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";

import type { DevrouterConfig } from "../types";
import { getRepoConfigPath, resolveRepoPath } from "./repo-config";

const PREPARATION_TIMEOUT_MS = 60_000;
const CONFIG_READ_ERROR = "Managed host preparation could not read .devrouter.yml.";
const CONFIG_CHANGED_ERROR =
  "Managed host preparation changed .devrouter.yml; refusing to continue.";
const START_ERROR = "Managed host preparation could not start.";
const FAILURE_ERROR = "Managed host preparation failed.";
const TIMEOUT_ERROR = "Managed host preparation timed out after 60 seconds.";

type PreparationResult = "success" | "start-error" | "failure" | "timeout";

function runPreparationCommand(argv: string[], cwd: string): Promise<PreparationResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        detached: true,
        shell: false,
        stdio: "ignore",
      });
    } catch {
      resolve("start-error");
      return;
    }
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      // Signal only while the direct child still owns this newly created group.
      // No delayed signal may target a group after that child has been reaped.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The child may already have exited. */
        }
      }
    }, PREPARATION_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(deadline);
      resolve("start-error");
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve(timedOut ? "timeout" : code === 0 ? "success" : "failure");
    });
  });
}

function readConfigBytes(configPath: string): Buffer | undefined {
  try {
    return fs.readFileSync(configPath);
  } catch {
    return undefined;
  }
}

export async function runManagedHostPreparation(
  repoPath: string,
  config: DevrouterConfig,
): Promise<void> {
  const prepareCommand = config.managedRuntime?.devcontainer.prepareCommand;
  if (!prepareCommand) return;
  if (process.platform === "win32") {
    throw new Error("Managed host preparation requires POSIX process-group ownership.");
  }

  const resolvedRepoPath = resolveRepoPath(repoPath);
  const configPath = getRepoConfigPath(resolvedRepoPath);
  const before = readConfigBytes(configPath);
  if (!before) {
    throw new Error(CONFIG_READ_ERROR);
  }

  const result = await runPreparationCommand(prepareCommand, resolvedRepoPath);

  const after = readConfigBytes(configPath);
  if (!after?.equals(before)) {
    throw new Error(CONFIG_CHANGED_ERROR);
  }
  if (result === "start-error") {
    throw new Error(START_ERROR);
  }
  if (result === "timeout") {
    throw new Error(TIMEOUT_ERROR);
  }
  if (result === "failure") {
    throw new Error(FAILURE_ERROR);
  }
}

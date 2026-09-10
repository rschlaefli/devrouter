import path from "node:path";
import { collectCapacityDomains } from "../core/capacity-collector";
import { createCapacityController } from "../core/capacity-controller";
import { readCapacityPolicy } from "../core/capacity-policy";
import { resolveControllerBinding } from "../core/controller-binding";
import { controllerRequest } from "../core/controller-client";
import { collectControllerObservation } from "../core/controller-observation";
import type { ControllerStartup } from "../core/controller-server";
import { runController } from "../core/controller-server";
import { DEVROUTER_HOME } from "../core/router";

export async function runControllerCommand(
  method: string,
  options: Record<string, unknown>,
  repo?: string,
  dependencies: Pick<Parameters<typeof runController>[0], "createOperations"> = {},
): Promise<void> {
  const directory = path.join(DEVROUTER_HOME, "controller");
  try {
    if (method === "run") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        // Capacity admission activates only through an enabled policy; the
        // factory revalidates it under the owner lock and fail-closed startup
        // keeps an unreadable policy from silently disabling admission.
        const defaultOperations = dependencies.createOperations
          ? undefined
          : (startup: ControllerStartup) => {
              const policy = readCapacityPolicy(directory);
              if (policy?.admissions !== "enabled") return undefined;
              return createCapacityController({
                directory,
                controller: startup,
                collect: (signal) => collectCapacityDomains(policy, signal),
              });
            };
        await runController({
          directory,
          signal: controller.signal,
          resolve: resolveControllerBinding,
          collect: collectControllerObservation,
          createOperations: dependencies.createOperations ?? defaultOperations,
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return;
    }
    const { json: _json, ...fields } = options;
    if (fields.epoch !== undefined) fields.epoch = Number(fields.epoch);
    if (fields.timeout !== undefined) fields.timeout = Number(fields.timeout);
    await controllerRequest(
      directory,
      { method, ...fields, ...(repo ? { path: path.resolve(repo) } : {}) },
      (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    );
  } catch {
    process.stdout.write(
      `${JSON.stringify({ version: 1, ok: false, error: "controller-unavailable" })}\n`,
    );
    process.exitCode = 1;
  }
}

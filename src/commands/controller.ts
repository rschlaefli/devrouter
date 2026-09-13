import path from "node:path";
import { collectCapacityDomains } from "../core/capacity-collector";
import { createCapacityController } from "../core/capacity-controller";
import { readCapacityPolicy } from "../core/capacity-policy";
import { createControllerBindingResolver } from "../core/controller-binding";
import { controllerRequest } from "../core/controller-client";
import { createControllerObservationCollector } from "../core/controller-observation";
import type { ControllerResolver, ControllerStartup } from "../core/controller-server";
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
          : (startup: ControllerStartup, bindingResolver: ControllerResolver) => {
              const policy = readCapacityPolicy(directory);
              if (policy?.admissions !== "enabled") return undefined;
              return createCapacityController({
                directory,
                controller: startup,
                bindingResolver,
                collect: (signal) => collectCapacityDomains(policy, signal),
              });
            };
        await runController({
          directory,
          signal: controller.signal,
          createBindings: (fingerprint) => {
            const resolve = createControllerBindingResolver(fingerprint);
            return { resolve, collect: createControllerObservationCollector(resolve, fingerprint) };
          },
          createOperations: dependencies.createOperations ?? defaultOperations,
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return;
    }
    const { json: _json, ...fields } = options;
    if (method === "protection-pin") {
      if (
        fields.pinned !== "true" &&
        fields.pinned !== "false" &&
        typeof fields.pinned !== "boolean"
      )
        throw new Error("Pinned must be explicitly true or false.");
      fields.pinned = fields.pinned === true || fields.pinned === "true";
      if (
        typeof fields.expectedProtectionRevision === "string" &&
        !/^(0|[1-9][0-9]*)$/.test(fields.expectedProtectionRevision)
      )
        throw new Error("Protection revision must be a nonnegative integer.");
      fields.expectedProtectionRevision = Number(fields.expectedProtectionRevision);
    }
    if (fields.epoch !== undefined) fields.epoch = Number(fields.epoch);
    if (fields.timeout !== undefined) fields.timeout = Number(fields.timeout);
    await controllerRequest(
      directory,
      { method, ...fields, ...(repo ? { path: path.resolve(repo) } : {}) },
      (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    );
  } catch (error) {
    const cause = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    if (cause) process.stderr.write(`controller command failed: ${cause}\n`);
    process.stdout.write(
      `${JSON.stringify({ version: 1, ok: false, error: "controller-unavailable" })}\n`,
    );
    process.exitCode = 1;
  }
}

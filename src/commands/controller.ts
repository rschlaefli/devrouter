import path from "node:path";
import { resolveControllerBinding } from "../core/controller-binding";
import { controllerRequest } from "../core/controller-client";
import { collectControllerObservation } from "../core/controller-observation";
import { runController } from "../core/controller-server";
import { DEVROUTER_HOME } from "../core/router";

export async function runControllerCommand(
  method: string,
  options: Record<string, unknown>,
  repo?: string,
): Promise<void> {
  const directory = path.join(DEVROUTER_HOME, "controller");
  try {
    if (method === "run") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await runController({
          directory,
          signal: controller.signal,
          resolve: resolveControllerBinding,
          collect: collectControllerObservation,
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

import { devpodExecOutcome } from "./core/devpod-exec";
import { devsyExecOutcome } from "./core/devsy-exec";
import { environmentStop } from "./core/environment-stop";
import { ExecutionOutcomeError } from "./core/execution-outcome";
import {
  cancelLifecycleWorker,
  executeLifecycleWorker,
  proveLifecycleStopped,
  recordLifecycleCompletion,
  recordLifecycleOutcome,
  recordLifecycleUnknown,
} from "./core/reliability-lifecycle";
import type { LifecycleWorkerRequest, LifecycleWorkerResult } from "./core/reliability-worker";
import { workspaceEnsure } from "./core/workspace-ensure";

let started = false;
function cancel(): void {
  cancelLifecycleWorker();
  if (!started && process.connected) process.disconnect();
}
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("disconnect", cancel);
process.once("message", async (message: { request: LifecycleWorkerRequest }) => {
  started = true;
  let result: LifecycleWorkerResult;
  try {
    const request = message.request;
    const value = await executeLifecycleWorker(request, async () => {
      if (request.kind === "stop") {
        const stopped = await environmentStop(request.repoPath, request.options);
        proveLifecycleStopped();
        return stopped;
      }
      if (request.kind === "exec") {
        const outcome = request.retainedExecProof
          ? await devsyExecOutcome(
              request.repoPath,
              request.command ?? [],
              request.retainedExecProof,
            )
          : await devpodExecOutcome(request.repoPath, request.command ?? []);
        recordLifecycleOutcome(outcome);
        return outcome;
      }
      const ensured = await workspaceEnsure(request.repoPath, request.options);
      recordLifecycleCompletion(
        ensured.applicationReadiness?.status === "application-error" ? 1 : 0,
        ensured.managedRuntime?.status === "ready" ? ensured.profile : undefined,
      );
      return ensured;
    });
    result = { ok: true, value };
  } catch (error) {
    try {
      if (error instanceof ExecutionOutcomeError) recordLifecycleOutcome(error.outcome);
      else recordLifecycleUnknown();
    } catch {
      /* Preserve the original operation failure. */
    }
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (process.connected && process.send) process.send(result, () => process.disconnect());
});
if (!process.send)
  throw new Error("Lifecycle worker requires its owning invocation's IPC channel.");
process.send({ ready: true });

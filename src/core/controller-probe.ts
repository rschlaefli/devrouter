import { spawn } from "node:child_process";

export class ControllerProbeUnavailable extends Error {
  constructor(readonly missingExecutable: boolean) {
    super("Observation process unavailable.");
  }
}

/** Output is transient evidence; errors deliberately omit provider output and argv. */
export function runControllerProbe(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Observation cancelled."));
      return;
    }
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    let bytes = 0;
    const chunks: Buffer[] = [];
    let failed = false;
    let finished = false;
    const fail = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(fail, 3000);
    signal.addEventListener("abort", fail, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
    };
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) {
        fail();
        return;
      }
      if (stdout) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new ControllerProbeUnavailable(error.code === "ENOENT"));
    });
    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (failed || code !== 0)
        reject(new Error("Observation process failed or exceeded its bound."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

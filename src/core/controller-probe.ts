import { spawn } from "node:child_process";

export class ControllerProbeUnavailable extends Error {
  constructor(readonly missingExecutable: boolean) {
    super("Observation process unavailable.");
  }
}

export type ControllerProbeStatus = { output: string; code: number | null };
export type ControllerProbeOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };

/**
 * Runs one bounded probe. A non-zero exit resolves with its code so a caller
 * can distinguish positively observed absence from a probe that could not run;
 * only a probe that fails to execute, times out, or exceeds its bound rejects.
 * Output is transient evidence; errors deliberately omit provider output and argv.
 */
function probe(
  command: string,
  args: string[],
  signal: AbortSignal,
  options: ControllerProbeOptions,
): Promise<ControllerProbeStatus> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Observation cancelled."));
      return;
    }
    const child = spawn(command, args, {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
    });
    let bytes = 0;
    const chunks: Buffer[] = [];
    let failed = false;
    let finished = false;
    const fail = () => {
      failed = true;
      // This group was created exclusively for the observer probe. Killing the
      // group also closes inherited pipes held by probe-owned descendants.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
        }
      }
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
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));
    child.stdin?.on("error", fail);
    if (options.input !== undefined) child.stdin?.end(options.input);
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
      if (failed) reject(new Error("Observation process failed or exceeded its bound."));
      else resolve({ output: Buffer.concat(chunks).toString("utf8"), code });
    });
  });
}

/** Resolves stdout only for a successful probe. */
export async function runControllerProbe(
  command: string,
  args: string[],
  signal: AbortSignal,
  options: ControllerProbeOptions = {},
): Promise<string> {
  const result = await probe(command, args, signal, options);
  if (result.code !== 0) throw new Error("Observation process failed or exceeded its bound.");
  return result.output;
}

/** Retains the exit code so a caller can distinguish observed absence from failure. */
export function runControllerProbeStatus(
  command: string,
  args: string[],
  signal: AbortSignal,
  options: ControllerProbeOptions = {},
): Promise<ControllerProbeStatus> {
  return probe(command, args, signal, options);
}

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { listDevpodWorkspaces, selectDevpodWorkspace } from "./devpod-workspaces";
import { sameWorkspacePath, withWorkspaceLifecycleLock } from "./workspace";
import { inspectWorkspaceContainers } from "./workspace-ensure";

export function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function ensureGuidance(repoPath: string): string {
  return `Run 'devrouter ensure ${repoPath}' first.`;
}

function assertRunningDevpod(devpodId: string, repoPath: string): void {
  const result = spawnSync("devpod", ["status", devpodId, "--output", "json"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `Could not prove DevPod '${devpodId}' is running${details ? `: ${details}` : "."} ${ensureGuidance(repoPath)}`,
    );
  }

  let status: { id?: unknown; state?: unknown };
  try {
    status = JSON.parse(result.stdout) as { id?: unknown; state?: unknown };
  } catch {
    throw new Error(`DevPod '${devpodId}' returned invalid status. ${ensureGuidance(repoPath)}`);
  }
  if (status.id !== devpodId || status.state !== "Running") {
    throw new Error(`DevPod '${devpodId}' is not running. ${ensureGuidance(repoPath)}`);
  }
}

function resolveWorkspaceDirectory(repoPath: string): string {
  const matches = inspectWorkspaceContainers().flatMap((container) => {
    if (!container.state.Running) return [];
    const mounts = container.mounts.filter(
      (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, repoPath),
    );
    return mounts.map((mount) => mount.Destination);
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected one running container mounted from '${repoPath}', found ${matches.length}. ${ensureGuidance(repoPath)}`,
    );
  }
  return matches[0];
}

export async function devpodExec(repoPath: string, command: string[]): Promise<number> {
  if (command.length === 0) {
    throw new Error("No command provided. Use `devrouter exec [path] -- <command...>`.");
  }
  return withWorkspaceLifecycleLock(repoPath, async () => {
    const devpod = selectDevpodWorkspace(listDevpodWorkspaces(), repoPath);
    if (!devpod) {
      throw new Error(`No exact DevPod exists for '${repoPath}'. ${ensureGuidance(repoPath)}`);
    }
    assertRunningDevpod(devpod.id, repoPath);
    const workspaceDirectory = resolveWorkspaceDirectory(repoPath);
    const statusMarker = `__DEVROUTER_EXIT_${randomUUID()}__:`;
    const statusMarkerBytes = Buffer.from(statusMarker, "ascii");
    const literalCommand = command.map(quotePosixArg).join(" ");
    const wrappedCommand =
      `${literalCommand}; __devrouter_status=$?; ` +
      `printf '${statusMarker}%s\\n' "$__devrouter_status" >&2; exit 0`;

    const args = [
      "--log-output",
      "raw",
      "ssh",
      devpod.id,
      "--agent-forwarding=false",
      "--gpg-agent-forwarding=false",
      "--start-services=false",
      "--workdir",
      workspaceDirectory,
      "--command",
      wrappedCommand,
    ];

    return new Promise<number>((resolve, reject) => {
      const child = spawn("devpod", args, { stdio: ["inherit", "inherit", "pipe"] });
      let pending = Buffer.alloc(0);
      let statusBytes = Buffer.alloc(0);
      let readingStatus = false;
      let remoteStatus: number | undefined;
      const forward = (value: Buffer): void => {
        if (value.length > 0) process.stderr.write(value);
      };
      child.stderr.on("data", (chunk: Buffer | string) => {
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        for (;;) {
          if (readingStatus) {
            const newline = pending.indexOf(0x0a);
            if (newline < 0) {
              statusBytes = Buffer.concat([statusBytes, pending]);
              pending = Buffer.alloc(0);
              break;
            }
            statusBytes = Buffer.concat([statusBytes, pending.subarray(0, newline)]);
            pending = pending.subarray(newline + 1);
            const value = statusBytes.toString("ascii");
            if (/^\d+$/.test(value)) remoteStatus = Number(value);
            readingStatus = false;
            continue;
          }

          const markerIndex = pending.indexOf(statusMarkerBytes);
          if (markerIndex >= 0) {
            forward(pending.subarray(0, markerIndex));
            pending = pending.subarray(markerIndex + statusMarkerBytes.length);
            readingStatus = true;
            continue;
          }

          const retainedLength = Math.min(pending.length, statusMarkerBytes.length - 1);
          forward(pending.subarray(0, pending.length - retainedLength));
          pending = pending.subarray(pending.length - retainedLength);
          break;
        }
      });
      child.once("error", (error) => reject(new Error(`devpod ssh failed: ${error.message}`)));
      child.once("close", (code, signal) => {
        if (code === null) {
          reject(new Error(`devpod ssh terminated by signal ${signal ?? "unknown"}.`));
          return;
        }
        if (!readingStatus) forward(pending);
        if (remoteStatus === undefined) {
          reject(
            new Error(`DevPod command did not report its exit status (devpod exited ${code}).`),
          );
          return;
        }
        resolve(remoteStatus);
      });
    });
  });
}

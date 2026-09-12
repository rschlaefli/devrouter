import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DevpodWorkspace = {
  id: string;
  source: { localFolder: string };
  /** Optional provider activity metadata; older DevPod versions omit it. */
  lastUsed?: string;
  /** Set when the provider returned a non-string lastUsed value. */
  lastUsedMalformed?: boolean;
};

/**
 * Raw DevPod registry read without any workspace-runtime dispatch. Runtime
 * resolution imports this leaf directly so it can inspect both registries
 * without a circular dependency on the dispatching adapter. Optional competing-provider
 * inspection may ignore an uninstalled CLI; an installed but unreadable registry still fails.
 */
export function listDevpodWorkspacesRaw(
  options: { allowMissingExecutable?: boolean; readLocalWhenMissing?: boolean } = {},
): DevpodWorkspace[] {
  const result = spawnSync("devpod", ["list", "--output", "json", "--skip-pro"], {
    encoding: "utf-8",
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    if (options.readLocalWhenMissing) return readLocalDevpodRegistry();
    if (options.allowMissingExecutable) return [];
  }
  if (result.error || result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`devpod list failed: ${details || "devpod is not installed or unavailable"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("devpod list returned invalid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("devpod list returned an unexpected response.");
  }

  return parsed.map((entry) => {
    const candidate = entry as Partial<DevpodWorkspace> & Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.source ||
      typeof candidate.source.localFolder !== "string"
    ) {
      throw new Error("devpod list returned a workspace without id/source.localFolder.");
    }
    const workspace: DevpodWorkspace = {
      id: candidate.id,
      source: { localFolder: candidate.source.localFolder },
    };
    if ("lastUsed" in candidate) {
      if (typeof candidate.lastUsed === "string") {
        workspace.lastUsed = candidate.lastUsed;
      } else {
        workspace.lastUsedMalformed = true;
      }
    }
    return workspace;
  });
}

export function devpodRegistryRoot(): string {
  return path.resolve(process.env.DEVPOD_HOME || path.join(os.homedir(), ".devpod"));
}

/** Missing CLI is not absence evidence: validate every local legacy context. */
function readLocalDevpodRegistry(): DevpodWorkspace[] {
  const fail = () =>
    new Error("Local DevPod registry evidence is incomplete, unreadable, or changed.");
  const stamps = new Map<string, string | undefined>();
  const stamp = (stat: fs.Stats) =>
    JSON.stringify([
      stat.dev,
      stat.ino,
      stat.mode,
      stat.uid,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ]);
  const inspect = (file: string): fs.Stats | undefined => {
    try {
      return fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw fail();
    }
  };
  const directory = (dir: string, optional = false): boolean => {
    const stat = inspect(dir);
    if ((!stat && !optional) || (stat && !stat.isDirectory())) throw fail();
    stamps.set(dir, stat && stamp(stat));
    return !!stat;
  };
  const entries = (dir: string) => {
    const names = fs.readdirSync(dir).sort();
    if (names.length > 256) throw fail();
    return names;
  };
  const result: DevpodWorkspace[] = [];
  try {
    const root = devpodRegistryRoot();
    // Validate ancestors too: ENOENT behind a dangling link is not an absent registry.
    let ancestor = path.parse(root).root;
    let present = directory(ancestor);
    for (const part of root.slice(ancestor.length).split(path.sep).filter(Boolean)) {
      if (!present) break;
      ancestor = path.join(ancestor, part);
      present = directory(ancestor, true);
    }
    const contexts = path.join(root, "contexts");
    if (present && directory(contexts, true)) {
      for (const context of entries(contexts)) {
        const contextDir = path.join(contexts, context);
        directory(contextDir);
        const workspaces = path.join(contextDir, "workspaces");
        if (!directory(workspaces, true)) continue;
        for (const id of entries(workspaces)) {
          if (result.length >= 256) throw fail();
          const workspace = path.join(workspaces, id);
          directory(workspace);
          const file = path.join(workspace, "workspace.json");
          const stat = inspect(file);
          if (!stat?.isFile() || stat.size > 1024 * 1024) throw fail();
          stamps.set(file, stamp(stat));
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          let raw: unknown;
          try {
            if (stamp(fs.fstatSync(fd)) !== stamp(stat)) throw fail();
            const buffer = Buffer.alloc(stat.size + 1);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (bytes !== stat.size || stamp(fs.fstatSync(fd)) !== stamp(stat)) throw fail();
            raw = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
          } finally {
            fs.closeSync(fd);
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
          const value = raw as Record<string, unknown>;
          if (
            value.id !== id ||
            !value.source ||
            typeof value.source !== "object" ||
            Array.isArray(value.source)
          )
            throw fail();
          const source = value.source as Record<string, unknown>;
          if (
            source.localFolder !== undefined &&
            (typeof source.localFolder !== "string" ||
              (source.localFolder !== "" && !path.isAbsolute(source.localFolder)))
          )
            throw fail();
          const remote = ["gitRepository", "image", "container"];
          if (remote.some((key) => source[key] !== undefined && typeof source[key] !== "string"))
            throw fail();
          if (
            !source.localFolder &&
            !remote.some((key) => typeof source[key] === "string" && source[key])
          )
            throw fail();
          result.push({
            id,
            source: { localFolder: (source.localFolder as string | undefined) ?? "" },
          });
        }
      }
    }
    for (const [file, expected] of stamps) {
      const actual = inspect(file);
      if ((actual && stamp(actual)) !== expected) throw fail();
    }
    return result;
  } catch {
    throw fail();
  }
}

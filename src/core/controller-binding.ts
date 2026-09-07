import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ControllerProbeUnavailable, runControllerProbe } from "./controller-probe";
import type { ControllerResolver } from "./controller-server";
import { buildProfileResolutionReport } from "./profile-resolution";
import { loadRepoConfig } from "./repo-config";

export function readControllerEvidence(file: string, limit = 65_536): string {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Binding evidence unavailable.");
    const bytes = Buffer.alloc(limit + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > limit) throw new Error("Binding evidence exceeds bounds.");
    return bytes.subarray(0, count).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const fingerprintKey = randomBytes(32);

export function controllerBindingFingerprint(owner: string, config: string): string {
  return createHmac("sha256", fingerprintKey)
    .update(JSON.stringify({ owner, config }))
    .digest("hex");
}

/** Capture bounded local files now; publication rechecks bytes without subprocesses. */
export function captureControllerEvidence(files: string[]): {
  contents: string[];
  unchanged: () => boolean;
} {
  if (files.length === 0 || files.length > 64 || new Set(files).size !== files.length)
    throw new Error("Observation evidence file set is invalid.");
  const contents = files.map((file) => readControllerEvidence(file));
  return {
    contents,
    unchanged: () => {
      try {
        return files.every((file, index) => readControllerEvidence(file) === contents[index]);
      } catch {
        return false;
      }
    },
  };
}

export const resolveControllerBinding: ControllerResolver = async (request, signal) => {
  const repoPath = fs.realpathSync(request.path);
  const metadata = (
    await runControllerProbe(
      "git",
      [
        "-C",
        repoPath,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
        "--show-toplevel",
      ],
      signal,
    )
  )
    .trim()
    .split("\n");
  if (metadata.length !== 3) throw new Error("Canonical linked ownership unavailable.");
  const [gitDir, commonDir, topLevel] = metadata.map((file) => fs.realpathSync(file));
  if (
    topLevel !== repoPath ||
    gitDir === commonDir ||
    path.dirname(path.dirname(gitDir)) !== commonDir ||
    path.basename(path.dirname(gitDir)) !== "worktrees"
  )
    throw new Error("Controller requires an existing linked checkout.");
  const workspace = readControllerEvidence(path.join(gitDir, "devrouter-workspace"), 128).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspace) || workspace.length > 32)
    throw new Error("Canonical workspace token unavailable.");
  const ownerFile = path.join(commonDir, "devrouter", "workspaces", `${workspace}.json`);
  const ownerBytes = readControllerEvidence(ownerFile);
  const owner = JSON.parse(ownerBytes);
  if (
    owner?.version !== 1 ||
    owner.workspace !== workspace ||
    typeof owner.devpodId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(owner.devpodId) ||
    owner.worktreePath !== repoPath
  )
    throw new Error("Canonical workspace owner unavailable.");
  const configFile = path.join(repoPath, ".devrouter.yml");
  const configBytes = readControllerEvidence(configFile);
  const config = loadRepoConfig(repoPath, () => configBytes);
  if (!config.managedRuntime) throw new Error("Controller requires managed configuration.");
  const profile = buildProfileResolutionReport(config, repoPath, request.profile);
  for (const requirement of request.require) {
    if (requirement === "runtime") continue;
    const name = requirement.slice(4);
    const app = config.apps.find((candidate) => candidate.name === name);
    if (
      !profile.apps.includes(name) ||
      !app ||
      app.kind === "dependency" ||
      app.protocol !== "http" ||
      app.runtime !== "proxy" ||
      !app.readiness
    )
      throw new Error("Controller requirement lacks explicit managed HTTP readiness.");
  }
  const candidates: Array<{ provider: "devpod" | "devsy"; id: string; localFolder: string }> = [];
  for (const provider of ["devpod", "devsy"] as const) {
    const args =
      provider === "devpod"
        ? ["list", "--output", "json", "--skip-pro"]
        : ["workspace", "list", "--result-format", "json", "--skip-pro"];
    let output: string;
    try {
      output = await runControllerProbe(provider, args, signal);
    } catch (error) {
      if (error instanceof ControllerProbeUnavailable && error.missingExecutable) continue;
      // An unavailable registry cannot prove that a conflicting owner is absent.
      throw new Error("Provider ownership evidence unavailable.");
    }
    const entries: unknown = JSON.parse(output);
    if (!Array.isArray(entries)) throw new Error("Provider ownership evidence malformed.");
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || typeof entry.source?.localFolder !== "string")
        throw new Error("Provider ownership evidence malformed.");
      if (entry.id === owner.devpodId || path.resolve(entry.source.localFolder) === repoPath)
        candidates.push({
          provider,
          id: entry.id,
          localFolder: path.resolve(entry.source.localFolder),
        });
    }
  }
  if (
    candidates.length !== 1 ||
    candidates[0].id !== owner.devpodId ||
    candidates[0].localFolder !== repoPath
  )
    throw new Error("Provider ownership is ambiguous.");
  if (
    readControllerEvidence(ownerFile) !== ownerBytes ||
    readControllerEvidence(configFile) !== configBytes ||
    readControllerEvidence(path.join(gitDir, "devrouter-workspace"), 128).trim() !== workspace
  )
    throw new Error("Binding evidence changed during resolution.");
  // The approved snapshot contains only opaque fingerprints and canonical refs.
  // Configuration bytes remain transient and are never emitted as diagnostics.
  return {
    id: digest(repoPath),
    repoPath,
    workspace,
    provider: candidates[0].provider,
    providerId: owner.devpodId,
    profile: profile.profile,
    fingerprint: controllerBindingFingerprint(ownerBytes, configBytes),
  };
};

import { spawnSync } from "node:child_process";

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
 * without a circular dependency on the dispatching adapter.
 */
export function listDevpodWorkspacesRaw(): DevpodWorkspace[] {
  const result = spawnSync("devpod", ["list", "--output", "json", "--skip-pro"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
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

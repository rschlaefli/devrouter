import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import { DEVROUTER_HOME } from "./router";

export type ManagedRuntimeState = {
  version: 1;
  repoPath: string;
  workspace?: string;
  devpodId: string;
  composeProject: string;
  profile: string;
  desired: {
    apps: string[];
    services: string[];
    processes: string[];
  };
  sourceConfigSha256: string;
  effectiveConfigSha256: string;
  status: "ready" | "degraded";
  transitionPhase?: string;
  updatedAt: string;
};

function stateKey(repoPath: string, workspace?: string): string {
  return createHash("sha256")
    .update(`${repoPath}\0${workspace ?? ""}`, "utf-8")
    .digest("hex");
}

export function managedRuntimeStatePath(repoPath: string, workspace?: string): string {
  return path.join(DEVROUTER_HOME, "managed-runtime", `${stateKey(repoPath, workspace)}.json`);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  );
}

function validateState(value: unknown, repoPath: string, workspace?: string): ManagedRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed runtime state must contain an object.");
  }
  const candidate = value as Partial<ManagedRuntimeState>;
  if (candidate.version !== 1) throw new Error("Managed runtime state has an unsupported version.");
  if (candidate.repoPath !== repoPath || candidate.workspace !== workspace) {
    throw new Error("Managed runtime state belongs to a different exact workspace.");
  }
  if (typeof candidate.devpodId !== "string" || candidate.devpodId.length === 0) {
    throw new Error("Managed runtime state has no exact DevPod identity.");
  }
  if (typeof candidate.composeProject !== "string" || candidate.composeProject.length === 0) {
    throw new Error("Managed runtime state has no exact Compose project identity.");
  }
  if (typeof candidate.profile !== "string" || candidate.profile.length === 0) {
    throw new Error("Managed runtime state has no canonical profile.");
  }
  if (!candidate.desired || typeof candidate.desired !== "object") {
    throw new Error("Managed runtime state has no desired resource set.");
  }
  const desired = candidate.desired as ManagedRuntimeState["desired"];
  if (
    !isStringArray(desired.apps) ||
    !isStringArray(desired.services) ||
    !isStringArray(desired.processes)
  ) {
    throw new Error("Managed runtime state has an invalid desired resource set.");
  }
  if (
    typeof candidate.sourceConfigSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.sourceConfigSha256) ||
    typeof candidate.effectiveConfigSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.effectiveConfigSha256)
  ) {
    throw new Error("Managed runtime state has invalid config fingerprints.");
  }
  if (candidate.status !== "ready" && candidate.status !== "degraded") {
    throw new Error("Managed runtime state has an invalid transition status.");
  }
  if (candidate.transitionPhase !== undefined && typeof candidate.transitionPhase !== "string") {
    throw new Error("Managed runtime state has an invalid transition phase.");
  }
  if (
    typeof candidate.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.updatedAt))
  ) {
    throw new Error("Managed runtime state has an invalid timestamp.");
  }
  return {
    version: 1,
    repoPath,
    ...(workspace !== undefined ? { workspace } : {}),
    devpodId: candidate.devpodId,
    composeProject: candidate.composeProject,
    profile: candidate.profile,
    desired: {
      apps: [...desired.apps],
      services: [...desired.services],
      processes: [...desired.processes],
    },
    sourceConfigSha256: candidate.sourceConfigSha256,
    effectiveConfigSha256: candidate.effectiveConfigSha256,
    status: candidate.status,
    ...(candidate.transitionPhase ? { transitionPhase: candidate.transitionPhase } : {}),
    updatedAt: candidate.updatedAt,
  };
}

export function readManagedRuntimeState(
  repoPath: string,
  workspace?: string,
): ManagedRuntimeState | undefined {
  const statePath = managedRuntimeStatePath(repoPath, workspace);
  if (!fs.existsSync(statePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (error) {
    throw new Error(`Could not parse managed runtime state: ${String(error)}`);
  }
  return validateState(parsed, repoPath, workspace);
}

export function writeManagedRuntimeState(state: ManagedRuntimeState): void {
  const validated = validateState(state, state.repoPath, state.workspace);
  writeFileAtomically(
    managedRuntimeStatePath(validated.repoPath, validated.workspace),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

export function markManagedRuntimeDegraded(
  state: ManagedRuntimeState,
  transitionPhase: string,
): void {
  writeManagedRuntimeState({
    ...state,
    status: "degraded",
    transitionPhase,
    updatedAt: new Date().toISOString(),
  });
}

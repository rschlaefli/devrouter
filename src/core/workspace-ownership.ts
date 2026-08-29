import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import { type DevpodWorkspace, inspectDevpodWorkspaceOwnership } from "./devpod-workspaces";
import { withFileLockSync } from "./file-lock";
import {
  comparableWorkspacePath,
  persistWorkspace,
  readPersistedWorkspace,
  sameWorkspacePath,
  workspaceIdentityCandidates,
  wsFromBranch,
} from "./workspace";

const READ_ONLY_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

const OWNERSHIP_VERSION = 1;
const OWNERSHIP_DIR = path.join("devrouter", "workspaces");

export type WorkspaceOwnershipRecord = {
  version: 1;
  workspace: string;
  worktreePath: string;
  branch: string | null;
  devpodId: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceOwnershipInput = Pick<
  WorkspaceOwnershipRecord,
  "workspace" | "worktreePath" | "devpodId"
> & { branch?: string | null };

export type GitWorktree = {
  path: string;
  branch: string | undefined;
  locked: boolean;
  prunable: boolean;
};

export type WorkspaceOwnerStatus = "present" | "missing" | "locked" | "conflict";
export type DevpodOwnerStatus = "owned" | "absent" | "conflict" | "unknown";
export type WorkspaceOwnershipStatus = {
  ownerStatus: WorkspaceOwnerStatus;
  devpodStatus: DevpodOwnerStatus;
  worktree: GitWorktree | undefined;
};

export type ConditionalOwnershipRemoval = "removed" | "absent" | "changed";

export type WorkspaceIdentityClaimInput = {
  source: string;
  branch?: string | null;
  providerWorkspaces: DevpodWorkspace[];
  unavailableRuntimes: string[];
};

export type WorkspaceOwnershipTransaction = {
  list: () => WorkspaceOwnershipRecord[];
  write: (input: WorkspaceOwnershipInput) => WorkspaceOwnershipRecord;
  remove: (workspace: string) => boolean;
  removeIfMatches: (expected: WorkspaceOwnershipRecord) => ConditionalOwnershipRemoval;
};

function commandError(command: string, repoPath: string, stderr: string | undefined): Error {
  return new Error(
    `${command} failed for '${repoPath}': ${stderr?.trim() || "not a Git repository"}`,
  );
}

export function resolveGitCommonDir(repoPath: string): string {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
    env: READ_ONLY_GIT_ENV,
  });
  const output = result.stdout.trim();
  if (result.status !== 0 || !output) {
    throw commandError("Could not resolve the Git common directory", repoPath, result.stderr);
  }
  return comparableWorkspacePath(path.isAbsolute(output) ? output : path.resolve(repoPath, output));
}

export function resolveGitTopLevel(repoPath: string): string {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    env: READ_ONLY_GIT_ENV,
  });
  const output = result.stdout.trim();
  if (result.status !== 0 || !output) {
    throw commandError("Could not resolve the Git checkout root", repoPath, result.stderr);
  }
  return comparableWorkspacePath(output);
}

export function listGitWorktrees(repoPath: string): GitWorktree[] {
  const result = spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf-8",
    env: READ_ONLY_GIT_ENV,
  });
  if (result.status !== 0) {
    throw commandError("git worktree list", repoPath, result.stderr);
  }

  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};
  const finish = (): void => {
    if (!current.path) return;
    worktrees.push({
      path: comparableWorkspacePath(current.path),
      branch: current.branch,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
    });
    current = {};
  };

  for (const line of `${result.stdout}\n`.split("\n")) {
    if (line.startsWith("worktree ")) {
      finish();
      current.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    } else if (line === "") {
      finish();
    }
  }
  return worktrees;
}

function ownershipDirectory(repoPath: string): string {
  return path.join(resolveGitCommonDir(repoPath), OWNERSHIP_DIR);
}

function validateWorkspace(value: unknown, label: string): string {
  if (typeof value !== "string" || wsFromBranch(value) !== value) {
    throw new Error(`invalid workspace ownership ${label}`);
  }
  return value;
}

function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid workspace ownership ${label}`);
  }
  return value;
}

function validateRecord(value: unknown, expectedWorkspace?: string): WorkspaceOwnershipRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid workspace ownership record");
  }
  const candidate = value as Partial<WorkspaceOwnershipRecord>;
  if (candidate.version !== OWNERSHIP_VERSION) {
    throw new Error(`unsupported workspace ownership version '${String(candidate.version)}'`);
  }
  const workspace = validateWorkspace(candidate.workspace, "workspace");
  if (expectedWorkspace && workspace !== expectedWorkspace) {
    throw new Error(
      `workspace ownership file '${expectedWorkspace}' contains identity '${workspace}'`,
    );
  }
  if (typeof candidate.worktreePath !== "string" || !path.isAbsolute(candidate.worktreePath)) {
    throw new Error("invalid workspace ownership worktreePath");
  }
  if (candidate.branch !== null && typeof candidate.branch !== "string") {
    throw new Error("invalid workspace ownership branch");
  }
  const devpodId = validateWorkspace(candidate.devpodId, "devpodId");
  return {
    version: OWNERSHIP_VERSION,
    workspace,
    worktreePath: comparableWorkspacePath(candidate.worktreePath),
    branch: candidate.branch,
    devpodId,
    createdAt: validateTimestamp(candidate.createdAt, "createdAt"),
    updatedAt: validateTimestamp(candidate.updatedAt, "updatedAt"),
  };
}

function recordPath(repoPath: string, workspace: string): string {
  return path.join(
    ownershipDirectory(repoPath),
    `${validateWorkspace(workspace, "workspace")}.json`,
  );
}

function readRecordFile(filePath: string, expectedWorkspace: string): WorkspaceOwnershipRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid workspace ownership JSON at '${filePath}'`);
    }
    throw error;
  }
  return validateRecord(parsed, expectedWorkspace);
}

export function readWorkspaceOwnership(
  repoPath: string,
  workspace: string,
): WorkspaceOwnershipRecord | undefined {
  const filePath = recordPath(repoPath, workspace);
  try {
    return readRecordFile(filePath, workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function listWorkspaceOwnership(repoPath: string): WorkspaceOwnershipRecord[] {
  const directory = ownershipDirectory(repoPath);
  return listWorkspaceOwnershipInDirectory(directory);
}

function listWorkspaceOwnershipInDirectory(directory: string): WorkspaceOwnershipRecord[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const workspace = entry.name.slice(0, -".json".length);
      validateWorkspace(workspace, "filename");
      return readRecordFile(path.join(directory, entry.name), workspace);
    });
}

function writeWorkspaceOwnershipInDirectory(
  directory: string,
  input: WorkspaceOwnershipInput,
): WorkspaceOwnershipRecord {
  const workspace = validateWorkspace(input.workspace, "workspace");
  const devpodId = validateWorkspace(input.devpodId, "devpodId");
  const worktreePath = comparableWorkspacePath(input.worktreePath);
  const filePath = path.join(directory, `${workspace}.json`);
  const now = new Date().toISOString();
  const records = listWorkspaceOwnershipInDirectory(directory);
  const existing = records.find((record) => record.workspace === workspace);
  if (existing && !sameWorkspacePath(existing.worktreePath, worktreePath)) {
    throw new Error(
      `Workspace '${workspace}' already belongs to '${existing.worktreePath}', refusing '${worktreePath}'.`,
    );
  }
  const pathOwner = records.find(
    (record) =>
      record.workspace !== workspace && sameWorkspacePath(record.worktreePath, worktreePath),
  );
  if (pathOwner) {
    throw new Error(
      `Worktree '${worktreePath}' is already owned by workspace '${pathOwner.workspace}'.`,
    );
  }
  if (existing && existing.devpodId !== devpodId) {
    throw new Error(
      `Workspace '${workspace}' already owns DevPod '${existing.devpodId}', refusing '${devpodId}'.`,
    );
  }
  const record: WorkspaceOwnershipRecord = {
    version: OWNERSHIP_VERSION,
    workspace,
    worktreePath,
    branch: input.branch ?? null,
    devpodId,
    createdAt: existing?.createdAt ?? validateTimestamp(now, "createdAt"),
    updatedAt: validateTimestamp(now, "updatedAt"),
  };
  writeFileAtomically(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function removeWorkspaceOwnershipInDirectory(directory: string, workspace: string): boolean {
  const filePath = path.join(directory, `${validateWorkspace(workspace, "workspace")}.json`);
  try {
    fs.rmSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sameOwnershipRecord(
  left: WorkspaceOwnershipRecord,
  right: WorkspaceOwnershipRecord,
): boolean {
  return (
    left.version === right.version &&
    left.workspace === right.workspace &&
    sameWorkspacePath(left.worktreePath, right.worktreePath) &&
    left.branch === right.branch &&
    left.devpodId === right.devpodId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function removeWorkspaceOwnershipIfMatchesInDirectory(
  directory: string,
  expected: WorkspaceOwnershipRecord,
): ConditionalOwnershipRemoval {
  const filePath = path.join(
    directory,
    `${validateWorkspace(expected.workspace, "workspace")}.json`,
  );
  let current: WorkspaceOwnershipRecord;
  try {
    current = readRecordFile(filePath, expected.workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!sameOwnershipRecord(current, expected)) return "changed";
  fs.rmSync(filePath);
  return "removed";
}

export function withWorkspaceOwnershipTransaction<T>(
  repoPath: string,
  operation: (transaction: WorkspaceOwnershipTransaction) => T,
  options: { waitMs?: number } = {},
): T {
  const directory = ownershipDirectory(repoPath);
  fs.mkdirSync(directory, { recursive: true });
  return withFileLockSync(
    path.join(directory, ".lock"),
    {
      activity: "workspace ownership transaction",
      target: `'${repoPath}'`,
      waitMs: options.waitMs ?? 5000,
    },
    () =>
      operation({
        list: () => listWorkspaceOwnershipInDirectory(directory),
        write: (input) => writeWorkspaceOwnershipInDirectory(directory, input),
        remove: (workspace) => removeWorkspaceOwnershipInDirectory(directory, workspace),
        removeIfMatches: (expected) =>
          removeWorkspaceOwnershipIfMatchesInDirectory(directory, expected),
      }),
  );
}

export function writeWorkspaceOwnership(
  repoPath: string,
  input: WorkspaceOwnershipInput,
): WorkspaceOwnershipRecord {
  return withWorkspaceOwnershipTransaction(repoPath, (transaction) => transaction.write(input));
}

function providerPathOwner(
  providerWorkspaces: DevpodWorkspace[],
  worktreePath: string,
): DevpodWorkspace | undefined {
  const owners = providerWorkspaces.filter((workspace) =>
    sameWorkspacePath(workspace.source.localFolder, worktreePath),
  );
  if (owners.length > 1) {
    throw new Error(
      `Worktree '${worktreePath}' is registered by multiple workspace runtimes; no identity was claimed.`,
    );
  }
  return owners[0];
}

function persistedWorkspaceOwners(repoPath: string, worktreePath: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const worktree of listGitWorktrees(repoPath)) {
    if (sameWorkspacePath(worktree.path, worktreePath)) continue;
    let workspace: string | undefined;
    try {
      workspace = readPersistedWorkspace(worktree.path);
    } catch (error) {
      if (!fs.existsSync(worktree.path)) continue;
      throw error;
    }
    if (!workspace) continue;
    const existing = owners.get(workspace);
    if (existing && !sameWorkspacePath(existing, worktree.path)) {
      throw new Error(`Persisted workspace identity '${workspace}' belongs to multiple worktrees.`);
    }
    owners.set(workspace, worktree.path);
  }
  return owners;
}

function claimConflict(
  workspace: string,
  devpodId: string,
  worktreePath: string,
  records: WorkspaceOwnershipRecord[],
  providerWorkspaces: DevpodWorkspace[],
  persistedOwners: Map<string, string>,
  exactRecord?: WorkspaceOwnershipRecord,
): string | undefined {
  const recordOwner = records.find(
    (record) =>
      record !== exactRecord && (record.workspace === workspace || record.devpodId === devpodId),
  );
  if (recordOwner) {
    return `workspace owner record '${recordOwner.workspace}' for '${recordOwner.worktreePath}'`;
  }
  const providerOwner = providerWorkspaces.find(
    (providerWorkspace) =>
      providerWorkspace.id === devpodId &&
      !sameWorkspacePath(providerWorkspace.source.localFolder, worktreePath),
  );
  if (providerOwner) {
    return `workspace runtime identity '${providerOwner.id}' already belongs to '${providerOwner.source.localFolder}'`;
  }
  const persistedOwner = persistedOwners.get(workspace);
  if (persistedOwner) {
    return `persisted checkout metadata for '${persistedOwner}'`;
  }
  return undefined;
}

/**
 * Reconcile and claim one linked checkout identity before provider or route
 * mutation. Provider evidence is collected before this repository-local
 * transaction; persisted checkout metadata and owner records are re-read
 * while the transaction is held.
 */
export function claimWorkspaceIdentity(
  repoPath: string,
  input: WorkspaceIdentityClaimInput,
): WorkspaceOwnershipRecord {
  const worktreePath = comparableWorkspacePath(repoPath);
  const exactProvider = providerPathOwner(input.providerWorkspaces, worktreePath);

  return withWorkspaceOwnershipTransaction(repoPath, (transaction) => {
    const records = transaction.list();
    const exactRecords = records.filter((record) =>
      sameWorkspacePath(record.worktreePath, worktreePath),
    );
    if (exactRecords.length > 1) {
      throw new Error(
        `Worktree '${worktreePath}' has multiple workspace owner records; no identity was claimed.`,
      );
    }
    const exactRecord = exactRecords[0];
    const persisted = readPersistedWorkspace(worktreePath);
    const persistedOwners = persistedWorkspaceOwners(repoPath, worktreePath);

    if (exactRecord) {
      if (persisted && persisted !== exactRecord.workspace) {
        throw new Error(
          `Persisted workspace identity '${persisted}' disagrees with owner record '${exactRecord.workspace}'.`,
        );
      }
      if (exactProvider && exactProvider.id !== exactRecord.devpodId) {
        throw new Error(
          `Workspace runtime '${exactProvider.id}' disagrees with owner record '${exactRecord.devpodId}'.`,
        );
      }
      const conflict = claimConflict(
        exactRecord.workspace,
        exactRecord.devpodId,
        worktreePath,
        records,
        input.providerWorkspaces,
        persistedOwners,
        exactRecord,
      );
      if (conflict) {
        throw new Error(
          `Workspace '${exactRecord.workspace}' conflicts with ${conflict}; no identity was claimed.`,
        );
      }
      if (!persisted) persistWorkspace(worktreePath, exactRecord.workspace);
      return transaction.write({
        workspace: exactRecord.workspace,
        worktreePath,
        branch: input.branch ?? null,
        devpodId: exactRecord.devpodId,
      });
    }

    if (persisted && exactProvider && persisted !== exactProvider.id) {
      throw new Error(
        `Persisted workspace identity '${persisted}' disagrees with workspace runtime '${exactProvider.id}'.`,
      );
    }

    let workspace = persisted ?? exactProvider?.id;
    let devpodId = exactProvider?.id ?? persisted;
    if (!workspace || !devpodId) {
      if (input.unavailableRuntimes.length > 0) {
        throw new Error(
          `Cannot claim a new workspace identity because these runtime registries are unavailable: ${input.unavailableRuntimes.join(", ")}.`,
        );
      }
      const candidate = workspaceIdentityCandidates(input.source).find(
        (next) =>
          !claimConflict(
            next,
            next,
            worktreePath,
            records,
            input.providerWorkspaces,
            persistedOwners,
          ),
      );
      if (!candidate) {
        throw new Error(
          `Could not allocate a collision-safe workspace identity for '${worktreePath}'.`,
        );
      }
      workspace = candidate;
      devpodId = candidate;
    }

    const conflict = claimConflict(
      workspace,
      devpodId,
      worktreePath,
      records,
      input.providerWorkspaces,
      persistedOwners,
    );
    if (conflict) {
      throw new Error(
        `Workspace '${workspace}' conflicts with ${conflict}; no identity was claimed.`,
      );
    }

    const written = transaction.write({
      workspace,
      worktreePath,
      branch: input.branch ?? null,
      devpodId,
    });
    try {
      persistWorkspace(worktreePath, workspace);
    } catch (error) {
      const cleanup = transaction.removeIfMatches(written);
      if (cleanup !== "removed") {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not persist workspace identity and owner-record rollback was '${cleanup}': ${detail}`,
        );
      }
      throw error;
    }
    return written;
  });
}

export function removeWorkspaceOwnership(repoPath: string, workspace: string): boolean {
  return withWorkspaceOwnershipTransaction(repoPath, (transaction) =>
    transaction.remove(workspace),
  );
}

export function inspectWorkspaceOwnership(
  record: WorkspaceOwnershipRecord,
  worktrees: GitWorktree[],
  devpods: DevpodWorkspace[] | undefined,
): WorkspaceOwnershipStatus {
  const worktree = worktrees.find((candidate) =>
    sameWorkspacePath(candidate.path, record.worktreePath),
  );
  const devpodOwnership = devpods
    ? inspectDevpodWorkspaceOwnership(devpods, record.devpodId, record.worktreePath)
    : undefined;
  const devpodStatus = devpodOwnership?.status ?? "unknown";

  if (devpodStatus === "conflict") {
    return { ownerStatus: "conflict", devpodStatus, worktree };
  }
  if (worktree?.locked) {
    return { ownerStatus: "locked", devpodStatus, worktree };
  }
  if ((!worktree || worktree.prunable) && fs.existsSync(record.worktreePath)) {
    return { ownerStatus: "conflict", devpodStatus, worktree };
  }
  if (!worktree || worktree.prunable) {
    return { ownerStatus: "missing", devpodStatus, worktree };
  }

  let persisted: string | undefined;
  try {
    persisted = readPersistedWorkspace(worktree.path);
  } catch {
    return { ownerStatus: "conflict", devpodStatus, worktree };
  }
  return {
    ownerStatus: persisted === record.workspace ? "present" : "conflict",
    devpodStatus,
    worktree,
  };
}

export function listMissingWorkspaceOwnership(repoPath: string): WorkspaceOwnershipRecord[] {
  const worktrees = listGitWorktrees(repoPath);
  return listWorkspaceOwnership(repoPath).filter(
    (record) => inspectWorkspaceOwnership(record, worktrees, undefined).ownerStatus === "missing",
  );
}

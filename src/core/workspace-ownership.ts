import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./file-lock";
import {
  comparableWorkspacePath,
  readPersistedWorkspace,
  sameWorkspacePath,
  wsFromBranch,
} from "./workspace";

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
export type DevpodOwnershipEvidence = { id: string; source: { localFolder: string } };

export type WorkspaceOwnershipStatus = {
  ownerStatus: WorkspaceOwnerStatus;
  devpodStatus: DevpodOwnerStatus;
  worktree: GitWorktree | undefined;
};

function commandError(command: string, repoPath: string, stderr: string | undefined): Error {
  return new Error(
    `${command} failed for '${repoPath}': ${stderr?.trim() || "not a Git repository"}`,
  );
}

export function resolveGitCommonDir(repoPath: string): string {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
  });
  const output = result.stdout.trim();
  if (result.status !== 0 || !output) {
    throw commandError("Could not resolve the Git common directory", repoPath, result.stderr);
  }
  return comparableWorkspacePath(path.isAbsolute(output) ? output : path.resolve(repoPath, output));
}

export function listGitWorktrees(repoPath: string): GitWorktree[] {
  const result = spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf-8",
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

export function writeWorkspaceOwnership(
  repoPath: string,
  input: WorkspaceOwnershipInput,
): WorkspaceOwnershipRecord {
  const workspace = validateWorkspace(input.workspace, "workspace");
  const devpodId = validateWorkspace(input.devpodId, "devpodId");
  const worktreePath = comparableWorkspacePath(input.worktreePath);
  const directory = ownershipDirectory(repoPath);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${workspace}.json`);

  return withFileLockSync(
    `${filePath}.lock`,
    { activity: "workspace ownership update", target: `'${workspace}'` },
    () => {
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
      const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
          encoding: "utf-8",
          flag: "wx",
        });
        fs.renameSync(tempPath, filePath);
      } finally {
        fs.rmSync(tempPath, { force: true });
      }
      return record;
    },
  );
}

export function removeWorkspaceOwnership(repoPath: string, workspace: string): boolean {
  const filePath = recordPath(repoPath, workspace);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return withFileLockSync(
    `${filePath}.lock`,
    { activity: "workspace ownership removal", target: `'${workspace}'` },
    () => {
      try {
        fs.rmSync(filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  );
}

export function inspectWorkspaceOwnership(
  record: WorkspaceOwnershipRecord,
  worktrees: GitWorktree[],
  devpods: DevpodOwnershipEvidence[] | undefined,
): WorkspaceOwnershipStatus {
  const worktree = worktrees.find((candidate) =>
    sameWorkspacePath(candidate.path, record.worktreePath),
  );
  const devpodById = devpods?.find((candidate) => candidate.id === record.devpodId);
  const devpodsByPath =
    devpods?.filter((candidate) =>
      sameWorkspacePath(candidate.source.localFolder, record.worktreePath),
    ) ?? [];
  const devpodConflict =
    Boolean(devpodById && !sameWorkspacePath(devpodById.source.localFolder, record.worktreePath)) ||
    devpodsByPath.length > 1 ||
    Boolean(devpodsByPath[0] && devpodsByPath[0].id !== record.devpodId);
  const devpodStatus =
    devpods === undefined
      ? "unknown"
      : devpodConflict
        ? "conflict"
        : devpodById
          ? "owned"
          : "absent";

  if (devpodConflict) {
    return { ownerStatus: "conflict", devpodStatus, worktree };
  }
  if (!worktree || worktree.prunable) {
    return { ownerStatus: "missing", devpodStatus, worktree };
  }
  if (worktree.locked) {
    return { ownerStatus: "locked", devpodStatus, worktree };
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

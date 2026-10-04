import { spawnSync } from "node:child_process";

/**
 * One bulk listing of a repository's pull or merge requests, used for the
 * worktree safety verdict. Two rules apply to every lookup and are shared with
 * the `worktree-reclaim` skill: changes from forks never count, and the newest
 * change for a branch (highest number) decides, so an older merged change
 * cannot outvote a newer open one.
 */
export type ForgeChangeState = "MERGED" | "OPEN" | "CLOSED";

export type ForgeChange = {
  number: number;
  sourceBranch: string;
  /** The change's current source head; null when the forge did not report one. */
  headSha: string | null;
  state: ForgeChangeState;
  crossRepository: boolean;
};

export type ForgeIdentity = { provider: "github" | "gitlab"; project: string };

export type ForgeListing =
  | { status: "listed"; provider: ForgeIdentity["provider"]; changes: ForgeChange[] }
  | { status: "unavailable"; reason: string };

export type ForgeCommandRunner = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; error?: Error };

const GITHUB_LIMIT = 1000;
const GITLAB_PAGE_SIZE = 100;
const GITLAB_MAX_PAGES = 10;
const ATTEMPTS = 3;

const defaultRunner: ForgeCommandRunner = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value);
}

// Forge APIs fail transiently under bulk use (rate limits, timeouts), so a
// failing call is retried with backoff before the listing counts as unavailable.
function runWithRetry(
  runner: ForgeCommandRunner,
  sleep: (milliseconds: number) => void,
  command: string,
  args: string[],
): string | undefined {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = runner(command, args);
    if (result.status === 0 && !result.error) return result.stdout;
    if (attempt < ATTEMPTS) sleep(attempt * 2000);
  }
  return undefined;
}

export function parseGitHubListing(value: unknown): ForgeChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: ForgeChange[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    const state = record.state;
    if (
      typeof record.number !== "number" ||
      typeof record.headRefName !== "string" ||
      (state !== "MERGED" && state !== "OPEN" && state !== "CLOSED")
    ) {
      return undefined;
    }
    changes.push({
      number: record.number,
      sourceBranch: record.headRefName,
      headSha: isSha(record.headRefOid) ? record.headRefOid : null,
      state,
      crossRepository: record.isCrossRepository !== false,
    });
  }
  return changes;
}

const GITLAB_STATES: Record<string, ForgeChangeState> = {
  merged: "MERGED",
  opened: "OPEN",
  locked: "OPEN",
  closed: "CLOSED",
};

export function parseGitLabListing(value: unknown): ForgeChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: ForgeChange[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    const state = typeof record.state === "string" ? GITLAB_STATES[record.state] : undefined;
    if (typeof record.iid !== "number" || typeof record.source_branch !== "string" || !state) {
      return undefined;
    }
    const sameProject =
      typeof record.source_project_id === "number" &&
      record.source_project_id === record.target_project_id;
    changes.push({
      number: record.iid,
      sourceBranch: record.source_branch,
      headSha: isSha(record.sha) ? record.sha : null,
      state,
      crossRepository: !sameProject,
    });
  }
  return changes;
}

/**
 * Lists the repository's changes once per run: one `gh pr list` call of up to
 * 1000 changes on GitHub, or up to ten pages of 100 merge requests on GitLab.
 * A branch whose only change is older than the listing window reads as having
 * no change, which keeps its worktree.
 */
export function listForgeChanges(
  identity: ForgeIdentity,
  options: { runner?: ForgeCommandRunner; sleep?: (milliseconds: number) => void } = {},
): ForgeListing {
  const runner = options.runner ?? defaultRunner;
  const sleep = options.sleep ?? sleepSync;
  if (identity.provider === "github") {
    const output = runWithRetry(runner, sleep, "gh", [
      "pr",
      "list",
      "--repo",
      identity.project,
      "--state",
      "all",
      "--limit",
      String(GITHUB_LIMIT),
      "--json",
      "number,headRefName,headRefOid,state,isCrossRepository",
    ]);
    if (output === undefined) {
      return { status: "unavailable", reason: "The GitHub listing failed after retries." };
    }
    try {
      const changes = parseGitHubListing(JSON.parse(output));
      return changes
        ? { status: "listed", provider: "github", changes }
        : { status: "unavailable", reason: "The GitHub listing was malformed." };
    } catch {
      return { status: "unavailable", reason: "The GitHub listing was malformed." };
    }
  }

  const changes: ForgeChange[] = [];
  const project = encodeURIComponent(identity.project);
  for (let page = 1; page <= GITLAB_MAX_PAGES; page += 1) {
    const output = runWithRetry(runner, sleep, "glab", [
      "api",
      "--method",
      "GET",
      `projects/${project}/merge_requests?state=all&scope=all&per_page=${GITLAB_PAGE_SIZE}&page=${page}`,
    ]);
    if (output === undefined) {
      return { status: "unavailable", reason: "The GitLab listing failed after retries." };
    }
    let pageChanges: ForgeChange[] | undefined;
    try {
      pageChanges = parseGitLabListing(JSON.parse(output));
    } catch {
      pageChanges = undefined;
    }
    if (!pageChanges) {
      return { status: "unavailable", reason: "The GitLab listing was malformed." };
    }
    changes.push(...pageChanges);
    if (pageChanges.length < GITLAB_PAGE_SIZE) break;
  }
  return { status: "listed", provider: "gitlab", changes };
}

export function newestSameRepositoryChange(
  changes: readonly ForgeChange[],
  branch: string,
): ForgeChange | undefined {
  let newest: ForgeChange | undefined;
  for (const change of changes) {
    if (change.crossRepository || change.sourceBranch !== branch) continue;
    if (!newest || change.number > newest.number) newest = change;
  }
  return newest;
}

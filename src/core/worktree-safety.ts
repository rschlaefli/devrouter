import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Local Git-safety evidence for deleting a worktree. Every failed check yields
 * one stable reason code; the codes are machine values shared with the
 * `worktree-reclaim` skill's classifier, so their spelling is a contract.
 */
export const WORKTREE_LOCAL_SAFETY_CODES = [
  "git-error",
  "detached",
  "index-lock",
  "operation-in-progress",
  "submodule",
  "dirty",
  "untracked",
  "ignored-state",
] as const;

export type WorktreeLocalSafetyCode = (typeof WORKTREE_LOCAL_SAFETY_CODES)[number];

export type WorktreeLocalSafety = {
  codes: WorktreeLocalSafetyCode[];
  /** Up to three example paths per path-based code, for human-readable reports. */
  examples: Partial<Record<WorktreeLocalSafetyCode, string[]>>;
};

/**
 * Ignored paths that are reproducible caches or build outputs. Losing them
 * costs a rebuild, never unique work. Patterns use the worktree pattern grammar
 * documented on `matchesWorktreePattern`.
 */
export const BUILTIN_DISPOSABLE_PATTERNS: readonly string[] = [
  "**/node_modules",
  "**/.pnpm-store",
  "**/vendor/bundle",
  "**/.venv",
  "**/venv",
  "**/__pycache__",
  "**/.pytest_cache",
  "**/.mypy_cache",
  "**/.ruff_cache",
  "**/.tox",
  "**/target",
  "**/.gradle",
  "**/.terraform",
  "**/dist",
  "**/build",
  "**/out",
  "**/coverage",
  "**/.next",
  "**/.nuxt",
  "**/.output",
  "**/.svelte-kit",
  "**/.turbo",
  "**/.cache",
  "**/.parcel-cache",
  "**/.vite",
  "**/.husky/_",
  "**/tmp/cache",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/*.pyc",
  "**/*.pyo",
  "**/*.log",
  "**/*.tsbuildinfo",
  "**/.eslintcache",
  "**/.stylelintcache",
  "**/next-env.d.ts",
  "**/.rollup.cache",
  "**/.claude/.cc-writes",
  "**/.claude/scheduled_tasks.lock",
];

/** Per-repository local override, one pattern per line; never committed. */
export const DISPOSABLE_OVERRIDE_FILE = path.join("info", "worktree-reclaim-disposable");

/** Markers in the worktree's own Git directory that mean an operation is unfinished. */
const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];

const segmentRegexCache = new Map<string, RegExp>();

function segmentMatches(patternSegment: string, pathSegment: string): boolean {
  if (!patternSegment.includes("*")) return patternSegment === pathSegment;
  let regex = segmentRegexCache.get(patternSegment);
  if (!regex) {
    const source = patternSegment
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    regex = new RegExp(`^${source}$`);
    segmentRegexCache.set(patternSegment, regex);
  }
  return regex.test(pathSegment);
}

function matchSegments(pattern: string[], target: string[], pi: number, ti: number): boolean {
  // A pattern that matches a leading part of the path covers everything beneath it.
  if (pi === pattern.length) return true;
  if (pattern[pi] === "**") {
    for (let next = ti; next <= target.length; next += 1) {
      if (matchSegments(pattern, target, pi + 1, next)) return true;
    }
    return false;
  }
  if (ti === target.length) return false;
  return segmentMatches(pattern[pi], target[ti]) && matchSegments(pattern, target, pi + 1, ti + 1);
}

/**
 * Validates one pattern: relative to the worktree root, `/`-separated, without
 * empty, `.` or `..` segments.
 */
export function isValidWorktreePattern(pattern: string): boolean {
  if (!pattern || pattern.startsWith("/") || pattern.includes("\\")) return false;
  return pattern.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

/**
 * Matches a worktree-relative path against a pattern. `*` matches within one
 * path segment, `**` matches zero or more whole segments, and a pattern that
 * matches a path also matches everything beneath it. A trailing `/` on the
 * path (Git's marker for a directory) is ignored.
 */
export function matchesWorktreePattern(pattern: string, relativePath: string): boolean {
  if (!isValidWorktreePattern(pattern)) return false;
  const target = relativePath.replace(/\/+$/, "").split("/").filter(Boolean);
  return matchSegments(pattern.split("/"), target, 0, 0);
}

// Converts one override line to the pattern grammar. A line that starts with
// "*/" uses the earlier shell-case syntax, which matched "/<path>/"; it
// becomes "**/<rest>" with a trailing "/" or "/*" removed. An inner "*" keeps
// its one-segment meaning, which can only make a line match fewer paths.
export function normalizeOverridePattern(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  if (!trimmed.startsWith("*/")) return isValidWorktreePattern(trimmed) ? trimmed : undefined;
  const rest = trimmed.slice(2).replace(/\/\*$/, "").replace(/\/+$/, "");
  const converted = `**/${rest}`;
  return isValidWorktreePattern(converted) ? converted : undefined;
}

export function readDisposableOverride(gitCommonDir: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(path.join(gitCommonDir, DISPOSABLE_OVERRIDE_FILE), "utf-8");
  } catch {
    return [];
  }
  return content
    .split(/\r?\n/)
    .map(normalizeOverridePattern)
    .filter((pattern): pattern is string => pattern !== undefined);
}

function git(worktreePath: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", ["-C", worktreePath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? "" };
}

function isEmptyRegularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && stat.size === 0;
  } catch {
    return false;
  }
}

function addExample(
  safety: WorktreeLocalSafety,
  code: WorktreeLocalSafetyCode,
  example: string,
): void {
  if (!safety.codes.includes(code)) safety.codes.push(code);
  const examples = safety.examples[code] ?? [];
  if (examples.length < 3) examples.push(example);
  safety.examples[code] = examples;
}

/**
 * Inspects one existing worktree for local state that deleting it would lose
 * or that makes deletion unsafe. Read-only: Git runs without optional locks.
 * The worktree lock and primary-checkout checks stay with the caller, which
 * already holds `git worktree list` evidence.
 */
export function inspectLocalWorktreeSafety(
  worktreePath: string,
  options: { extraDisposablePatterns?: readonly string[] } = {},
): WorktreeLocalSafety {
  const safety: WorktreeLocalSafety = { codes: [], examples: {} };

  const dirs = git(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, gitCommonDir] = dirs.stdout.split("\n").map((line) => line.trim());
  if (!dirs.ok || !gitDir || !gitCommonDir) {
    return { codes: ["git-error"], examples: {} };
  }

  if (!git(worktreePath, ["symbolic-ref", "-q", "HEAD"]).ok) safety.codes.push("detached");

  if (fs.existsSync(path.join(gitDir, "index.lock"))) safety.codes.push("index-lock");
  const marker = OPERATION_MARKERS.find((name) => fs.existsSync(path.join(gitDir, name)));
  if (marker) addExample(safety, "operation-in-progress", marker);
  if (fs.existsSync(path.join(gitDir, "modules"))) safety.codes.push("submodule");

  const status = git(worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (!status.ok) {
    if (!safety.codes.includes("git-error")) safety.codes.push("git-error");
    return safety;
  }

  const disposable = [
    ...BUILTIN_DISPOSABLE_PATTERNS,
    ...readDisposableOverride(gitCommonDir),
    ...(options.extraDisposablePatterns ?? []),
  ];
  const entries = status.stdout.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const entryPath = entry.slice(3);
    // Renames and copies carry their source path in the following -z entry.
    if (xy[0] === "R" || xy[0] === "C") index += 1;
    if (xy === "??") {
      addExample(safety, "untracked", entryPath);
    } else if (xy === "!!") {
      if (disposable.some((pattern) => matchesWorktreePattern(pattern, entryPath))) continue;
      // An empty ignored file, such as a seeded placeholder, holds nothing to lose.
      if (isEmptyRegularFile(path.join(worktreePath, entryPath))) continue;
      addExample(safety, "ignored-state", entryPath.replace(/\/+$/, ""));
    } else {
      addExample(safety, "dirty", entryPath);
    }
  }

  return safety;
}

export function describeLocalWorktreeSafety(safety: WorktreeLocalSafety): string {
  return safety.codes
    .map((code) => {
      const examples = safety.examples[code];
      return examples?.length ? `${code} (${examples.join(", ")})` : code;
    })
    .join("; ");
}

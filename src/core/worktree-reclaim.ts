import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import type { ForgeListing } from "./forge-changes";
import { comparableWorkspacePath } from "./workspace";
import type {
  WorkspaceCleanupReport,
  WorkspaceCleanupRow,
  WorkspaceCleanupWorktreeRow,
} from "./workspace-cleanup";
import type { WorktreeSafetyResult } from "./worktree-safety";

/**
 * Content-addressed reclaim manifests, shared with the `worktree-reclaim`
 * skill's `manifest.py`: either tool reads the other's manifests, and `hash`
 * and `select` produce byte-identical output. Approval names a manifest's
 * SHA-256, and apply never discovers or adds a target outside it.
 */
export const MANIFEST_KIND = "worktree-reclaim-manifest";
const LEGACY_MANIFEST_KIND = "rs-worktree-reclaim-manifest";
const RECEIPT_KIND = "worktree-reclaim-receipt";
const SCHEMA_VERSION = 1;
const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX_ID = /^[0-9a-f]{64}$/;
const VETO_TIMEOUT_MS = 30_000;
const FUTURE_TOLERANCE_SECONDS = 300;

export type ManifestAction = "reclaim" | "trim";

export type ManifestCandidate = {
  branch: string;
  branchRef: string;
  commonDir: string;
  gitDir: string;
  head: string;
  id: string;
  path: string;
  reason: string;
  repo: string;
  paths?: string[];
  sizeKb?: number | null;
  sessionAgeSeconds?: number | null;
  sessionEvidence?: string;
  sessionProvider?: string | null;
};

export type WorktreeManifest = {
  kind: string;
  schemaVersion: number;
  action?: ManifestAction;
  activitySource?: "agent-sessions" | "devrouter";
  activeWithin?: string;
  activeWithinSeconds?: number;
  allHistory?: boolean;
  candidateCount: number;
  candidates: ManifestCandidate[];
  createdAtEpoch: number;
};

const ROOT_KEYS = [
  "action",
  "activitySource",
  "candidateCount",
  "candidates",
  "createdAtEpoch",
  "kind",
  "schemaVersion",
];
const SESSION_ROOT_KEYS = ["activeWithin", "activeWithinSeconds", "allHistory"];
const LEGACY_ROOT_KEYS = [
  ...ROOT_KEYS.filter((key) => key !== "action" && key !== "activitySource"),
  ...SESSION_ROOT_KEYS,
];
const CANDIDATE_KEYS = [
  "branch",
  "branchRef",
  "commonDir",
  "gitDir",
  "head",
  "id",
  "path",
  "reason",
  "repo",
];
const SESSION_CANDIDATE_KEYS = ["sessionAgeSeconds", "sessionEvidence", "sessionProvider"];
const OPTIONAL_CANDIDATE_KEYS = [...SESSION_CANDIDATE_KEYS, "paths", "sizeKb"];

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(byteOrder)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Orders by UTF-8 bytes, which matches Python's code-point string order. */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf-8"), Buffer.from(right, "utf-8"));
}

/**
 * Canonical JSON: sorted keys, two-space indentation, UTF-8 without ASCII
 * escaping and one trailing newline. Matches Python's
 * `json.dump(indent=2, sort_keys=True, ensure_ascii=False)` for the ASCII keys
 * and string, integer, boolean and null values these files hold.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function sha256Hex(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function candidateId(candidate: Omit<ManifestCandidate, "id">): string {
  const identity = {
    branchRef: candidate.branchRef,
    commonDir: candidate.commonDir,
    gitDir: candidate.gitDir,
    head: candidate.head,
    path: candidate.path,
    repo: candidate.repo,
  };
  return sha256Hex(JSON.stringify(sortKeys(identity)));
}

function requireKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const missing = required.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !required.includes(key) && !optional.includes(key));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} fields differ (missing: ${missing.sort().join(", ") || "none"}; extra: ${extra.sort().join(", ") || "none"})`,
    );
  }
}

function isRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function validateCandidate(
  value: unknown,
  index: number,
  action: ManifestAction,
  legacy: boolean,
): ManifestCandidate {
  const label = `candidate[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (legacy) {
    requireKeys(candidate, [...CANDIDATE_KEYS, ...SESSION_CANDIDATE_KEYS, "sizeKb"], [], label);
  } else {
    requireKeys(candidate, CANDIDATE_KEYS, OPTIONAL_CANDIDATE_KEYS, label);
  }
  if (action === "trim") {
    const paths = candidate.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(`${label}.paths must be a non-empty array for a trim manifest`);
    }
    if (!paths.every(isRelativePath)) {
      throw new Error(`${label}.paths must hold worktree-relative paths without '..'`);
    }
    const sorted = [...new Set(paths as string[])].sort(byteOrder);
    if (sorted.length !== paths.length || sorted.some((entry, i) => entry !== paths[i])) {
      throw new Error(`${label}.paths must be sorted and unique`);
    }
  } else if ("paths" in candidate) {
    throw new Error(`${label}.paths is only valid in a trim manifest`);
  }
  for (const key of CANDIDATE_KEYS) {
    if (typeof candidate[key] !== "string") throw new Error(`${label}.${key} must be a string`);
    if ((candidate[key] as string).includes("\0")) {
      throw new Error(`${label}.${key} cannot contain a NUL byte`);
    }
  }
  for (const key of ["repo", "path", "commonDir", "gitDir"]) {
    if (!path.isAbsolute(candidate[key] as string)) {
      throw new Error(`${label}.${key} must be an absolute path`);
    }
  }
  const branchRef = candidate.branchRef as string;
  if (!branchRef.startsWith("refs/heads/"))
    throw new Error(`${label}.branchRef must name a local branch`);
  if (candidate.branch !== branchRef.slice("refs/heads/".length)) {
    throw new Error(`${label}.branch does not match branchRef`);
  }
  if (!HEX_SHA.test(candidate.head as string))
    throw new Error(`${label}.head is not a Git object ID`);
  if (!HEX_ID.test(candidate.id as string))
    throw new Error(`${label}.id is not a SHA-256 identifier`);
  if (candidate.id !== candidateId(candidate as ManifestCandidate)) {
    throw new Error(`${label}.id does not match its immutable identity`);
  }
  const evidence = candidate.sessionEvidence ?? "";
  if (typeof evidence !== "string" || evidence.includes("\0")) {
    throw new Error(`${label}.sessionEvidence must be a string`);
  }
  const provider = candidate.sessionProvider;
  if (provider !== undefined && provider !== null && typeof provider !== "string") {
    throw new Error(`${label}.sessionProvider must be a string or null`);
  }
  for (const key of ["sessionAgeSeconds", "sizeKb"]) {
    const item = candidate[key];
    if (item !== undefined && item !== null && !isNonNegativeInteger(item)) {
      throw new Error(`${label}.${key} must be a non-negative integer or null`);
    }
  }
  return candidate as ManifestCandidate;
}

/** The same strict schema `manifest.py` enforces. */
export function validateManifest(value: unknown): WorktreeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest root must be an object");
  }
  const root = value as Record<string, unknown>;
  const legacy = root.kind === LEGACY_MANIFEST_KIND;
  if (root.kind !== MANIFEST_KIND && !legacy)
    throw new Error(`manifest kind must be ${MANIFEST_KIND}`);
  let action: ManifestAction = "reclaim";
  if (legacy) {
    requireKeys(root, LEGACY_ROOT_KEYS, [], "manifest");
  } else {
    requireKeys(root, ROOT_KEYS, SESSION_ROOT_KEYS, "manifest");
    if (root.action !== "reclaim" && root.action !== "trim") {
      throw new Error("manifest action must be reclaim or trim");
    }
    action = root.action;
    if (root.activitySource !== "agent-sessions" && root.activitySource !== "devrouter") {
      throw new Error("manifest activitySource must be agent-sessions or devrouter");
    }
    if (
      root.activitySource === "agent-sessions" &&
      !SESSION_ROOT_KEYS.every((key) => key in root)
    ) {
      throw new Error(
        "an agent-sessions manifest records activeWithin, activeWithinSeconds and allHistory",
      );
    }
  }
  if (root.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`manifest schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!isNonNegativeInteger(root.createdAtEpoch)) {
    throw new Error("manifest createdAtEpoch must be a non-negative integer");
  }
  if ("activeWithin" in root && (typeof root.activeWithin !== "string" || !root.activeWithin)) {
    throw new Error("manifest activeWithin must be a non-empty string");
  }
  if (
    "activeWithinSeconds" in root &&
    (!Number.isInteger(root.activeWithinSeconds) || (root.activeWithinSeconds as number) <= 0)
  ) {
    throw new Error("manifest activeWithinSeconds must be a positive integer");
  }
  if ("allHistory" in root && typeof root.allHistory !== "boolean") {
    throw new Error("manifest allHistory must be a boolean");
  }
  if (!Array.isArray(root.candidates)) throw new Error("manifest candidates must be an array");
  if (!isNonNegativeInteger(root.candidateCount)) {
    throw new Error("manifest candidateCount must be a non-negative integer");
  }
  if (root.candidateCount !== root.candidates.length) {
    throw new Error("manifest candidateCount does not match candidates");
  }
  const candidates = root.candidates.map((candidate, index) =>
    validateCandidate(candidate, index, action, legacy),
  );
  const orderKey = (candidate: ManifestCandidate) =>
    [candidate.repo, candidate.path, candidate.id] as const;
  for (let index = 1; index < candidates.length; index += 1) {
    const [a, b] = [orderKey(candidates[index - 1]), orderKey(candidates[index])];
    const order = byteOrder(a[0], b[0]) || byteOrder(a[1], b[1]) || byteOrder(a[2], b[2]);
    if (order > 0) throw new Error("manifest candidates are not in canonical order");
  }
  for (const [key, label] of [
    ["id", "candidate ID"],
    ["path", "worktree path"],
    ["gitDir", "worktree Git directory"],
  ] as const) {
    if (new Set(candidates.map((candidate) => candidate[key])).size !== candidates.length) {
      throw new Error(`manifest contains a duplicate ${label}`);
    }
  }
  const branches = candidates.map((candidate) => `${candidate.repo}\0${candidate.branchRef}`);
  if (new Set(branches).size !== branches.length) {
    throw new Error("manifest contains a duplicate repository branch");
  }
  return root as unknown as WorktreeManifest;
}

/**
 * Reads and validates a manifest. Both tools write canonical JSON, so devrouter
 * also requires the file to be canonical; that rules out duplicate keys, which
 * `JSON.parse` would otherwise resolve silently.
 */
export function readManifest(file: string): { raw: Buffer; manifest: WorktreeManifest } {
  const raw = fs.readFileSync(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch (error) {
    throw new Error(`manifest is not valid UTF-8 JSON: ${(error as Error).message}`);
  }
  const manifest = validateManifest(parsed);
  if (canonicalJson(parsed) !== raw.toString("utf-8")) {
    throw new Error("manifest is not in canonical JSON form");
  }
  return { raw, manifest };
}

export function requireManifestHash(raw: Buffer, expected: string, label = "manifest"): string {
  const normalized = expected.toLowerCase();
  if (!HEX_ID.test(normalized))
    throw new Error("expected SHA-256 must be 64 hexadecimal characters");
  const actual = sha256Hex(raw);
  if (actual !== normalized) {
    throw new Error(`${label} SHA-256 mismatch (expected ${normalized}; got ${actual})`);
  }
  return actual;
}

/** A canonical subset of an approved source manifest, selected by exact candidate IDs. */
export function selectManifest(file: string, expectedSha256: string, ids: string[]): string {
  const { raw, manifest } = readManifest(file);
  requireManifestHash(raw, expectedSha256, "source manifest");
  if (new Set(ids).size !== ids.length) {
    throw new Error("the same candidate ID was selected more than once");
  }
  const known = new Set(manifest.candidates.map((candidate) => candidate.id));
  const missing = ids.filter((id) => !known.has(id)).sort(byteOrder);
  if (missing.length) throw new Error(`candidate ID is not in the source manifest: ${missing[0]}`);
  const selected = manifest.candidates.filter((candidate) => ids.includes(candidate.id));
  if (!selected.length) throw new Error("manifest selection is empty");
  const subset = { ...manifest, candidates: selected, candidateCount: selected.length };
  validateManifest(subset);
  return canonicalJson(subset);
}

export type WorktreeIdentity = Pick<
  ManifestCandidate,
  "repo" | "path" | "branchRef" | "head" | "commonDir" | "gitDir"
>;

function gitLine(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  const output = result.stdout?.trim();
  return result.status === 0 && !result.error && output ? output : undefined;
}

/**
 * The immutable identity of a linked worktree, derived the way the skill
 * derives it: real paths, the primary checkout as the repository, absolute Git
 * directories and the full branch ref. Undefined when any part is unreadable.
 */
export function readWorktreeIdentity(worktreePath: string): WorktreeIdentity | undefined {
  if (!fs.existsSync(worktreePath)) return undefined;
  const real = comparableWorkspacePath(worktreePath);
  const commonDir = gitLine(real, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = gitLine(real, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const branchRef = gitLine(real, ["symbolic-ref", "--quiet", "HEAD"]);
  const head = gitLine(real, ["rev-parse", "HEAD"]);
  if (!commonDir || !gitDir || !branchRef || !head) return undefined;
  const repo = comparableWorkspacePath(commonDir.replace(/\/\.git$/, ""));
  return { repo, path: real, branchRef, head, commonDir, gitDir };
}

export function identityMismatch(expected: WorktreeIdentity, actual: WorktreeIdentity | undefined) {
  if (!actual) return "the worktree identity is unreadable";
  const changed = (["repo", "path", "branchRef", "head", "commonDir", "gitDir"] as const).filter(
    (key) => expected[key] !== actual[key],
  );
  return changed.length ? `${changed.join(", ")} changed since approval` : undefined;
}

/**
 * The newest local activity of a tree devrouter does not manage: its index,
 * HEAD and HEAD reflog, and the working tree's top-level folder. Agents touch
 * at least one of them on every edit, checkout or commit.
 */
export function unmanagedActivityEpoch(worktreePath: string, gitDir: string): number | undefined {
  let latest: number | undefined;
  for (const file of [
    path.join(gitDir, "index"),
    path.join(gitDir, "HEAD"),
    path.join(gitDir, "logs", "HEAD"),
    worktreePath,
  ]) {
    try {
      const seconds = Math.floor(fs.statSync(file).mtimeMs / 1000);
      latest = latest === undefined ? seconds : Math.max(latest, seconds);
    } catch {
      // A missing reflog or index is no activity evidence.
    }
  }
  return latest;
}

export function isQuiet(
  row: { managed?: WorkspaceCleanupRow; worktreePath: string },
  gitDir: string,
  cutoffEpoch: number,
): boolean {
  if (row.managed) return row.managed.activity === "quiet";
  const latest = unmanagedActivityEpoch(row.worktreePath, gitDir);
  return latest !== undefined && latest < cutoffEpoch;
}

/**
 * The reclaim manifest for a schema-3 cleanup report: every RECLAIM tree whose
 * activity is older than the report's cutoff, bound to its current identity.
 */
export function buildReclaimManifest(report: WorkspaceCleanupReport, createdAtEpoch: number) {
  const cutoffEpoch = Math.floor(Date.parse(report.cutoff) / 1000);
  const rows: {
    managed?: WorkspaceCleanupRow;
    worktreePath: string;
    safety?: WorktreeSafetyResult;
  }[] = [
    ...report.workspaces.map((row) => ({
      managed: row,
      worktreePath: row.worktreePath,
      safety: row.safety,
    })),
    ...(report.worktrees ?? []).map((row: WorkspaceCleanupWorktreeRow) => ({
      worktreePath: row.worktreePath,
      safety: row.safety,
    })),
  ];
  const candidates: ManifestCandidate[] = [];
  for (const row of rows) {
    if (row.safety?.verdict !== "RECLAIM") continue;
    const identity = readWorktreeIdentity(row.worktreePath);
    if (!identity || !isQuiet(row, identity.gitDir, cutoffEpoch)) continue;
    const change = row.safety.change ? ` ${row.safety.change.number}` : "";
    const candidate = {
      ...identity,
      branch: identity.branchRef.slice("refs/heads/".length),
      reason: `merged change${change}, clean, quiet since ${report.cutoff}`,
    };
    candidates.push({ ...candidate, id: candidateId(candidate) });
  }
  candidates.sort(
    (a, b) => byteOrder(a.repo, b.repo) || byteOrder(a.path, b.path) || byteOrder(a.id, b.id),
  );
  const manifest: WorktreeManifest = {
    action: "reclaim",
    activitySource: "devrouter",
    candidateCount: candidates.length,
    candidates,
    createdAtEpoch,
    kind: MANIFEST_KIND,
    schemaVersion: SCHEMA_VERSION,
  };
  validateManifest(manifest);
  return canonicalJson(manifest);
}

export function receiptPath(commonDir: string, manifestSha256: string, id: string): string {
  return path.join(commonDir, "worktree-reclaim", "receipts", manifestSha256, `${id}.json`);
}

export function matchingReceipt(candidate: ManifestCandidate, manifestSha256: string): boolean {
  try {
    const receipt = JSON.parse(
      fs.readFileSync(receiptPath(candidate.commonDir, manifestSha256, candidate.id), "utf-8"),
    );
    return (
      receipt.kind === RECEIPT_KIND &&
      receipt.schemaVersion === SCHEMA_VERSION &&
      receipt.manifestSha256 === manifestSha256 &&
      receipt.candidateId === candidate.id &&
      receipt.path === candidate.path &&
      receipt.head === candidate.head
    );
  } catch {
    return false;
  }
}

export function writeReceipt(
  candidate: ManifestCandidate,
  manifestSha256: string,
  steps: string[],
  nowEpoch: number,
): void {
  const file = receiptPath(candidate.commonDir, manifestSha256, candidate.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(
    file,
    canonicalJson({
      branchRef: candidate.branchRef,
      candidateId: candidate.id,
      completedAtEpoch: nowEpoch,
      head: candidate.head,
      kind: RECEIPT_KIND,
      manifestSha256,
      path: candidate.path,
      schemaVersion: SCHEMA_VERSION,
      steps,
      tool: "devrouter",
    }),
  );
}

export type ReclaimSkipCode =
  | "stale-identity"
  | "verdict-keep"
  | "active"
  | "veto-denied"
  | "lock-unavailable";
export type ReclaimFailureCode = "teardown-failed" | "environment";

export type ReclaimTargetOutcome = {
  id: string;
  path: string;
  status: "reclaimed" | "already-done" | "would-reclaim" | "skipped" | "failed" | "not-attempted";
  code?: ReclaimSkipCode | ReclaimFailureCode;
  reason?: string;
  /** Steps completed for this target, in order; non-empty on a half-finished failure. */
  steps: string[];
};

export type ReclaimApplyReport = {
  manifestSha256: string;
  dryRun: boolean;
  targets: ReclaimTargetOutcome[];
  stoppedEarly: boolean;
};

/** Thrown inside the lifecycle lock to leave a target untouched. */
export class ReclaimSkip extends Error {
  constructor(
    readonly code: ReclaimSkipCode,
    message: string,
  ) {
    super(message);
  }
}

export type ReclaimVerdictContext = {
  forge: ForgeListing;
  /** The current safety verdict for one exact worktree path. */
  classify: (worktreePath: string) => WorktreeSafetyResult;
  /** Whether the tree has activity inside the window; used when no veto command is given. */
  isActive: (worktreePath: string) => boolean;
};

export type ReclaimApplyDependencies = {
  /** Fresh verdict context for one repository, built once at apply start. */
  prepare: (repo: string) => ReclaimVerdictContext;
  /**
   * Inside one lifecycle-lock acquisition for the exact path: runs `verify`,
   * removes the runtime (for a managed tree) and the worktree, then runs
   * `afterRemove`. Appends each completed step to `steps`.
   */
  removeWorktree: (
    candidate: ManifestCandidate,
    verify: () => void,
    afterRemove: () => void,
    steps: string[],
  ) => Promise<void>;
  runVeto?: (command: string, worktreePath: string) => boolean;
  nowEpoch?: () => number;
};

/**
 * Runs the veto command. A non-zero exit or a timeout denies the target; a
 * command that can no longer be started is an environment failure.
 */
export function runVetoCommand(command: string, worktreePath: string): boolean {
  const result = spawnSync(command, [worktreePath], {
    stdio: ["ignore", "ignore", "inherit"],
    timeout: VETO_TIMEOUT_MS,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.error && code !== "ETIMEDOUT") {
    throw Object.assign(new Error(`veto command failed to run: ${result.error.message}`), {
      reclaimCode: "environment" as const,
    });
  }
  return result.status === 0 && !result.error && result.signal === null;
}

function assertVetoCommand(command: string): void {
  if (!path.isAbsolute(command)) throw new Error("--veto-command must be an absolute path");
  try {
    fs.accessSync(command, fs.constants.X_OK);
  } catch {
    throw new Error(`--veto-command '${command}' is missing or not executable`);
  }
}

/**
 * The checks every apply runs before it looks at a target: hash, schema, age,
 * action and a usable veto command. Returns the validated manifest and the
 * apply time.
 */
export function preflightManifestApply(
  options: { manifestFile: string; sha256: string; maxAgeSeconds: number; vetoCommand?: string },
  action: ManifestAction,
  nowEpoch?: () => number,
): { manifest: WorktreeManifest; manifestSha256: string; now: number } {
  const { raw, manifest } = readManifest(options.manifestFile);
  const manifestSha256 = requireManifestHash(raw, options.sha256);
  const now = nowEpoch?.() ?? Math.floor(Date.now() / 1000);
  if (manifest.createdAtEpoch > now + FUTURE_TOLERANCE_SECONDS) {
    throw new Error("manifest creation time is in the future");
  }
  const age = Math.max(0, now - manifest.createdAtEpoch);
  if (age > options.maxAgeSeconds) {
    throw new Error(`manifest is ${age}s old; maximum allowed age is ${options.maxAgeSeconds}s`);
  }
  const actual = manifest.action ?? "reclaim";
  if (actual !== action) {
    const other = action === "reclaim" ? "trim" : "reclaim";
    throw new Error(`this is a ${other} manifest; apply it with \`devrouter workspace ${other}\``);
  }
  if (manifest.candidates.length === 0) throw new Error("approved manifest is empty");
  if (options.vetoCommand) assertVetoCommand(options.vetoCommand);
  return { manifest, manifestSha256, now };
}

/**
 * Deletes the branch only while it still points at the approved HEAD. The
 * compare-and-delete is one `update-ref` call, so a concurrent commit keeps
 * the branch. Returns a warning when the branch was kept.
 */
function deleteBranchIfUnmoved(candidate: ManifestCandidate, steps: string[]): string | undefined {
  const exists = spawnSync(
    "git",
    ["-C", candidate.repo, "show-ref", "--verify", "--quiet", candidate.branchRef],
    { encoding: "utf-8" },
  );
  if (exists.status === 1) return undefined;
  if (exists.status !== 0) {
    throw new Error(`cannot read branch ${candidate.branch}: ${(exists.stderr ?? "").trim()}`);
  }
  const result = spawnSync(
    "git",
    ["-C", candidate.repo, "update-ref", "-d", candidate.branchRef, candidate.head],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    return `branch ${candidate.branch} no longer points at the approved HEAD; it was kept for review`;
  }
  steps.push("branch-deleted");
  return undefined;
}

/**
 * Applies an approved reclaim manifest. Without `yes` it is a dry run that
 * verifies every target and changes nothing. Each target is verified again
 * inside its own lifecycle lock immediately before teardown; a target that
 * changed is skipped, and an error after teardown began stops the batch.
 */
export async function applyReclaimManifest(
  options: {
    manifestFile: string;
    sha256: string;
    maxAgeSeconds: number;
    vetoCommand?: string;
    yes: boolean;
  },
  dependencies: ReclaimApplyDependencies,
): Promise<ReclaimApplyReport> {
  const { manifest, manifestSha256, now } = preflightManifestApply(
    options,
    "reclaim",
    dependencies.nowEpoch,
  );
  const runVeto = dependencies.runVeto ?? runVetoCommand;

  const contexts = new Map<string, ReclaimVerdictContext>();
  const contextFor = (repo: string): ReclaimVerdictContext => {
    let context = contexts.get(repo);
    if (!context) {
      context = dependencies.prepare(repo);
      contexts.set(repo, context);
    }
    return context;
  };

  const targets: ReclaimTargetOutcome[] = [];
  const errorCodes = new Set<string>();
  let stoppedEarly = false;
  for (const candidate of manifest.candidates) {
    const outcome: ReclaimTargetOutcome = {
      id: candidate.id,
      path: candidate.path,
      status: "skipped",
      steps: [],
    };
    targets.push(outcome);
    if (stoppedEarly) {
      outcome.status = "not-attempted";
      continue;
    }
    if (!fs.existsSync(candidate.path) && matchingReceipt(candidate, manifestSha256)) {
      outcome.status = "already-done";
      continue;
    }

    let entered = false;
    let verified = false;
    const verify = (): void => {
      entered = true;
      const mismatch = identityMismatch(candidate, readWorktreeIdentity(candidate.path));
      if (mismatch) throw new ReclaimSkip("stale-identity", mismatch);
      const context = contextFor(candidate.repo);
      if (context.forge.status !== "listed") {
        throw Object.assign(new Error(context.forge.reason), {
          reclaimCode: "environment" as const,
        });
      }
      const verdict = context.classify(candidate.path);
      if (verdict.verdict !== "RECLAIM") {
        throw new ReclaimSkip(
          "verdict-keep",
          `verdict is now ${verdict.verdict} (${verdict.codes.join(", ")})`,
        );
      }
      if (options.vetoCommand) {
        if (!runVeto(options.vetoCommand, candidate.path)) {
          throw new ReclaimSkip("veto-denied", "the veto command denied the reclaim");
        }
      } else if (context.isActive(candidate.path)) {
        throw new ReclaimSkip("active", "activity inside the window");
      }
      verified = true;
    };

    try {
      if (!options.yes) {
        verify();
        outcome.status = "would-reclaim";
        continue;
      }
      let warning: string | undefined;
      await dependencies.removeWorktree(
        candidate,
        verify,
        () => {
          warning = deleteBranchIfUnmoved(candidate, outcome.steps);
        },
        outcome.steps,
      );
      writeReceipt(candidate, manifestSha256, outcome.steps, now);
      outcome.status = "reclaimed";
      if (warning) outcome.reason = warning;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The lifecycle lock does not wait. A held lock before `verify` started
      // means another operation owns the tree right now; any later error,
      // including a nested lock timeout, happened after teardown may have begun.
      const skip =
        error instanceof ReclaimSkip
          ? error
          : !entered && /gave up after waiting/.test(message)
            ? new ReclaimSkip("lock-unavailable", message)
            : undefined;
      if (skip) {
        outcome.code = skip.code;
        outcome.reason = message;
        // The same skip twice in a row from an unavailable lock points at a
        // stuck holder, not a stale target.
        if (skip.code === "lock-unavailable" && errorCodes.has(skip.code)) stoppedEarly = true;
        errorCodes.add(skip.code);
        continue;
      }
      const code =
        (error as { reclaimCode?: ReclaimFailureCode }).reclaimCode ??
        (verified || outcome.steps.length ? "teardown-failed" : "environment");
      outcome.status = "failed";
      outcome.code = code;
      outcome.reason = message;
      stoppedEarly = true;
    }
  }
  return { manifestSha256, dryRun: !options.yes, targets, stoppedEarly };
}

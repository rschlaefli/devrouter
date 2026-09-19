import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomically } from "./atomic-file";
import { withFileLockSync } from "./file-lock";
import { DEVROUTER_HOME } from "./router";
import { comparableWorkspacePath } from "./workspace";

/**
 * Durable continuation ledger for gated harness tool calls.
 *
 * An agent harness can re-deliver a tool call whose wait it granted, or resume
 * one whose wait it cancelled, and a repeated mutating command is not
 * recoverable. This ledger keys the newest gated decisions by `tool_use_id` so
 * the gate can return one refusal instead of waiting again, which preserves the
 * uncertainty of an interrupted call. It is bounded, private to the checkout's
 * real path, and never blocks the agent when it is unreadable or unwritable.
 */

export const HARNESS_CONTINUATION_MAX_ENTRIES = 64;
export const HARNESS_CONTINUATION_TTL_MS = 24 * 60 * 60 * 1000;
export const HARNESS_CONTINUATION_LOCK_WAIT_MS = 200;
const MAX_LEDGER_BYTES = 256 * 1024;
const MAX_TOOL_USE_ID_LENGTH = 256;
const MAX_PHASE_LENGTH = 32;

export type HarnessContinuationState = "waiting" | "granted" | "refused" | "interrupted";

export type HarnessContinuationEntry = {
  toolUseId: string;
  payloadSha256: string;
  state: HarnessContinuationState;
  phase: string;
  budgetMs: number;
  claimedAtMs: number;
  settledAtMs?: number;
  waitedMs?: number;
};

export type HarnessContinuationClaim =
  | { kind: "claimed"; recorded: boolean }
  | { kind: "replay"; entry: HarnessContinuationEntry };

/** Private ledger path for one checkout, keyed by its comparable real path. */
export function harnessContinuationPath(repoRoot: string): string {
  const key = createHash("sha256").update(comparableWorkspacePath(repoRoot)).digest("hex");
  return path.join(DEVROUTER_HOME, "harness", `${key}.json`);
}

function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validEntry(value: unknown): value is HarnessContinuationEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.toolUseId === "string" &&
    entry.toolUseId.length > 0 &&
    entry.toolUseId.length <= MAX_TOOL_USE_ID_LENGTH &&
    typeof entry.payloadSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.payloadSha256) &&
    (entry.state === "waiting" ||
      entry.state === "granted" ||
      entry.state === "refused" ||
      entry.state === "interrupted") &&
    typeof entry.phase === "string" &&
    entry.phase.length <= MAX_PHASE_LENGTH &&
    counter(entry.budgetMs) &&
    counter(entry.claimedAtMs) &&
    (entry.settledAtMs === undefined || counter(entry.settledAtMs)) &&
    (entry.waitedMs === undefined || counter(entry.waitedMs))
  );
}

/** Read the ledger tolerantly: unsafe, foreign or oversized evidence is absent. */
function readLedgerSync(file: string, nowMs: number): HarnessContinuationEntry[] {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES) return [];
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(validEntry)
    .filter(
      (entry) => nowMs - (entry.settledAtMs ?? entry.claimedAtMs) < HARNESS_CONTINUATION_TTL_MS,
    );
}

/** Current non-expired entries for one checkout; never throws. */
export function readHarnessContinuations(
  repoRoot: string,
  nowMs = Date.now(),
): HarnessContinuationEntry[] {
  try {
    return readLedgerSync(harnessContinuationPath(repoRoot), nowMs);
  } catch {
    return [];
  }
}

/**
 * Claim a gated tool call before deferring. A repeat of an existing
 * `tool_use_id` is a replay and must refuse instead of waiting again. When the
 * ledger cannot be written the call is still claimed, so a broken ledger never
 * blocks agent work.
 */
export function claimHarnessContinuation(
  repoRoot: string,
  claim: {
    toolUseId: string;
    payloadSha256: string;
    phase: string;
    budgetMs: number;
    nowMs?: number;
  },
): HarnessContinuationClaim {
  const nowMs = claim.nowMs ?? Date.now();
  try {
    const file = harnessContinuationPath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return withFileLockSync(
      `${file}.lock`,
      { activity: "harness continuation claim", waitMs: HARNESS_CONTINUATION_LOCK_WAIT_MS },
      () => {
        const entries = readLedgerSync(file, nowMs);
        const existing = entries.find((entry) => entry.toolUseId === claim.toolUseId);
        if (existing) return { kind: "replay", entry: existing } as HarnessContinuationClaim;
        entries.push({
          toolUseId: claim.toolUseId,
          payloadSha256: claim.payloadSha256,
          state: "waiting",
          phase: claim.phase,
          budgetMs: claim.budgetMs,
          claimedAtMs: nowMs,
        });
        writeFileAtomically(
          file,
          `${JSON.stringify(entries.slice(-HARNESS_CONTINUATION_MAX_ENTRIES))}\n`,
        );
        return { kind: "claimed", recorded: true } as HarnessContinuationClaim;
      },
    );
  } catch {
    return { kind: "claimed", recorded: false };
  }
}

/**
 * Settle a claim once the wait finished or the hook was cancelled. A missing
 * entry or an already settled one is left untouched: evidence of the first
 * decision is never overwritten.
 */
export function settleHarnessContinuation(
  repoRoot: string,
  toolUseId: string,
  settlement: {
    state: Exclude<HarnessContinuationState, "waiting">;
    waitedMs?: number;
    nowMs?: number;
  },
): void {
  const nowMs = settlement.nowMs ?? Date.now();
  try {
    const file = harnessContinuationPath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    withFileLockSync(
      `${file}.lock`,
      { activity: "harness continuation settlement", waitMs: HARNESS_CONTINUATION_LOCK_WAIT_MS },
      () => {
        const entries = readLedgerSync(file, nowMs);
        const index = entries.findIndex((entry) => entry.toolUseId === toolUseId);
        if (index < 0 || entries[index]?.state !== "waiting") return;
        entries[index] = {
          ...(entries[index] as HarnessContinuationEntry),
          state: settlement.state,
          settledAtMs: nowMs,
          ...(settlement.waitedMs === undefined ? {} : { waitedMs: settlement.waitedMs }),
        };
        writeFileAtomically(
          file,
          `${JSON.stringify(entries.slice(-HARNESS_CONTINUATION_MAX_ENTRIES))}\n`,
        );
      },
    );
  } catch {
    // Best effort: a failed settlement never changes the tool decision.
  }
}

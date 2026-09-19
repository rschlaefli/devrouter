import fs from "node:fs";
import path from "node:path";
import type { ReliabilityState } from "./reliability-contract";
import { type ReliabilityIdentity, readReliabilityOperation } from "./reliability-operation-store";
import { comparableWorkspacePath, resolveWorktreeWorkspace } from "./workspace";
import { resolveWorkspaceRuntimeOrDefault } from "./workspace-runtime";

/**
 * Agent harness tool gating for managed environments.
 *
 * A harness tool call (shell, browser, MCP) that starts while devrouter is
 * mid-transition can fail for reasons the agent cannot act on, which pushes the
 * model into a retry loop. The gate defers that tool call here, inside the
 * harness hook process, until the checkout's durable lifecycle phase settles.
 * The wait consumes no model turns because the harness is blocked on the hook.
 *
 * The gate is advisory and fail-open on uncertainty: it defers only on a
 * positively observed transition and allows when evidence is unavailable,
 * because blocking agent tooling on devrouter's own unreadable state is the
 * failure mode this boundary exists to remove. Lifecycle commands themselves
 * stay fail-closed in their own engines.
 */

export type HarnessGatePhase = ReliabilityState["phase"] | "unknown";

export type HarnessGateObservation = {
  phase: HarnessGatePhase;
  /** Values-free evidence marker for progress output; never drives the decision. */
  detail?: string;
};

export type HarnessGateReason =
  | "settled"
  | "settled-after-wait"
  | "budget-exhausted"
  | "continuation-replay"
  | "evidence-unavailable"
  | "unmanaged-checkout"
  | "devrouter-command"
  | "hook-payload-invalid";

/**
 * Durable claim outcome for a gated call. The harness can re-deliver a call
 * whose wait it granted or cancelled, so a repeat must refuse instead of
 * waiting again.
 */
export type HarnessGateContinuationState = "granted" | "refused" | "interrupted";

export type HarnessGateClaim =
  | { kind: "claimed" }
  | { kind: "replay"; state: HarnessGateContinuationState; settledAtMs?: number };

export type HarnessGateDecision = {
  version: 1;
  decision: "allow" | "deferred-allow" | "refuse";
  reason: HarnessGateReason;
  waitedMs: number;
  observations: number;
  observedPhase: HarnessGatePhase;
  continuation?: { state: HarnessGateContinuationState; settledAtMs?: number };
};

export const HARNESS_GATE_DEFAULT_BUDGET_MS = 30_000;
export const HARNESS_GATE_MAX_BUDGET_MS = 600_000;
export const HARNESS_GATE_POLL_INTERVAL_MS = 2_000;

const TRANSITIONAL_PHASES: readonly HarnessGatePhase[] = [
  "queued",
  "starting",
  "verifying",
  "recovering",
  "stopping",
];

const REPO_ROOT_MAX_DEPTH = 64;

export function isTransitionalHarnessPhase(phase: HarnessGatePhase): boolean {
  return TRANSITIONAL_PHASES.includes(phase);
}

/** Walk up from a session directory to the checkout that owns .devrouter.yml. */
export function findHarnessGateRepoRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < REPO_ROOT_MAX_DEPTH; depth += 1) {
    if (fs.existsSync(path.join(current, ".devrouter.yml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

/** Read the exact checkout's durable lifecycle phase without interpreting it. */
export function readHarnessGateObservation(repoRoot: string): HarnessGateObservation {
  try {
    const identity: ReliabilityIdentity = {
      repoPath: comparableWorkspacePath(repoRoot),
      workspace: resolveWorktreeWorkspace(repoRoot) ?? null,
      provider: resolveWorkspaceRuntimeOrDefault(repoRoot),
    };
    const record = readReliabilityOperation(identity);
    if (!record) {
      return { phase: "unknown", detail: "no-lifecycle-record" };
    }
    return { phase: record.state.phase, detail: "lifecycle-record" };
  } catch {
    return { phase: "unknown", detail: "evidence-unavailable" };
  }
}

/**
 * Defer while the observed phase is transitional, re-checking on a throttled
 * interval until the phase settles or the budget is exhausted. The harness hook
 * timeout must exceed the budget; a hook that overruns its timeout is not
 * honored and the tool proceeds under the harness's normal permission rules.
 */
export async function waitForHarnessGate(options: {
  observe: () => HarnessGateObservation;
  budgetMs: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onObservation?: (observation: HarnessGateObservation, waitedMs: number) => void;
  /**
   * Claim the call before the first deferral. A replay returns one refusal
   * without waiting again; a claim that cannot be recorded still allows the
   * ordinary wait, so ledger trouble never blocks the agent.
   */
  claim?: (observation: HarnessGateObservation) => HarnessGateClaim;
}): Promise<HarnessGateDecision> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = Math.max(1, options.pollIntervalMs ?? HARNESS_GATE_POLL_INTERVAL_MS);
  const budget = Math.max(0, Math.min(options.budgetMs, HARNESS_GATE_MAX_BUDGET_MS));
  // The wait clock starts at the first observation. Resolving a checkout's
  // identity against the provider registries can take seconds on a cold hook
  // process, and charging that setup to the wait would refuse a call that
  // never waited and report a wait that never happened.
  let started: number | undefined;
  let observations = 0;
  let deferred = false;

  for (;;) {
    const observation = options.observe();
    if (started === undefined) {
      started = now();
    }
    observations += 1;
    options.onObservation?.(observation, now() - started);
    if (!isTransitionalHarnessPhase(observation.phase)) {
      const waitedMs = now() - started;
      return {
        version: 1,
        decision: deferred ? "deferred-allow" : "allow",
        reason: deferred ? "settled-after-wait" : "settled",
        waitedMs,
        observations,
        observedPhase: observation.phase,
      };
    }
    const waitedMs = now() - started;
    if (waitedMs + interval > budget) {
      return {
        version: 1,
        decision: "refuse",
        reason: "budget-exhausted",
        waitedMs,
        observations,
        observedPhase: observation.phase,
      };
    }
    if (!deferred && options.claim) {
      const claim = options.claim(observation);
      if (claim.kind === "replay") {
        return {
          version: 1,
          decision: "refuse",
          reason: "continuation-replay",
          waitedMs,
          observations,
          observedPhase: observation.phase,
          continuation: { state: claim.state, settledAtMs: claim.settledAtMs },
        };
      }
    }
    deferred = true;
    await sleep(Math.min(interval, budget - waitedMs));
  }
}

/** Parse a bounded wait budget; invalid or absent values use the default. */
export function parseHarnessGateBudget(value: unknown): number {
  if (value === undefined) {
    return HARNESS_GATE_DEFAULT_BUDGET_MS;
  }
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return HARNESS_GATE_DEFAULT_BUDGET_MS;
  }
  return Math.min(Math.trunc(parsed), HARNESS_GATE_MAX_BUDGET_MS);
}

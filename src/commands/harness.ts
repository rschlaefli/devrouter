import { createHash } from "node:crypto";
import {
  claimHarnessContinuation,
  readHarnessContinuations,
  settleHarnessContinuation,
} from "../core/harness-continuation";
import {
  findHarnessGateRepoRoot,
  type HarnessGateClaim,
  type HarnessGateDecision,
  type HarnessGateObservation,
  isTransitionalHarnessPhase,
  parseHarnessGateBudget,
  readHarnessGateObservation,
  waitForHarnessGate,
} from "../core/harness-gate";

const MAX_HOOK_PAYLOAD_BYTES = 256 * 1024;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_TOOL_USE_ID_LENGTH = 256;

/**
 * Lifecycle commands drive the transitions this gate defers on, so they always
 * pass through; deferring them would deadlock the environment they repair.
 */
const DEVROUTER_COMMAND_RE =
  /(?:^|[\s;&|()])(?:npx\s+|pnpm\s+(?:exec\s+)?|npm\s+(?:exec\s+)?|yarn\s+)?devrouter(?:-process)?(?:\s|$)/;

type HarnessHookPayload = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  cwd?: unknown;
};

export type HarnessGateDependencies = {
  stdin?: () => Promise<string>;
  observe?: (repoRoot: string) => HarnessGateObservation;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stderr?: (line: string) => void;
  claim?: (repoRoot: string, claim: HarnessContinuationClaimInput) => HarnessGateClaim;
  settle?: (
    repoRoot: string,
    toolUseId: string,
    settlement: {
      state: "granted" | "refused" | "interrupted";
      waitedMs?: number;
    },
  ) => void;
  lookup?: (
    repoRoot: string,
    toolUseId: string,
  ) => { state: "granted" | "refused" | "interrupted"; settledAtMs?: number } | undefined;
};

export type HarnessContinuationClaimInput = {
  toolUseId: string;
  payloadSha256: string;
  phase: string;
  budgetMs: number;
};

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise<string>((resolve) => {
    let input = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(input);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > MAX_HOOK_PAYLOAD_BYTES) {
        finish();
        process.stdin.destroy();
      }
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function permitReason(decision: HarnessGateDecision): string {
  const seconds = (decision.waitedMs / 1000).toFixed(1);
  if (decision.reason === "continuation-replay") {
    const settled = decision.continuation?.settledAtMs;
    const age =
      settled === undefined
        ? ""
        : ` ${Math.max(0, Math.round((Date.now() - settled) / 1000))}s ago`;
    if (decision.continuation?.state === "granted") {
      return `devrouter: this tool call was already permitted after a wait${age}; it is not re-evaluated. Verify whether it ran before issuing a new call.`;
    }
    if (decision.continuation?.state === "refused") {
      return `devrouter: this tool call was already refused${age}; do not repeat it. Run 'devrouter status .' and issue a new call once it settles.`;
    }
    return `devrouter: this tool call's wait was cancelled${age}; the harness may have run it. Verify whether it ran before issuing a new call.`;
  }
  switch (decision.decision) {
    case "refuse":
      return `devrouter: the managed environment is still ${decision.observedPhase} after waiting ${seconds}s. Do not retry automatically; run 'devrouter status .' and continue once it settles.`;
    case "deferred-allow":
      return `devrouter: environment settled after ${seconds}s; the tool may run now.`;
    default:
      return "devrouter: environment settled.";
  }
}

function hookOutput(decision: HarnessGateDecision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision === "refuse" ? "deny" : "allow",
      permissionDecisionReason: permitReason(decision),
    },
  });
}

function gateDecision(
  decision: string,
  reason: HarnessGateDecision["reason"],
  observedPhase: HarnessGateDecision["observedPhase"] = "unknown",
): HarnessGateDecision {
  return {
    version: 1,
    decision: decision as HarnessGateDecision["decision"],
    reason,
    waitedMs: 0,
    observations: 0,
    observedPhase,
  };
}

export async function runHarnessCommand(
  method: string,
  options: Record<string, unknown>,
  repoPath?: string,
  dependencies: HarnessGateDependencies = {},
): Promise<void> {
  if (method !== "gate") {
    throw new Error(`Unsupported harness method: ${method}`);
  }
  const json = options.json === true;
  const stderr = dependencies.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const observe = dependencies.observe ?? readHarnessGateObservation;
  const raw = await (dependencies.stdin ?? readStdin)();

  let payload: HarnessHookPayload | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) payload = parsed;
  } catch {
    payload = undefined;
  }
  if (!payload) {
    const decision = gateDecision("allow", "hook-payload-invalid");
    process.stdout.write(json ? `${JSON.stringify(decision)}\n` : `${hookOutput(decision)}\n`);
    return;
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (toolName === "Bash" && DEVROUTER_COMMAND_RE.test(command)) {
    const decision = gateDecision("allow", "devrouter-command");
    process.stdout.write(json ? `${JSON.stringify(decision)}\n` : `${hookOutput(decision)}\n`);
    return;
  }

  const sessionCwd =
    repoPath ??
    (typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : undefined);
  const repoRoot = sessionCwd ? findHarnessGateRepoRoot(sessionCwd) : undefined;
  if (!repoRoot) {
    const decision = gateDecision("allow", "unmanaged-checkout");
    process.stdout.write(json ? `${JSON.stringify(decision)}\n` : `${hookOutput(decision)}\n`);
    return;
  }

  const budgetMs = parseHarnessGateBudget(options.waitBudgetMs);
  const toolUseId =
    typeof payload.tool_use_id === "string" &&
    payload.tool_use_id.length > 0 &&
    payload.tool_use_id.length <= MAX_TOOL_USE_ID_LENGTH
      ? payload.tool_use_id
      : undefined;
  const payloadSha256 = createHash("sha256").update(JSON.stringify(toolInput)).digest("hex");
  const claim =
    dependencies.claim ??
    ((root: string, input: HarnessContinuationClaimInput): HarnessGateClaim => {
      const outcome = claimHarnessContinuation(root, input);
      if (outcome.kind === "claimed") {
        if (!outcome.recorded) {
          stderr(
            "devrouter harness gate: continuation ledger is unavailable; repeat protection is off for this checkout",
          );
        }
        return { kind: "claimed" };
      }
      const entry = outcome.entry;
      return {
        kind: "replay",
        state:
          entry.state === "granted"
            ? "granted"
            : entry.state === "refused"
              ? "refused"
              : "interrupted",
        settledAtMs: entry.settledAtMs,
      };
    });
  const settle =
    dependencies.settle ??
    ((
      root: string,
      id: string,
      settlement: { state: "granted" | "refused" | "interrupted"; waitedMs?: number },
    ) => {
      settleHarnessContinuation(root, id, settlement);
    });
  const lookup =
    dependencies.lookup ??
    ((root: string, id: string) => {
      const entry = readHarnessContinuations(root).find((candidate) => candidate.toolUseId === id);
      if (!entry) return undefined;
      return {
        state:
          entry.state === "granted"
            ? ("granted" as const)
            : entry.state === "refused"
              ? ("refused" as const)
              : // A claim still waiting belongs to a hook that never returned.
                ("interrupted" as const),
        settledAtMs: entry.settledAtMs,
      };
    });
  if (toolUseId) {
    const replay = lookup(repoRoot, toolUseId);
    if (replay) {
      const decision: HarnessGateDecision = {
        version: 1,
        decision: "refuse",
        reason: "continuation-replay",
        waitedMs: 0,
        observations: 0,
        observedPhase: "unknown",
        continuation: { state: replay.state, settledAtMs: replay.settledAtMs },
      };
      process.stdout.write(
        json
          ? `${JSON.stringify({ ...decision, checkout: repoRoot })}\n`
          : `${hookOutput(decision)}\n`,
      );
      return;
    }
  }
  const interruption = (signal: NodeJS.Signals): void => {
    if (toolUseId) {
      settle(repoRoot, toolUseId, { state: "interrupted" });
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (toolUseId) {
    process.once("SIGINT", interruption);
    process.once("SIGTERM", interruption);
  }
  let announced = false;
  let decision: HarnessGateDecision;
  try {
    decision = await waitForHarnessGate({
      observe: () => observe(repoRoot),
      budgetMs,
      now: dependencies.now,
      sleep: dependencies.sleep,
      claim: toolUseId
        ? (observation) =>
            claim(repoRoot, {
              toolUseId,
              payloadSha256,
              phase: observation.phase,
              budgetMs,
            })
        : undefined,
      onObservation: (observation) => {
        if (!announced && isTransitionalHarnessPhase(observation.phase)) {
          announced = true;
          stderr(
            `devrouter harness gate: ${observation.phase} in progress; deferring this tool call for up to ${Math.round(budgetMs / 1000)}s without model turns`,
          );
        }
      },
    });
  } finally {
    if (toolUseId) {
      process.removeListener("SIGINT", interruption);
      process.removeListener("SIGTERM", interruption);
    }
  }
  if (toolUseId && decision.reason !== "continuation-replay" && decision.decision !== "allow") {
    settle(repoRoot, toolUseId, {
      state: decision.decision === "refuse" ? "refused" : "granted",
      waitedMs: decision.waitedMs,
    });
  }
  if (decision.decision === "deferred-allow") {
    stderr(
      `devrouter harness gate: settled after ${(decision.waitedMs / 1000).toFixed(1)}s (${decision.observations} checks)`,
    );
  }
  process.stdout.write(
    json ? `${JSON.stringify({ ...decision, checkout: repoRoot })}\n` : `${hookOutput(decision)}\n`,
  );
}

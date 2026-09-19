import {
  findHarnessGateRepoRoot,
  type HarnessGateDecision,
  type HarnessGateObservation,
  isTransitionalHarnessPhase,
  parseHarnessGateBudget,
  readHarnessGateObservation,
  waitForHarnessGate,
} from "../core/harness-gate";

const MAX_HOOK_PAYLOAD_BYTES = 256 * 1024;
const STDIN_TIMEOUT_MS = 5_000;

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
  cwd?: unknown;
};

export type HarnessGateDependencies = {
  stdin?: () => Promise<string>;
  observe?: (repoRoot: string) => HarnessGateObservation;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stderr?: (line: string) => void;
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
  let announced = false;
  const decision = await waitForHarnessGate({
    observe: () => observe(repoRoot),
    budgetMs,
    now: dependencies.now,
    sleep: dependencies.sleep,
    onObservation: (observation) => {
      if (!announced && isTransitionalHarnessPhase(observation.phase)) {
        announced = true;
        stderr(
          `devrouter harness gate: ${observation.phase} in progress; deferring this tool call for up to ${Math.round(budgetMs / 1000)}s without model turns`,
        );
      }
    },
  });
  if (decision.decision === "deferred-allow") {
    stderr(
      `devrouter harness gate: settled after ${(decision.waitedMs / 1000).toFixed(1)}s (${decision.observations} checks)`,
    );
  }
  process.stdout.write(
    json ? `${JSON.stringify({ ...decision, checkout: repoRoot })}\n` : `${hookOutput(decision)}\n`,
  );
}

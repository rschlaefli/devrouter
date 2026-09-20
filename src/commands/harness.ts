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

const DEVROUTER_EXECUTABLES = new Set(["devrouter", "devrouter-process"]);
const LAUNCHER_WORDS = new Set(["npx", "pnpm", "npm", "yarn"]);
const LAUNCHER_SUBCOMMANDS = new Set(["exec", "dlx"]);
const COMMAND_WORD_LIMIT = 8;

/**
 * Split a command line at the operators that start a new command. Nothing else
 * is interpreted: quoting is only tracked so a separator inside a quoted
 * argument does not split the line, and an unfinished quote simply keeps the
 * rest of the line together.
 */
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const char of command) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (
      char === ";" ||
      char === "\n" ||
      char === "&" ||
      char === "|" ||
      char === "(" ||
      char === ")"
    ) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** The leading words of one command segment with quoting removed. */
function segmentWords(segment: string, limit: number): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (current) words.push(current);
    current = "";
  };
  for (const char of segment) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      if (words.length >= limit) return words;
      continue;
    }
    current += char;
  }
  flush();
  return words;
}

/** The executable a command word names, whether bare, relative or absolute. */
function executableName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The command word of one segment, skipping environment and launcher prefixes. */
function commandWord(segment: string): string | undefined {
  const words = segmentWords(segment, COMMAND_WORD_LIMIT);
  let index = 0;
  for (;;) {
    const word = words[index];
    if (word === undefined) return undefined;
    if (word === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
      index += 1;
      continue;
    }
    break;
  }
  const launcher = words[index];
  if (launcher !== undefined && LAUNCHER_WORDS.has(executableName(launcher))) {
    index += 1;
    const subcommand = words[index];
    if (subcommand !== undefined && LAUNCHER_SUBCOMMANDS.has(subcommand)) index += 1;
  }
  return words[index];
}

/**
 * Lifecycle commands drive the transitions this gate defers on, so they always
 * pass through; deferring them would deadlock the environment they repair. The
 * executable itself is recognized, including an absolute or checkout-local
 * path and the package-manager launchers that can start it, so the same command
 * passes through however the agent spells the binary.
 */
function isDevrouterLifecycleCommand(command: string): boolean {
  return commandSegments(command).some((segment) => {
    const word = commandWord(segment);
    return word !== undefined && DEVROUTER_EXECUTABLES.has(executableName(word));
  });
}

type HarnessHookPayload = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  cwd?: unknown;
};

/**
 * The hook envelope differs between agent harnesses. Claude Code accepts
 * permissionDecision allow or deny; Codex honors deny but reports an allow
 * decision as an unsupported hook output, so an allowed call there is expressed
 * as an ordinary completion, optionally carrying additional context.
 */
export type HarnessHookKind = "claude" | "codex";

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

/**
 * Identify the harness from its payload, so the same harness gate command works
 * in either one with no repository configuration. Claude Code delivers a
 * prompt_id; Codex delivers a per-turn turn_id.
 */
export function detectHarnessHook(payload: Record<string, unknown>): HarnessHookKind {
  const turnId = payload.turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? "codex" : "claude";
}

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
  // Only an observation of a settled phase may claim settlement. Bypasses and
  // missing evidence keep their own wording so the transcript never reports a
  // check the gate did not perform.
  switch (decision.reason) {
    case "budget-exhausted":
      return `devrouter: the managed environment is still ${decision.observedPhase} after waiting ${seconds}s. Do not retry automatically; run 'devrouter status .' and continue once it settles.`;
    case "settled-after-wait":
      return `devrouter: environment settled after ${seconds}s; the tool may run now.`;
    case "devrouter-command":
      return "devrouter: lifecycle command; the gate left it to the lifecycle engine and did not observe the environment.";
    case "unmanaged-checkout":
      return "devrouter: no managed checkout was found for this call; the gate did not observe environment state.";
    case "hook-payload-invalid":
      return "devrouter: the hook payload was unreadable; the gate did not observe environment state.";
    case "evidence-unavailable":
      return "devrouter: lifecycle evidence was unavailable; the gate observed no settled phase and the tool proceeds.";
    default:
      return "devrouter: environment settled.";
  }
}

/**
 * Render the hook decision in the requesting harness's accepted shape. A
 * refusal is a deny in both. An allowed call is permissionDecision allow for
 * Claude Code; Codex rejects that value, so it receives a bare completion and
 * the settled guidance travels as additionalContext.
 */
function hookOutput(decision: HarnessGateDecision, kind: HarnessHookKind): string {
  if (decision.decision === "refuse") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: permitReason(decision),
      },
    });
  }
  if (kind === "codex") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: permitReason(decision),
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
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

  // The requesting harness decides the accepted output envelope.
  let kind: HarnessHookKind = "claude";
  let payload: HarnessHookPayload | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) payload = parsed;
  } catch {
    payload = undefined;
  }
  if (!payload) {
    const decision = gateDecision("allow", "hook-payload-invalid");
    process.stdout.write(
      json ? `${JSON.stringify(decision)}\n` : `${hookOutput(decision, kind)}\n`,
    );
    return;
  }

  kind = detectHarnessHook(payload);

  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  // Claude Code delivers the shell command as `command`; the Codex CLI delivers
  // the same field as `cmd` on its `exec_command` tool. Both spellings are read
  // without depending on the tool name, so the lifecycle passthrough holds in
  // either harness instead of deferring the command that repairs the checkout.
  const command =
    typeof toolInput.command === "string"
      ? toolInput.command
      : typeof toolInput.cmd === "string"
        ? toolInput.cmd
        : "";
  if (isDevrouterLifecycleCommand(command)) {
    const decision = gateDecision("allow", "devrouter-command");
    process.stdout.write(
      json ? `${JSON.stringify(decision)}\n` : `${hookOutput(decision, kind)}\n`,
    );
    return;
  }

  const sessionCwd =
    repoPath ??
    (typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : undefined);
  const repoRoot = sessionCwd ? findHarnessGateRepoRoot(sessionCwd) : undefined;
  if (!repoRoot) {
    const decision = gateDecision("allow", "unmanaged-checkout");
    process.stdout.write(
      json ? `${JSON.stringify(decision)}\n` : `${hookOutput(decision, kind)}\n`,
    );
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
          : `${hookOutput(decision, kind)}\n`,
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
    json
      ? `${JSON.stringify({ ...decision, checkout: repoRoot })}\n`
      : `${hookOutput(decision, kind)}\n`,
  );
}

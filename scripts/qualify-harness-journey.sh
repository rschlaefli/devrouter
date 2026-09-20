#!/usr/bin/env bash
# Qualify the enforcing agent-harness journey across two managed checkouts.
#
# A real agent harness runs against a local mock model API inside a fixture
# repository with two linked worktrees, "affected" and "neighbour". Each
# worktree carries its own .devrouter.yml, so the pair is exactly the two
# environments a devrouter-managed repository exposes. The shipped
# "devrouter harness gate" is that repository's PreToolUse hook, so every tool
# call is decided by the product against the durable lifecycle phase of the
# checkout the harness reports.
#
# Scenarios:
#   deferral  - "affected" is mid-transition and settles while the hook waits, so
#               the one tool call runs after a real enforced wait.
#   refusal   - "affected" outlasts the wait budget, so the one tool call is
#               refused once with phase and recovery guidance, and never runs.
#   neighbour - "neighbour" stays usable while "affected" is still transitional:
#               its identical tool call is allowed immediately, with no wait and
#               no change to the transitional checkout. A separate bounded
#               direct gate probe then proves the allowed call really observed a
#               settled phase instead of a fail-open decision.
#
# Evidence comes from real artifacts only: the harness transcript (including its
# own permission_denials), the hook payload, the hook decision, the mock request
# trace, the tool's own side effect, the durable lifecycle journal and the
# harness continuation ledger. The acceptance claim is that the agent performs no
# infrastructure repair, so a dirty checkout, a second tool call, a consumed
# model turn while waiting, or a moved neighbour all fail the run.
#
# DR_JOURNEY_HARNESS selects the harness: claude (default) or codex. Both run the
# same three scenarios through the same shipped gate. Only the mock protocol, the
# hook configuration and the harness invocation differ, so a second harness
# either honors the same product contract or fails the same assertions.
#
# Neither credentials nor model access are needed: ANTHROPIC_BASE_URL (Claude
# Code) or a local model_provider (Codex) points at a server that speaks the
# harness's own protocol with a scripted conversation. Each scenario prints one
# JSON evidence line and exits nonzero when an assertion fails; raw logs stay
# under the work directory (DR_JOURNEY_WORK, kept on failure and removed on
# success).
#
# Exit codes: 0 every scenario passed, 1 an assertion failed, 3 a prerequisite
# was unavailable and no scenario ran. A skip is not a pass, so a caller that
# records acceptance must reject 3 instead of reading it as success.
#
# DR_JOURNEY_EVIDENCE=<path> writes one sanitized run summary there: the
# outcome, the per-scenario assertions, the exact source revision and built
# bundle hash, and the harness and runtime versions. It carries no credentials
# and no model output.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$DR_JOURNEY_DIST"
if [ -z "$DIST" ]; then DIST="$ROOT/dist/devrouter.js"; fi
HARNESS="$DR_JOURNEY_HARNESS"
if [ -z "$HARNESS" ]; then HARNESS=claude; fi
CLAUDE="$DR_JOURNEY_CLAUDE"
if [ -z "$CLAUDE" ]; then CLAUDE="$(command -v claude || true)"; fi
CODEX="$DR_JOURNEY_CODEX"
if [ -z "$CODEX" ]; then CODEX="$(command -v codex.opencodex-real || command -v codex || true)"; fi
NODE="$DR_JOURNEY_NODE"
if [ -z "$NODE" ]; then NODE="$(command -v node || true)"; fi
TSX="$ROOT/node_modules/.bin/tsx"
PORT="$DR_JOURNEY_PORT"
if [ -z "$PORT" ]; then PORT=8791; fi
MOCK_HEALTH="/api/hello"
if [ "$HARNESS" = "codex" ]; then MOCK_HEALTH="/healthz"; fi
EVIDENCE="$DR_JOURNEY_EVIDENCE"
HARNESS_VERSION=""

# Sanitized run summary for the caller's own evidence retention. The per-scenario
# results are read back from the assertion artifacts, so the summary restates
# real checks instead of a second opinion about the run.
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_evidence() {
  local outcome="$1" reason="$2"
  [ -n "$EVIDENCE" ] || return 0
  [ -n "$NODE" ] || return 0
  DR_EVIDENCE_PATH="$EVIDENCE" \
    DR_EVIDENCE_OUTCOME="$outcome" \
    DR_EVIDENCE_REASON="$reason" \
    DR_EVIDENCE_WORK="$WORK" \
    DR_EVIDENCE_HARNESS="$HARNESS" \
    DR_EVIDENCE_HARNESS_VERSION="$HARNESS_VERSION" \
    DR_EVIDENCE_REVISION="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)" \
    DR_EVIDENCE_DIST_SHA256="$("$NODE" -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$DIST" 2>/dev/null || true)" \
    DR_EVIDENCE_STARTED_AT="$STARTED_AT" \
    "$NODE" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const work = process.env.DR_EVIDENCE_WORK || "";
    const scenarios = ["deferral", "refusal", "neighbour"].map((name) => {
      let asserted = null;
      try {
        asserted = JSON.parse(fs.readFileSync(path.join(work, "assert-" + name + ".json"), "utf8"));
      } catch {
        asserted = null;
      }
      if (!asserted) return { scenario: name, outcome: "not-run", failures: [] };
      const failures = Array.isArray(asserted.failures) ? asserted.failures : [];
      return { scenario: name, outcome: failures.length > 0 ? "fail" : "pass", failures };
    });
    const summary = {
      schema: "devrouter.harness-journey.v1",
      outcome: process.env.DR_EVIDENCE_OUTCOME,
      reason: process.env.DR_EVIDENCE_REASON || null,
      devrouter: {
        revision: process.env.DR_EVIDENCE_REVISION || null,
        distSha256: process.env.DR_EVIDENCE_DIST_SHA256 || null,
      },
      harness: {
        name: process.env.DR_EVIDENCE_HARNESS || null,
        version: process.env.DR_EVIDENCE_HARNESS_VERSION || null,
      },
      node: process.version,
      provider: "local mock model API; no credentials and no model access",
      scenarios,
      startedAt: process.env.DR_EVIDENCE_STARTED_AT || null,
      finishedAt: new Date().toISOString(),
    };
    const target = process.env.DR_EVIDENCE_PATH;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2) + "\n");
    ' || true
  printf 'evidence: %s\n' "$EVIDENCE"
}

skip() {
  printf '%s\n' "$1"
  write_evidence skipped "$1"
  exit 3
}
[ -f "$DIST" ] || skip "Harness journey skipped: build dist/devrouter.js first (pnpm build)."
[ -n "$NODE" ] || skip "Harness journey skipped: node is unavailable."
[ -x "$TSX" ] || skip "Harness journey skipped: tsx is unavailable (run pnpm install)."
case "$HARNESS" in
  claude) [ -n "$CLAUDE" ] || skip "Harness journey skipped: the claude CLI is unavailable." ;;
  codex) [ -n "$CODEX" ] || skip "Harness journey skipped: the codex CLI is unavailable." ;;
  *) skip "Harness journey skipped: DR_JOURNEY_HARNESS=$HARNESS is neither claude nor codex." ;;
esac

case "$HARNESS" in
  claude) HARNESS_VERSION="$("$CLAUDE" --version 2>/dev/null | head -n 1 || true)" ;;
  codex) HARNESS_VERSION="$("$CODEX" --version 2>/dev/null | head -n 1 || true)" ;;
esac

WORK="$DR_JOURNEY_WORK"
if [ -n "$WORK" ]; then
  mkdir -p "$WORK"
else
  TMP_BASE="$TMPDIR"
  if [ -z "$TMP_BASE" ]; then TMP_BASE=/tmp; fi
  WORK="$(mktemp -d "$TMP_BASE/devrouter-harness-journey.XXXXXX")"
fi
# $TMPDIR may end in a separator and /var is a symlink on macOS, so make the
# fixture root physical: the harness reports physical paths, and evidence,
# assertions and the product's own ledger keys must all agree on one spelling.
WORK="$(cd "$WORK" && pwd -P)"
HOME_DIR="$WORK/home"
REPO="$WORK/fixture"
AFFECTED="$REPO/trees/affected"
NEIGHBOUR="$REPO/trees/neighbour"
JOURNAL="$WORK/journal.mjs"
ASSERT="$WORK/assert-journey.mjs"
CODEX_SUMMARY="$WORK/summarize-codex.mjs"
HOOK="$WORK/hook-gate.sh"
SETTINGS="$WORK/settings.json"
HOOKS="$HOME_DIR/hooks.json"
CODEX_CONFIG="$HOME_DIR/config.toml"
MOCK="$WORK/mock-api.mjs"
FAILED=0
MOCK_PID=""

cleanup() {
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" >/dev/null 2>&1 || true; fi
  git -C "$REPO" worktree remove --force "$AFFECTED" >/dev/null 2>&1 || true
  git -C "$REPO" worktree remove --force "$NEIGHBOUR" >/dev/null 2>&1 || true
  if [ "$FAILED" = "0" ] && [ -z "$DR_JOURNEY_WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

start_mock() {
  local tool_command="$1" trace="$2"
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" >/dev/null 2>&1 || true; fi
  : > "$trace"
  DR_MOCK_PORT="$PORT" DR_MOCK_TRACE="$trace" DR_MOCK_TOOL_COMMAND="$tool_command" \
    "$NODE" "$MOCK" >> "$WORK/mock.log" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT$MOCK_HEALTH" 2>/dev/null && return 0
    sleep 0.25
  done
  echo "the mock model API did not start" >&2
  return 1
}

mkdir -p "$HOME_DIR" "$REPO"
printf "trees/\n" > "$REPO/.gitignore"
printf "fixture\n" > "$REPO/README.md"
# Both checkouts carry the managed marker exactly as a real devrouter repository
# does: the gate resolves the checkout from the directory the harness reports,
# so a worktree without .devrouter.yml would read as unmanaged.
printf "version: 1\napps: []\n" > "$REPO/.devrouter.yml"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=journey@devrouter.local -c user.name=devrouter-journey commit -qm "journey fixture"
git -C "$REPO" worktree add -q -b affected "$AFFECTED"
git -C "$REPO" worktree add -q -b neighbour "$NEIGHBOUR"

cat > "$JOURNAL" <<'JOURNAL_EOF'
// Read or write a fixture checkout's durable lifecycle phase through the real
// store, and report the exact artifacts the assertions read back.
import { createHash } from "node:crypto";
import fs from "node:fs";

const core = process.env.DR_JOURNEY_SRC;
const store = await import(core + "/reliability-operation-store.ts");
const continuation = await import(core + "/harness-continuation.ts");
const workspace = await import(core + "/workspace.ts");
const runtime = await import(core + "/workspace-runtime.ts");

const checkout = process.argv[2];
const action = process.argv[3];
const phase = process.argv[4];
const identity = {
  repoPath: workspace.comparableWorkspacePath(checkout),
  workspace: workspace.resolveWorktreeWorkspace(checkout) ?? null,
  provider: runtime.resolveWorkspaceRuntimeOrDefault(checkout),
};
const key = createHash("sha256").update(identity.repoPath).digest("hex");
const file = process.env.HOME + "/.config/devrouter/reliability/" + key + ".json";

if (action === "set") {
  store.updateReliabilityOperation(identity, (record) => {
    record.state.phase = phase;
  });
}
const record = store.readReliabilityOperation(identity);
const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);

if (action === "ledger") {
  console.log(
    JSON.stringify({
      path: continuation.harnessContinuationPath(checkout),
      entries: continuation.readHarnessContinuations(checkout),
    }),
  );
} else {
  console.log(
    JSON.stringify({
      key,
      file,
      phase: record?.state.phase ?? null,
      revision: record?.revision ?? 0,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
}
JOURNAL_EOF

cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# The repository PreToolUse hook: devrouter decides, in-process, whether the
# tool call may run now, must wait, or must be refused once.
payload="$(cat)"
printf '%s' "$payload" > "$DR_JOURNEY_HOOK_PAYLOAD"
out=$(printf '%s' "$payload" | "$DR_JOURNEY_NODE" "$DR_JOURNEY_DIST" harness gate --wait-budget-ms "$DR_GATE_BUDGET" 2>>"$DR_JOURNEY_HOOK_LOG.err")
printf '%s\t%s\t%s\n' "$(date +%s)" "$DR_GATE_BUDGET" "$out" >> "$DR_JOURNEY_HOOK_LOG"
printf '%s\n' "$out"
HOOK_EOF
chmod +x "$HOOK"

# Each harness reads its hook configuration from its own place: Claude Code from
# the settings file passed on the command line, the Codex CLI from
# $CODEX_HOME/hooks.json. The matcher names the shell tool in both, and the
# timeout stays above the largest wait budget so the harness never abandons a
# gating hook mid-wait.
if [ "$HARNESS" = "codex" ]; then
  cat > "$HOOKS" <<HOOKS_EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "exec_command|Bash|shell",
        "hooks": [{ "type": "command", "command": "$HOOK", "timeout": 180 }]
      }
    ]
  }
}
HOOKS_EOF
  cat > "$CODEX_CONFIG" <<CODEX_CONFIG_EOF
model = "journey-model"
model_provider = "journey"

[model_providers.journey]
name = "journey"
base_url = "http://127.0.0.1:$PORT/v1"
wire_api = "responses"
env_key = "JOURNEY_API_KEY"
CODEX_CONFIG_EOF
else
  cat > "$SETTINGS" <<SETTINGS_EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "$HOOK", "timeout": 120 }]
      }
    ]
  }
}
SETTINGS_EOF
fi

if [ "$HARNESS" = "codex" ]; then
cat > "$MOCK" <<'MOCK_RESPONSES_EOF'
// Minimal Responses API server with one scripted tool turn, so the Codex CLI can
// be driven without credentials or model access. Every model request is recorded
// as one trace line in the same normalized shape the Messages mock produces, so
// the assertions read either harness without a second parser.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.DR_MOCK_PORT ?? 8791);
const trace = process.env.DR_MOCK_TRACE;
const toolCommand = process.env.DR_MOCK_TOOL_COMMAND;
let requests = 0;
// Each scenario starts a fresh mock against the same checkouts, and the gate's
// continuation ledger is keyed by tool-call id, so the ids must not repeat.
const runId = Math.random().toString(36).slice(2, 8);

function commandOf(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText ?? "{}");
    return typeof parsed?.cmd === "string" ? parsed.cmd : "";
  } catch {
    return "";
  }
}

function sse(res, type, data) {
  res.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      // Readiness only: it must never look like a model request in the trace.
      if (pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const startedAt = Date.now();
      requests += 1;
      const parsed = JSON.parse(body || "{}");
      const input = Array.isArray(parsed.input) ? parsed.input : [];
      const toolUses = input
        .filter((item) => item?.type === "function_call")
        .map((item) => ({
          id: item.call_id ?? item.id ?? "",
          name: item.name ?? "",
          command: commandOf(item.arguments),
        }));
      const toolResults = input
        .filter((item) => item?.type === "function_call_output")
        .map((item) => ({
          toolUseId: item.call_id ?? "",
          hasError: !/Process exited with code 0/.test(String(item.output ?? "")),
          text: String(item.output ?? "").slice(0, 400),
        }));
      const kind = toolResults.length > 0 ? "message" : "tool_call";
      const response = {
        id: "resp_" + requests,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        model: parsed.model ?? "journey-model",
        output: [],
        usage: null,
      };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, "response.created", { type: "response.created", response });
      if (kind === "tool_call") {
        const item = {
          type: "function_call",
          id: "fc_" + requests + "_" + runId,
          call_id: "call_" + requests + "_" + runId,
          name: "exec_command",
          arguments: "",
          status: "in_progress",
        };
        const call = {
          ...item,
          arguments: JSON.stringify({ cmd: toolCommand }),
          status: "completed",
        };
        sse(res, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item });
        sse(res, "response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: JSON.stringify({ cmd: toolCommand }),
        });
        sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: call });
        sse(res, "response.completed", {
          type: "response.completed",
          response: {
            ...response,
            status: "completed",
            output: [call],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        });
      } else {
        const item = {
          type: "message",
          id: "msg_" + requests,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "JOURNEY-DONE", annotations: [] }],
        };
        sse(res, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item });
        sse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "JOURNEY-DONE",
        });
        sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
        sse(res, "response.completed", {
          type: "response.completed",
          response: {
            ...response,
            status: "completed",
            output: [item],
            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
          },
        });
      }
      res.end();
      // Measured after the client consumed the stream, so the number is the
      // mock's own service time rather than its first write.
      fs.appendFileSync(
        trace,
        JSON.stringify({
          at: new Date().toISOString(),
          tookMs: Date.now() - startedAt,
          kind,
          toolUses,
          toolResults,
        }) + "\n",
      );
    });
  })
  .listen(port, "127.0.0.1");
MOCK_RESPONSES_EOF
else
cat > "$MOCK" <<'MOCK_EOF'
// Minimal Messages API server with one scripted tool turn, so a real harness can
// be driven without credentials or model access. Every request is recorded as
// one trace line, so the assertions can tell an executed tool call from a
// refused one.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.DR_MOCK_PORT ?? 8791);
const trace = process.env.DR_MOCK_TRACE;
const toolCommand = process.env.DR_MOCK_TOOL_COMMAND;
let toolTurns = 0;

function summarize(messages) {
  const toolUses = [];
  const toolResults = [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "tool_use") {
        toolUses.push({ id: block.id, name: block.name, command: block.input?.command ?? "" });
      }
      if (block?.type === "tool_result") {
        const text = Array.isArray(block.content)
          ? block.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
          : typeof block.content === "string"
            ? block.content
            : "";
        toolResults.push({
          toolUseId: block.tool_use_id ?? "",
          hasError: block.is_error === true,
          text: text.slice(0, 400),
        });
      }
    }
  }
  return { toolUses, toolResults };
}

function streamMessage(res, message) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type, data) => res.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
  event("message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
  });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      event("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      event("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    event("content_block_stop", { type: "content_block_stop", index });
  });
  event("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  event("message_stop", { type: "message_stop" });
  res.end();
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "HEAD" || pathname === "/api/hello") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : "{}");
        return;
      }
      if (pathname.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (pathname !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "journey" } }));
        return;
      }
      const parsed = JSON.parse(body || "{}");
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const summary = summarize(messages);
      fs.appendFileSync(
        trace,
        JSON.stringify({
          at: new Date().toISOString(),
          toolUses: summary.toolUses,
          toolResults: summary.toolResults,
        }) + "\n",
      );
      const model = parsed.model || "journey-model";
      const id = "msg_" + Math.random().toString(36).slice(2, 10);
      let message;
      if (summary.toolResults.length > 0 || toolTurns >= 1) {
        message = { id, type: "message", role: "assistant", model, content: [{ type: "text", text: "JOURNEY-DONE" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      } else {
        toolTurns += 1;
        message = {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [
            {
              type: "tool_use",
              id: "toolu_" + Math.random().toString(36).slice(2, 10),
              name: "Bash",
              input: { command: toolCommand, description: "journey" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      if (parsed.stream) streamMessage(res, message);
      else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
      }
    });
  })
  .listen(port, "127.0.0.1");
MOCK_EOF
fi

cat > "$ASSERT" <<'ASSERT_EOF'
// Assert one journey scenario from its real artifacts and print its evidence.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
const label = process.argv[3];
const work = process.argv[4];
const affected = process.argv[5];
const neighbour = process.argv[6];
const probeCommand = process.argv[7];
const harness = process.argv[8] ?? "claude";

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (name) => {
  const target = work + "/" + name;
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
};
const readJson = (name) => {
  try {
    return JSON.parse(read(name) || "null");
  } catch {
    return null;
  }
};
const real = (target) => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
};
const keyOf = (target) => createHash("sha256").update(real(target)).digest("hex");

const gated = mode === "neighbour" ? neighbour : affected;
// Both harnesses are normalized into the same transcript shape by the runner,
// so every shared assertion below means the same thing in either one.
const transcript = readJson((harness === "codex" ? "codex-" : "claude-") + label + ".json") ?? {};
const hookLines = read("hook-gate-" + label + ".log").trim().split("\n").filter(Boolean);
const hookFields = (hookLines.at(-1) ?? "").split("\t");
const hookOutput = hookFields[2] ? JSON.parse(hookFields[2]) : {};
const hookSpecific = hookOutput.hookSpecificOutput ?? {};
// Claude Code returns a decision with its reason; Codex accepts only a deny
// decision, so an allowed call travels as additionalContext instead. Reading
// both keeps one assertion set for the guidance text either way.
const reason = hookSpecific.permissionDecisionReason ?? hookSpecific.additionalContext ?? "";
const allows = () => {
  if (harness === "codex") {
    check(
      hookSpecific.permissionDecision === undefined,
      "the Codex allow carried permissionDecision " + hookSpecific.permissionDecision,
    );
    check(typeof hookSpecific.additionalContext === "string", "the Codex allow carried no additionalContext");
    return;
  }
  check(hookSpecific.permissionDecision === "allow", "the gate decided " + hookSpecific.permissionDecision + ": " + reason);
};
// The shell tool is named for the model's own function surface in each harness.
const shellTool = harness === "codex" ? "exec_command" : "Bash";
const payload = readJson("hook-payload-" + label + ".json") ?? {};
const requests = read("api-requests-" + label + ".jsonl")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const ledger = readJson("ledger-" + label + ".json") ?? {};
const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
const entry = entries.find((candidate) => candidate.toolUseId === payload.tool_use_id);
const gateProbe = readJson("neighbour-probe.json") ?? {};
const affectedBefore = readJson("affected-before-" + label + ".json") ?? {};
const affectedAfter = readJson("affected-after-" + label + ".json") ?? {};
const neighbourBefore = readJson("neighbour-before-" + label + ".json") ?? {};
const neighbourAfter = readJson("neighbour-after-" + label + ".json") ?? {};
const dirtyAffected = read("affected-dirty-" + label + ".txt").trim();
const dirtyNeighbour = read("neighbour-dirty-" + label + ".txt").trim();
const marker = read("probe-" + label + ".marker");
const executed = marker.includes("GATE-OK");
const denials = Array.isArray(transcript.permission_denials) ? transcript.permission_denials : [];
const toolUses = requests.flatMap((request) => request.toolUses ?? []);
const toolResults = requests.flatMap((request) => request.toolResults ?? []);
const callIds = [...new Set(toolUses.map((call) => call.id))];
const resultFor = (id) => toolResults.find((result) => result.toolUseId === id);

// The harness must have run to completion under the enforcing hook.
check(transcript.is_error !== true && transcript.subtype === "success", "the harness run reported an error");
check(transcript.terminal_reason === "completed", "the harness run did not finish: " + transcript.terminal_reason);
check(payload.tool_name === "Bash", "the hook payload carried tool " + payload.tool_name);
check(typeof payload.tool_use_id === "string" && payload.tool_use_id.length > 0, "the hook payload carried no tool_use_id");
check(real(payload.cwd ?? "") === real(gated), "the harness reported " + payload.cwd + ", expected the gated checkout " + gated);
check(hookLines.length === 1, "expected exactly one gated tool call, saw " + hookLines.length);
// A harness that rejects the hook envelope still runs the tool, which would make
// the decision advisory. The Codex client reports that case explicitly, so it is
// asserted here and again per scenario instead of being assumed away.
const hookOutcomes = transcript.hook_outcomes ?? {};
if (harness === "codex") {
  check(hookOutcomes.failed === 0, "the harness rejected the gate's hook output");
}

// Zero infrastructure repair: one model call, and it is the synthetic probe.
check(callIds.length === 1, "expected one tool call from the model, saw " + callIds.length);
check(toolUses.every((call) => call.name === shellTool), "the model used a tool other than " + shellTool);
check(toolUses.every((call) => call.command === probeCommand), "the model issued an unexpected command: " + toolUses.map((call) => call.command).join(", "));
check(dirtyAffected === "", "the affected checkout was modified: " + dirtyAffected);
check(dirtyNeighbour === "", "the neighbour checkout was modified: " + dirtyNeighbour);

// The protected neighbour keeps its lifecycle record and its phase.
check(typeof neighbourBefore.sha256 === "string" && neighbourBefore.sha256.length === 64, "the neighbour lifecycle record was missing");
check(neighbourBefore.sha256 === neighbourAfter.sha256, "the neighbour lifecycle record changed");
check(neighbourAfter.phase === "stable", "the neighbour phase is " + neighbourAfter.phase);
// The neighbour scenario writes no ledger, so both sides stay caller paths and
// only their physical spelling is comparable. Without that normalization a
// leading-separator difference in $TMPDIR reads as a wrong ledger key.
const canonical = (target) => path.resolve(target ? real(target) : "");
const expectedLedger = process.env.DR_JOURNEY_HOME + "/.config/devrouter/harness/" + keyOf(gated) + ".json";
check(
  canonical(ledger.path) === canonical(expectedLedger),
  "the gate keyed " + ledger.path + " instead of the gated checkout's " + expectedLedger,
);

if (mode === "deferral") {
  const waited = Number((reason.match(/settled after ([0-9.]+)s/) ?? [])[1] ?? 0);
  allows();
  check(/settled after [0-9.]+s; the tool may run now/.test(reason), "the deferral was not reported: " + reason);
  check(waited >= 1, "the enforced wait was too short to prove a deferral: " + waited + "s");
  check(entry?.state === "granted", "the continuation ledger recorded " + entry?.state);
  check(entry?.phase === "stopping", "the gate observed " + entry?.phase);
  check(Number(entry?.waitedMs) >= 1000, "the recorded wait was " + entry?.waitedMs + "ms");
  check(entry?.budgetMs === 30000, "the recorded budget was " + entry?.budgetMs + "ms");
  check(denials.length === 0, "the harness recorded a permission denial: " + JSON.stringify(denials));
  check(executed, "the deferred tool call never ran");
  check(resultFor(callIds[0])?.hasError !== true, "the deferred tool call returned an error");
  check(affectedAfter.phase === "stable", "the affected phase is " + affectedAfter.phase);
  check(Number(transcript.duration_ms) >= waited * 1000, "the run (" + transcript.duration_ms + "ms) was shorter than the enforced wait");
  check(Number(transcript.duration_api_ms) < 2000, "the wait consumed model time: " + transcript.duration_api_ms + "ms of API time");
  if (harness === "codex") {
    check(hookOutcomes.completed === 1, "the harness recorded " + hookOutcomes.completed + " completed hook decisions");
    check(Number(transcript.num_turns) === 2, "the wait consumed " + transcript.num_turns + " model requests");
  }
} else if (mode === "refusal") {
  check(hookSpecific.permissionDecision === "deny", "the gate decided " + hookSpecific.permissionDecision + ": " + reason);
  check(/still starting after waiting [0-9.]+s/.test(reason), "the refusal did not name the phase: " + reason);
  check(/devrouter status/.test(reason), "the refusal did not name the recovery: " + reason);
  check(entry?.state === "refused", "the continuation ledger recorded " + entry?.state);
  check(entry?.phase === "starting", "the gate observed " + entry?.phase);
  check(entry?.budgetMs === 3000, "the recorded budget was " + entry?.budgetMs + "ms");
  check(Number(entry?.waitedMs) > 0, "the recorded wait was " + entry?.waitedMs + "ms");
  check(
    Number(transcript.duration_ms) >= Number(entry?.waitedMs ?? 0),
    "the run (" + transcript.duration_ms + "ms) was shorter than the enforced wait (" + entry?.waitedMs + "ms)",
  );
  check(denials.length === 1, "expected exactly one harness denial, saw " + denials.length);
  check(denials[0]?.tool_input?.command === probeCommand, "the denied call was " + JSON.stringify(denials[0]?.tool_input));
  check(!executed, "the refused tool call ran anyway");
  check(resultFor(callIds[0])?.hasError === true, "the refusal was not delivered as an errored tool result");
  check(/still starting/.test(resultFor(callIds[0])?.text ?? ""), "the refusal reason did not reach the model");
  check(affectedAfter.phase === "starting", "the affected phase is " + affectedAfter.phase);
  if (harness === "codex") {
    check(hookOutcomes.blocked === 1, "the harness recorded " + hookOutcomes.blocked + " blocked hook decisions");
    check(hookOutcomes.completed === 0, "a refused call also reported a completed hook decision");
  }
} else if (mode === "neighbour") {
  allows();
  check(reason === "devrouter: environment settled.", "the neighbour call was not allowed immediately: " + reason);
  check(entries.length === 0, "the neighbour call was gated: " + JSON.stringify(entries));
  check(denials.length === 0, "the harness recorded a permission denial: " + JSON.stringify(denials));
  check(executed, "the neighbour tool call never ran");
  check(resultFor(callIds[0])?.hasError !== true, "the neighbour tool call returned an error");
  check(affectedAfter.phase === "starting", "the transitional checkout settled: " + affectedAfter.phase);
  check(affectedAfter.sha256 === affectedBefore.sha256, "the transitional checkout changed while the neighbour ran");
  check(affectedAfter.revision === affectedBefore.revision, "the transitional checkout advanced while the neighbour ran");
  check(real(gateProbe.checkout ?? "") === real(neighbour), "the direct probe reported " + gateProbe.checkout + ", expected the neighbour checkout");
  check(gateProbe.reason === "settled", "the direct probe reason was " + gateProbe.reason);
  check(gateProbe.observedPhase === "stable", "the direct probe observed " + gateProbe.observedPhase);
  check(Number(gateProbe.waitedMs) < 1000, "the direct probe waited " + gateProbe.waitedMs + "ms");
  if (harness === "codex") {
    check(hookOutcomes.completed === 1, "the harness recorded " + hookOutcomes.completed + " completed hook decisions");
  }
} else {
  failures.push("unknown scenario: " + mode);
}

console.log(
  JSON.stringify({
    scenario: mode,
    label,
    harness,
    gated,
    permissionDecision: hookSpecific.permissionDecision,
    hookEnvelope: {
      permissionDecision: hookSpecific.permissionDecision ?? null,
      additionalContext: hookSpecific.additionalContext ?? null,
    },
    reason,
    payloadCwd: payload.cwd,
    toolUseId: payload.tool_use_id,
    continuation: entry
      ? { state: entry.state, phase: entry.phase, budgetMs: entry.budgetMs, waitedMs: entry.waitedMs }
      : null,
    harness: {
      name: harness,
      numTurns: transcript.num_turns,
      durationMs: transcript.duration_ms,
      durationApiMs: transcript.duration_api_ms,
      denials: denials.map((denial) => denial.tool_input?.command ?? denial.tool_name),
      hookOutcomes,
    },
    calls: toolUses.map((call) => ({ id: call.id, command: call.command })),
    toolExecuted: executed,
    affectedPhase: affectedAfter.phase,
    neighbourPhase: neighbourAfter.phase,
    neighbourRecordStable: neighbourBefore.sha256 === neighbourAfter.sha256,
    observedGate:
      mode === "neighbour"
        ? {
            reason: gateProbe.reason,
            observedPhase: gateProbe.observedPhase,
            waitedMs: gateProbe.waitedMs,
            checkout: gateProbe.checkout,
          }
        : null,
    checkoutsClean: dirtyAffected === "" && dirtyNeighbour === "",
    failures,
  }),
);
if (failures.length) process.exit(1);
ASSERT_EOF

journal() { HOME="$HOME_DIR" DR_JOURNEY_SRC="$ROOT/src/core" "$TSX" "$JOURNAL" "$@"; }
cat > "$CODEX_SUMMARY" <<'CODEX_SUMMARY_EOF'
// Normalize one Codex CLI run into the transcript shape the journey assertions
// read, so both harnesses answer the same questions.
//
// The Codex CLI prints no JSON transcript of its own, so each field maps to a
// real artifact: the exit status of the harness process, the wall clock measured
// around it, the model requests the mock served (its own service time), and the
// blocked-hook lines from the harness log. Nothing is inferred from the product's
// own output, and the gate's ledger and journal evidence stay the primary proof.
import fs from "node:fs";

const work = process.argv[2];
const label = process.argv[3];
const read = (name) => {
  const target = work + "/" + name;
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
};

const exitCode = Number(process.env.DR_CODEX_EXIT ?? "1");
const startedMs = Number(process.env.DR_CODEX_STARTED_MS ?? "0");
const endedMs = Number(process.env.DR_CODEX_ENDED_MS ?? "0");
const harnessLog = read("codex-" + label + ".err");
const requests = read("api-requests-" + label + ".jsonl")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const blockedPrefix = "Command blocked by PreToolUse hook: ";
const commandMarker = ". Command: ";
const permission_denials = [];
for (const line of harnessLog.split("\n")) {
  const at = line.indexOf(blockedPrefix);
  if (at < 0) continue;
  const rest = line.slice(at + blockedPrefix.length);
  const cut = rest.lastIndexOf(commandMarker);
  if (cut < 0) continue;
  permission_denials.push({
    tool_name: "Bash",
    tool_input: { command: rest.slice(cut + commandMarker.length).trim() },
    reason: rest.slice(0, cut),
  });
}

const answered = requests.some((request) => request.kind === "message");
console.log(
  JSON.stringify({
    harness: "codex",
    exitCode,
    is_error: exitCode !== 0,
    subtype: exitCode === 0 ? "success" : "error:exit-" + exitCode,
    terminal_reason: exitCode === 0 && answered ? "completed" : "incomplete",
    duration_ms: endedMs - startedMs,
    duration_api_ms: requests.reduce((total, request) => total + Number(request.tookMs ?? 0), 0),
    num_turns: requests.length,
    permission_denials,
    hook_outcomes: {
      // The harness reports how it resolved the gate's output. "Failed" is the
      // outcome this adapter exists to avoid: the client ran the tool but
      // rejected the hook envelope, which would make the decision advisory.
      completed: harnessLog.split("\n").filter((line) => line.includes("hook: PreToolUse Completed")).length,
      blocked: harnessLog.split("\n").filter((line) => line.includes("hook: PreToolUse Blocked")).length,
      failed: harnessLog.split("\n").filter((line) => line.includes("hook: PreToolUse Failed")).length,
    },
    harness_failures: harnessLog
      .split("\n")
      .filter((line) => line.includes("hook: PreToolUse Failed")),
  }),
);
CODEX_SUMMARY_EOF


run_scenario() {
  local mode="$1" budget="$2"
  local label="$mode"
  local probe="$WORK/probe-$label.marker"
  local probe_command="echo GATE-OK >> $probe"
  local trace="$WORK/api-requests-$label.jsonl"
  local gated="$AFFECTED"

  rm -f "$probe" "$WORK/hook-gate-$label.log" "$WORK/hook-gate-$label.log.err" "$WORK/hook-payload-$label.json"

  journal "$NEIGHBOUR" set stable >/dev/null
  if [ "$mode" = "neighbour" ]; then
    gated="$NEIGHBOUR"
    journal "$AFFECTED" set starting >/dev/null
  elif [ "$mode" = "refusal" ]; then
    journal "$AFFECTED" set starting >/dev/null
  else
    journal "$AFFECTED" set stopping >/dev/null
  fi
  journal "$AFFECTED" show > "$WORK/affected-before-$label.json"
  journal "$NEIGHBOUR" show > "$WORK/neighbour-before-$label.json"

  start_mock "$probe_command" "$trace"

  local settle_pid=""
  if [ "$mode" = "deferral" ]; then
    # The gate announces its wait on stderr; settle the checkout three seconds
    # after that announcement, so the hook always observes a real transition.
    (
      for _ in $(seq 1 240); do
        [ -s "$WORK/hook-gate-$label.log.err" ] && break
        sleep 0.25
      done
      sleep 3
      journal "$AFFECTED" set stable >/dev/null
    ) &
    settle_pid=$!
  fi

  # A harness failure must not end the run under set -e: the work directory is
  # kept on failure on purpose, and the assertions print what actually happened.
  if [ "$HARNESS" = "codex" ]; then
    local started_ms ended_ms exit_code
    started_ms="$("$NODE" -e 'process.stdout.write(String(Date.now()))')"
    set +e
    (
      cd "$gated" &&
        HOME="$HOME_DIR" CODEX_HOME="$HOME_DIR" JOURNEY_API_KEY=journey \
        DR_GATE_BUDGET="$budget" DR_JOURNEY_NODE="$NODE" DR_JOURNEY_DIST="$DIST" \
        DR_JOURNEY_HOOK_LOG="$WORK/hook-gate-$label.log" DR_JOURNEY_HOOK_PAYLOAD="$WORK/hook-payload-$label.json" \
        "$CODEX" exec --skip-git-repo-check --sandbox workspace-write -C "$gated" \
          --dangerously-bypass-hook-trust \
          "Run exactly this command with the shell tool, then stop: $probe_command" \
          < /dev/null > "$WORK/codex-$label.out" 2> "$WORK/codex-$label.err"
    )
    exit_code=$?
    set -e
    ended_ms="$("$NODE" -e 'process.stdout.write(String(Date.now()))')"
    if [ "$exit_code" != "0" ]; then
      echo "the harness run for '$label' exited $exit_code; see $WORK/codex-$label.err" >&2
      FAILED=1
    fi
    DR_CODEX_EXIT="$exit_code" DR_CODEX_STARTED_MS="$started_ms" DR_CODEX_ENDED_MS="$ended_ms" \
      "$NODE" "$CODEX_SUMMARY" "$WORK" "$label" > "$WORK/codex-$label.json"
  else
    if ! (
      cd "$gated" &&
        HOME="$HOME_DIR" DR_GATE_BUDGET="$budget" DR_JOURNEY_NODE="$NODE" DR_JOURNEY_DIST="$DIST" \
        DR_JOURNEY_HOOK_LOG="$WORK/hook-gate-$label.log" DR_JOURNEY_HOOK_PAYLOAD="$WORK/hook-payload-$label.json" \
        ANTHROPIC_API_KEY=journey ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
        "$CLAUDE" -p "Run exactly this command with the Bash tool, then stop: $probe_command" \
          --output-format json --max-turns 3 --allowedTools "Bash(echo:*)" \
          --settings "$SETTINGS" > "$WORK/claude-$label.json" 2> "$WORK/claude-$label.err"
    ); then
      echo "the harness run for '$label' failed; see $WORK/claude-$label.err" >&2
      FAILED=1
    fi
  fi
  if [ -n "$settle_pid" ]; then wait "$settle_pid" || true; fi

  journal "$AFFECTED" show > "$WORK/affected-after-$label.json"
  journal "$NEIGHBOUR" show > "$WORK/neighbour-after-$label.json"
  journal "$gated" ledger > "$WORK/ledger-$label.json"
  git -C "$AFFECTED" status --porcelain > "$WORK/affected-dirty-$label.txt"
  git -C "$NEIGHBOUR" status --porcelain > "$WORK/neighbour-dirty-$label.txt"

  if [ "$mode" = "neighbour" ]; then
    # The hook output hides the observed phase, so a fail-open decision also
    # reads as "environment settled.". Ask the gate directly, with no tool id,
    # for the same checkout and record its own phase evidence.
    DR_PROBE_CWD="$NEIGHBOUR" "$NODE" -e 'process.stdout.write(JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"echo GATE-PROBE"},cwd:process.env.DR_PROBE_CWD}))' > "$WORK/neighbour-probe-payload.json"
    HOME="$HOME_DIR" "$NODE" "$DIST" harness gate --json --wait-budget-ms 1000 \
      < "$WORK/neighbour-probe-payload.json" > "$WORK/neighbour-probe.json" 2> "$WORK/neighbour-probe.err" || FAILED=1
  fi

  DR_JOURNEY_HOME="$HOME_DIR" "$NODE" "$ASSERT" "$mode" "$label" "$WORK" "$AFFECTED" \
    "$NEIGHBOUR" "$probe_command" "$HARNESS" > "$WORK/assert-$mode.json" || FAILED=1
  cat "$WORK/assert-$mode.json"
}

echo "--- harness: $HARNESS"
echo "--- scenario 1: a transitioning checkout defers the tool call until it settles"
run_scenario deferral 30000
echo "--- scenario 2: a transition that outlasts the budget is refused once, with recovery guidance"
run_scenario refusal 3000
echo "--- scenario 3: the neighbour checkout stays usable during that transition"
run_scenario neighbour 5000
echo "--- hook decisions"
for log in "$WORK"/hook-gate-*.log; do echo "# $(basename "$log")"; cat "$log"; done
echo "--- raw logs: $WORK"
if [ "$FAILED" = "0" ]; then write_evidence pass ""; else write_evidence fail ""; fi
exit "$FAILED"

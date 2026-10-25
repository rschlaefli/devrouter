import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "yaml";

const workflow = parse(fs.readFileSync(".github/workflows/preview.yml", "utf8"));
assert.ok(workflow.on.workflow_call);
const steps = workflow.jobs.reconcile.steps;
for (const step of steps) if (step.uses) assert.match(step.uses, /^[A-Za-z0-9_/-]+@[a-f0-9]{40}$/);
const build = steps.findIndex((step: { id?: string }) => step.id === "controller-build");
const injected = steps.findIndex(
  (step: { env?: Record<string, string> }) => step.env?.DEVROUTER_PREVIEW_CREDENTIALS,
);
assert.ok(build >= 0 && injected > build);
assert.equal(workflow.permissions["id-token"], "write");
assert.ok(!workflow.on.issue_comment && !workflow.on.pull_request);
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 1, transport: "source-only", workflowPins: true, credentialsAfterBuild: true, liveQualified: false })}\n`,
);

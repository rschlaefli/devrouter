import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreviewInitCommand, runPreviewPlanCommand } from "../preview";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function repository(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-command-"));
  directories.push(dir);
  fs.writeFileSync(path.join(dir, ".devrouter.yml"), "version: 1\napps: []\n");
  return dir;
}

function capture() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

describe("offline preview commands", () => {
  it("prints a scaffold without writes and refuses replacing an existing manifest", async () => {
    const repo = repository();
    const output = capture();
    await runPreviewInitCommand({ repo, json: true });
    const scaffold = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(scaffold.written).toBe(false);
    expect(fs.existsSync(path.join(repo, ".devrouter.preview.yml"))).toBe(false);
    await runPreviewInitCommand({ repo, write: true });
    const bytes = fs.readFileSync(path.join(repo, ".devrouter.preview.yml"), "utf8");
    await expect(runPreviewInitCommand({ repo, write: true })).rejects.toThrow();
    expect(fs.readFileSync(path.join(repo, ".devrouter.preview.yml"), "utf8")).toBe(bytes);
  });

  it("plans a cloud-only repository and lists its aliases without a runtime", async () => {
    const repo = repository();
    const output = capture();
    await runPreviewInitCommand({ repo, write: true });
    output.mockClear();
    await runPreviewPlanCommand({ repo, alias: "web", json: true });
    const report = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(report.status).toBe("planned");
    expect(report.aliases).toEqual(["web"]);
    expect(report.resources.map((resource: { id: string }) => resource.id)).toEqual(["web"]);
    expect(report.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    output.mockClear();
    await runPreviewPlanCommand({ repo, list: true, json: true });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: 1,
      aliases: ["web"],
    });
    await expect(runPreviewPlanCommand({ repo, list: true, alias: "web" })).rejects.toThrow();
  });

  it("renders pinned callers and refuses replacement or mutable source refs", async () => {
    const repo = repository(),
      output = capture();
    const options = {
      repo,
      integration: "github",
      controllerRef: "a".repeat(40),
      policyRef: "b".repeat(40),
      policyRepository: "example/policy",
      project: "app",
      json: true,
    };
    await runPreviewInitCommand(options);
    const rendered = JSON.parse(String(output.mock.calls[0]?.[0]));
    const { parse } = await import("yaml");
    const workflow = parse(rendered.content);
    expect(workflow.jobs.preview.uses).toBe(
      `rschlaefli/devrouter/.github/workflows/preview.yml@${options.controllerRef}`,
    );
    expect(workflow.jobs.preview.with["policy-ref"]).toBe(options.policyRef);
    expect(workflow.jobs.preview.secrets).not.toBe("inherit");
    expect(fs.existsSync(path.join(repo, rendered.path))).toBe(false);
    await runPreviewInitCommand({ ...options, write: true });
    await expect(runPreviewInitCommand({ ...options, write: true })).rejects.toThrow();
    await expect(runPreviewInitCommand({ ...options, controllerRef: "main" })).rejects.toThrow();
    output.mockClear();
    await runPreviewInitCommand({ ...options, sweeper: true });
    const sweep = parse(JSON.parse(String(output.mock.calls[0]?.[0])).content);
    expect(sweep.on.schedule).toEqual([{ cron: "*/5 * * * *" }]);
    expect(sweep.jobs.sweep.with.mode).toBe("sweep");
  });
  it("renders a GitLab integrity-pinned include with a reviewed controller image", async () => {
    const repo = repository(),
      output = capture();
    const options = {
      repo,
      integration: "gitlab",
      controllerRef: "a".repeat(40),
      controllerImage: `registry.example.org/controller@sha256:${"b".repeat(64)}`,
      json: true,
    };
    await runPreviewInitCommand(options);
    const rendered = JSON.parse(String(output.mock.calls[0]?.[0]));
    const { parseAllDocuments } = await import("yaml");
    const caller = parseAllDocuments(rendered.content)[1].toJS();
    expect(caller.include[0].integrity).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    expect(caller.include[0].inputs.controller_image).toBe(options.controllerImage);
    expect(new URL(caller.include[0].remote).pathname.split("/")[3]).toBe(options.controllerRef);
    await expect(
      runPreviewInitCommand({ ...options, controllerImage: "controller:latest" }),
    ).rejects.toThrow();
  });
  it("rejects source files outside the repository and symlinks", async () => {
    const repo = repository();
    capture();
    await runPreviewInitCommand({ repo, write: true });
    await expect(runPreviewPlanCommand({ repo, source: "../outside.json" })).rejects.toThrow();
    fs.symlinkSync(path.join(repo, ".devrouter.yml"), path.join(repo, "source.json"));
    await expect(runPreviewPlanCommand({ repo, source: "source.json" })).rejects.toThrow();
  });
});

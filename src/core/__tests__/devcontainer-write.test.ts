import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planDevcontainerWrite, writeDevcontainer } from "../devcontainer-write";

let tmpDir: string;

function write(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-devcontainer-write-test-"));
  write(
    "package.json",
    JSON.stringify({
      packageManager: "pnpm@11.6.0",
      engines: { node: ">=24" },
      scripts: { dev: "next dev --port 3100" },
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("devcontainer write planning", () => {
  it("plans missing files without writing them during dry-run", () => {
    const plan = planDevcontainerWrite({ repo: tmpDir, dryRun: true });

    expect(plan.dryRun).toBe(true);
    expect(plan.profile).toBe("node-postgres");
    expect(
      plan.files.filter((file) => file.action === "create").map((file) => file.path),
    ).toContain(".devcontainer/docker-compose.yml");
    expect(
      plan.files.filter((file) => file.action === "create").map((file) => file.path),
    ).toContain(".devrouter.yml");
    expect(fs.existsSync(path.join(tmpDir, ".devcontainer", "docker-compose.yml"))).toBe(false);
  });

  it("requires --yes before writing files", () => {
    const plan = writeDevcontainer({ repo: tmpDir });

    expect(plan.issues.map((issue) => issue.id)).toContain("repo.devcontainer.confirmation");
    expect(fs.existsSync(path.join(tmpDir, ".devcontainer", "docker-compose.yml"))).toBe(false);
  });

  it("writes managed files and is idempotent", () => {
    const written = writeDevcontainer({ repo: tmpDir, yes: true, installedVersion: "1.2.3" });

    expect(written.issues).toEqual([]);
    expect(
      fs.readFileSync(path.join(tmpDir, ".devcontainer", "docker-compose.yml"), "utf-8"),
    ).toContain("devrouter:managed devcontainer");
    expect(
      fs.readFileSync(path.join(tmpDir, ".devcontainer", "docker-compose.yml"), "utf-8"),
    ).toContain("10-create-shadow-db.sh");
    expect(fs.readFileSync(path.join(tmpDir, ".devcontainer", "Dockerfile"), "utf-8")).toContain(
      "npm install -g 'pnpm@11.6.0'",
    );
    expect(fs.readFileSync(path.join(tmpDir, ".devcontainer", "init-db.sh"), "utf-8")).toContain(
      "CREATE DATABASE shadow",
    );
    expect(
      fs.readFileSync(path.join(tmpDir, ".devcontainer", "devcontainer.env"), "utf-8"),
    ).toContain("PORT=3100");
    expect(fs.readFileSync(path.join(tmpDir, ".devrouter.yml"), "utf-8")).toContain(
      "upstream: ${WORKSPACE}-app:3100",
    );
    expect(fs.readFileSync(path.join(tmpDir, ".devrouter.yml"), "utf-8")).toContain(
      "version: 1.2.3",
    );
    expect(fs.statSync(path.join(tmpDir, ".devcontainer", "init-db.sh")).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(tmpDir, ".devcontainer", "post-start.sh")).mode & 0o111).not.toBe(
      0,
    );

    const second = planDevcontainerWrite({ repo: tmpDir, dryRun: true, installedVersion: "1.2.3" });
    expect(
      second.files
        .filter((file) => file.path !== "AGENTS.md")
        .every((file) => file.action === "skip"),
    ).toBe(true);
  });

  it("stops on custom existing files", () => {
    write(".devrouter.yml", "version: 1\napps: []\n");

    const plan = writeDevcontainer({ repo: tmpDir, yes: true });

    expect(plan.issues.map((issue) => issue.id)).toContain("repo.devcontainer.write-conflict");
    expect(plan.files.find((file) => file.path === ".devrouter.yml")?.action).toBe("conflict");
    expect(fs.existsSync(path.join(tmpDir, ".devcontainer", "Dockerfile"))).toBe(false);
  });

  it("stops on non-pnpm package managers", () => {
    write(
      "package.json",
      JSON.stringify({
        packageManager: "npm@10.9.0",
        engines: { node: ">=24" },
        scripts: { dev: "next dev --port 3100" },
      }),
    );

    const plan = writeDevcontainer({ repo: tmpDir, yes: true });

    expect(plan.issues.map((issue) => issue.id)).toContain(
      "repo.devcontainer.package-manager-unsupported",
    );
    expect(fs.existsSync(path.join(tmpDir, ".devcontainer", "Dockerfile"))).toBe(false);
  });

  it("stops on unsafe pnpm packageManager versions", () => {
    write(
      "package.json",
      JSON.stringify({
        packageManager: "pnpm@11.6.0 && touch /tmp/pwned",
        engines: { node: ">=24" },
        scripts: { dev: "next dev --port 3100" },
      }),
    );

    const plan = writeDevcontainer({ repo: tmpDir, yes: true });

    expect(plan.issues.map((issue) => issue.id)).toContain(
      "repo.devcontainer.package-manager-version-unsupported",
    );
    expect(plan.nextSteps.join("\n")).toContain("Use a pinned semver packageManager value");
    expect(plan.nextSteps.join("\n")).not.toContain("Resolve write conflicts");
    expect(fs.existsSync(path.join(tmpDir, ".devcontainer", "Dockerfile"))).toBe(false);
  });

  it("quotes inferred script names in generated post-start command", () => {
    write(
      "package.json",
      JSON.stringify({
        packageManager: "pnpm@11.6.0",
        engines: { node: ">=24" },
        scripts: { "web;touch pwned:dev": "next dev --port 3100" },
      }),
    );

    const written = writeDevcontainer({ repo: tmpDir, yes: true });
    const postStart = fs.readFileSync(path.join(tmpDir, ".devcontainer", "post-start.sh"), "utf-8");

    expect(written.issues).toEqual([]);
    expect(postStart).toContain("pnpm run -- '\"'\"'web;touch pwned:dev'\"'\"'");
    expect(postStart).not.toContain("pnpm run -- web;touch pwned:dev");
  });
});

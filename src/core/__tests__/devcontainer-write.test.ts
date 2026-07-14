import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planDevcontainerWrite, writeDevcontainer } from "../devcontainer-write";

let tmpDir: string;
let linkedDir: string | undefined;

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
  if (linkedDir) {
    fs.rmSync(linkedDir, { recursive: true, force: true });
    linkedDir = undefined;
  }
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
    ).toContain(".devcontainer/docker-compose.devrouter.yml");
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
    const devrouterOverlay = fs.readFileSync(
      path.join(tmpDir, ".devcontainer", "docker-compose.devrouter.yml"),
      "utf-8",
    );
    expect(devrouterOverlay).toContain("DEVROUTER_GIT_COMMON_DIR");
    expect(devrouterOverlay).toContain("DEVROUTER_WORKSPACE");
    expect(
      fs.readFileSync(path.join(tmpDir, ".devcontainer", "devcontainer.json"), "utf-8"),
    ).toContain("DEVCONTAINER_COMPOSE_OVERLAY");
    expect(fs.readFileSync(path.join(tmpDir, ".devcontainer", "Dockerfile"), "utf-8")).toContain(
      "npm install -g 'pnpm@11.6.0'",
    );
    const dockerfile = fs.readFileSync(path.join(tmpDir, ".devcontainer", "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("npm pack --silent '@devrouter/cli@1.2.3'");
    expect(dockerfile).toContain("devrouter-cli-1.2.3.tgz");
    expect(dockerfile).not.toContain("npm install -g '@devrouter/cli@1.2.3'");
    const postStart = fs.readFileSync(path.join(tmpDir, ".devcontainer", "post-start.sh"), "utf-8");
    expect(postStart).toContain("devrouter-process ensure");
    expect(postStart).not.toContain("pgrep");
    expect(postStart).not.toContain("setsid");
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

  it("recommends workspace ensure after writing in a linked worktree", () => {
    execFileSync("git", ["init", "-b", "main"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "devrouter-test@example.invalid"], {
      cwd: tmpDir,
    });
    execFileSync("git", ["config", "user.name", "Devrouter Test"], { cwd: tmpDir });
    execFileSync("git", ["add", "package.json"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "test fixture"], { cwd: tmpDir });
    linkedDir = `${tmpDir}-linked`;
    execFileSync("git", ["worktree", "add", "-b", "feature/test", linkedDir], { cwd: tmpDir });

    const written = writeDevcontainer({ repo: linkedDir, yes: true });

    expect(written.nextSteps.join("\n")).toContain("devrouter workspace ensure");
    expect(written.nextSteps.join("\n")).not.toContain("devpod up");
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
    expect(postStart).toContain("--match 'pnpm(\\.cjs)? .*web;touch pwned:dev'");
    expect(postStart).toContain("pnpm run -- '\"'\"'web;touch pwned:dev'\"'\"'");
    expect(postStart).not.toContain("pnpm run -- web;touch pwned:dev");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLinkedWorktree, resolveWorkspace, wsFromBranch } from "../workspace";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-ws-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DEVROUTER_WORKSPACE;
});

describe("wsFromBranch", () => {
  it("passes a simple branch through", () => {
    expect(wsFromBranch("main")).toBe("main");
  });

  it("lowercases and replaces slashes / non-alnum with hyphens", () => {
    expect(wsFromBranch("feature/JIRA-123_x")).toBe("feature-jira-123-x");
  });

  it("trims leading and trailing hyphens", () => {
    expect(wsFromBranch("--feat--")).toBe("feat");
  });

  it("caps length at 32 and re-trims a trailing hyphen", () => {
    // 30 'a' + '-' + 'b' -> after slice(0,32) the 32nd char is '-', which is trimmed.
    const branch = `${"a".repeat(30)}-bbbb`;
    const result = wsFromBranch(branch);
    expect(result).toBe("a".repeat(30) + "-b");
    expect(result!.length).toBeLessThanOrEqual(32);
    expect(result!.endsWith("-")).toBe(false);
  });

  it("returns undefined when nothing usable remains", () => {
    expect(wsFromBranch("---")).toBeUndefined();
    expect(wsFromBranch("")).toBeUndefined();
  });
});

describe("isLinkedWorktree", () => {
  it("is false for a primary checkout (.git directory)", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    expect(isLinkedWorktree(tmpDir)).toBe(false);
  });

  it("is true for a linked worktree (.git file pointing into worktrees/)", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".git"),
      "gitdir: /repo/.git/worktrees/feat-x\n",
      "utf-8"
    );
    expect(isLinkedWorktree(tmpDir)).toBe(true);
  });

  it("is false for a submodule (.git file pointing into modules/)", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".git"),
      "gitdir: /super/.git/modules/sub\n",
      "utf-8"
    );
    expect(isLinkedWorktree(tmpDir)).toBe(false);
  });

  it("is false when there is no .git entry", () => {
    expect(isLinkedWorktree(tmpDir)).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  it("returns undefined for a primary checkout with no override/env", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    expect(resolveWorkspace(tmpDir)).toBeUndefined();
  });

  it("uses an explicit override (sanitized) over everything else", () => {
    process.env.DEVROUTER_WORKSPACE = "from-env";
    expect(resolveWorkspace(tmpDir, "Feature/Y")).toBe("feature-y");
  });

  it("treats an empty override as a forced 'no workspace'", () => {
    process.env.DEVROUTER_WORKSPACE = "from-env";
    expect(resolveWorkspace(tmpDir, "")).toBeUndefined();
  });

  it("falls back to DEVROUTER_WORKSPACE env (sanitized)", () => {
    process.env.DEVROUTER_WORKSPACE = "Hot/Fix";
    expect(resolveWorkspace(tmpDir)).toBe("hot-fix");
  });

  it("treats an empty env value as a forced 'no workspace'", () => {
    process.env.DEVROUTER_WORKSPACE = "";
    fs.writeFileSync(path.join(tmpDir, ".git"), "gitdir: /repo/.git/worktrees/x\n", "utf-8");
    expect(resolveWorkspace(tmpDir)).toBeUndefined();
  });
});

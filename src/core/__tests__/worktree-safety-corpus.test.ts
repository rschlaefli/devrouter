import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ForgeIdentity, listForgeChanges } from "../forge-changes";
import { comparableWorkspacePath } from "../workspace";
import { listGitWorktrees } from "../workspace-ownership";
import {
  classifyWorktreeSafety,
  readDisposableOverride,
  readLedgerWorktreePaths,
  type WorktreeRuntimeSources,
  worktreeRuntimeEvidence,
} from "../worktree-safety";

// Runs the shared worktree-safety corpus (tests/worktree-safety) through the
// TypeScript classifier. The skill's runner checks the same expected.tsv, so
// both classifiers must agree on every verdict and code.
const ROOT = path.resolve(__dirname, "../../..");
const CORPUS = path.join(ROOT, "tests", "worktree-safety");
const STUBS = path.join(CORPUS, "stubs");

const FORGES: Record<string, ForgeIdentity> = {
  github: { provider: "github", project: "example/repo" },
  gitlab: { provider: "gitlab", project: "group/repo" },
};

type Expectation = { scenario: string; verdict: string; codes: string };

function readExpectations(): Expectation[] {
  return fs
    .readFileSync(path.join(CORPUS, "expected.tsv"), "utf-8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [scenario, , verdict, codes] = line.split("\t");
      return { scenario, verdict, codes };
    });
}

function readJson<T>(file: string): T | undefined {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as T) : undefined;
}

function runtimeSources(dir: string, gitCommonDir: string): WorktreeRuntimeSources {
  type Listing = { id: string; source: { localFolder?: string } }[];
  const devpodDown = fs.existsSync(path.join(dir, "devpod-down"));
  return {
    ledgerPaths: readLedgerWorktreePaths(gitCommonDir),
    routes:
      readJson<{ repoPath: string }[]>(
        path.join(dir, "devrouter-home", "host-routes-state.json"),
      ) ?? [],
    devpod: devpodDown ? undefined : (readJson<Listing>(path.join(dir, "devpod.json")) ?? []),
    devsy: readJson<Listing>(path.join(dir, "devsy.json")) ?? [],
    unavailable: devpodDown ? ["DevPod"] : [],
  };
}

describe("worktree-safety corpus", () => {
  let testRoot: string;
  const expectations = readExpectations();

  beforeAll(() => {
    testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wt-corpus-")));
  });

  afterAll(() => {
    spawnSync("chmod", ["-R", "u+rwX", testRoot]);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it.each(expectations)("$scenario", ({ scenario, verdict, codes }) => {
    const dir = path.join(testRoot, scenario);
    fs.mkdirSync(dir, { recursive: true });
    const [target] = execFileSync("bash", [path.join(CORPUS, "build-scenario.sh"), scenario, dir], {
      encoding: "utf-8",
      env: { ...process.env, CORPUS_ORIGIN: "git@github.com:example/repo.git" },
    })
      .trim()
      .split("\t");
    const repo = path.join(dir, "repo");
    const gitCommonDir = path.join(repo, ".git");
    const registration = listGitWorktrees(repo).find(
      (worktree) => worktree.path === comparableWorkspacePath(target),
    );
    expect(registration).toBeDefined();
    const sources = runtimeSources(dir, gitCommonDir);

    for (const [forgeName, identity] of Object.entries(FORGES)) {
      const forge = listForgeChanges(identity, {
        sleep: () => {},
        runner: (command, args) => {
          const result = spawnSync(command, args, {
            encoding: "utf-8",
            env: { ...process.env, PATH: `${STUBS}:${process.env.PATH}`, CORPUS_DIR: dir },
          });
          return { status: result.status, stdout: result.stdout ?? "" };
        },
      });
      const result = classifyWorktreeSafety({
        worktreePath: target,
        branch: registration?.branch,
        primary: path.basename(target) === "repo",
        locked: registration?.locked ?? false,
        missing: registration?.prunable === true || !fs.existsSync(target),
        runtimeEvidence: worktreeRuntimeEvidence(target, sources),
        forge,
        extraDisposablePatterns: readDisposableOverride(gitCommonDir),
      });
      expect(
        `${forgeName} ${result.verdict}\t${result.codes.join(",") || "-"}`,
        result.reasons.join("; "),
      ).toBe(`${forgeName} ${verdict}\t${codes}`);
    }
  });
});

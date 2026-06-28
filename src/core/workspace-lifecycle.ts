import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runConfiguredApp } from "./app-run";
import { listHostRouteState, removeHostRouteById } from "./host-routes";
import { loadRuntimeConfig, resolveRepoPath } from "./repo-config";
import { isLinkedWorktree, wsFromBranch } from "./workspace";

// `dev workspace` ties a git worktree, an optional devpod/devcontainer, and the
// per-workspace routes together so an agent can spin up (and tear down) a fully
// isolated, routed copy of a repo in one command. devrouter stays a router: the
// devpod calls are best-effort glue, gated on devpod being installed.

export type WorkspaceRow = {
  workspace: string | undefined;
  branch: string | undefined;
  worktreePath: string;
  routeCount: number;
  hosts: string[];
};

function hasDevpod(): boolean {
  const result = spawnSync("devpod", ["version"], { encoding: "utf-8" });
  return result.status === 0;
}

type GitWorktree = { path: string; branch: string | undefined };

function listGitWorktrees(repoPath: string): GitWorktree[] {
  const result = spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf-8"
  });
  if (result.status !== 0) {
    return [];
  }
  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "" && current.path) {
      worktrees.push({ path: current.path, branch: current.branch });
      current = {};
    }
  }
  if (current.path) {
    worktrees.push({ path: current.path, branch: current.branch });
  }
  return worktrees;
}

function defaultWorktreePath(mainRepo: string, ws: string): string {
  return path.join(path.dirname(mainRepo), `${path.basename(mainRepo)}-${ws}`);
}

export async function workspaceUp(
  branch: string,
  opts: { path?: string; noDevpod?: boolean; open?: boolean; repoPath?: string } = {}
): Promise<void> {
  const mainRepo = resolveRepoPath(opts.repoPath);
  const ws = wsFromBranch(branch);
  if (!ws) {
    throw new Error(`Branch '${branch}' does not yield a valid workspace token.`);
  }
  const worktreePath = opts.path ? path.resolve(opts.path) : defaultWorktreePath(mainRepo, ws);

  // 1. Create the worktree (idempotent). Try an existing branch first, then create one.
  if (fs.existsSync(worktreePath)) {
    process.stdout.write(`Worktree already exists: ${worktreePath}\n`);
  } else {
    const add = spawnSync("git", ["-C", mainRepo, "worktree", "add", worktreePath, branch], {
      encoding: "utf-8"
    });
    if (add.status !== 0) {
      const addNew = spawnSync("git", ["-C", mainRepo, "worktree", "add", "-b", branch, worktreePath], {
        encoding: "utf-8"
      });
      if (addNew.status !== 0) {
        const detail = [add.stderr, addNew.stderr]
          .map((s) => s?.trim())
          .filter(Boolean)
          .join("; ");
        throw new Error(`git worktree add failed: ${detail || "unknown error"}`);
      }
    }
    process.stdout.write(`Created worktree ${worktreePath} (workspace '${ws}')\n`);
  }

  // 2. Bring up the devcontainer via devpod. `--name <ws>` names the devpod
  //    workspace; `WORKSPACE=<ws>` in the environment is what actually drives the
  //    compose `${WORKSPACE:-<project>}` alias substitution (devpod's `docker
  //    compose` child inherits this env), so the container's devnet alias becomes
  //    `<ws>-app` — matching the `${WORKSPACE}` upstream devrouter resolves for
  //    this worktree. Best-effort; gated on devpod being installed.
  if (!opts.noDevpod && hasDevpod()) {
    const dp = spawnSync("devpod", ["up", worktreePath, "--name", ws], {
      stdio: "inherit",
      env: { ...process.env, WORKSPACE: ws }
    });
    if (dp.status !== 0) {
      process.stderr.write(`Warning: 'devpod up' failed; continuing with route registration.\n`);
    }
  }

  // 3. Register routes for non-host routed apps. Pass `ws` explicitly (rather than
  //    re-deriving it inside the call) so the route tag, the devpod `--name`, and
  //    the namespaced host always agree — even under DEVROUTER_WORKSPACE or a
  //    detached-HEAD worktree, where auto-detection would diverge.
  const { config } = loadRuntimeConfig(worktreePath, ws);
  const routed = config.apps.filter(
    (app): app is Extract<typeof app, { host: string }> => "host" in app
  );
  const urls: string[] = [];
  const openUrls: string[] = [];
  for (const app of routed) {
    if (app.runtime === "host") {
      process.stdout.write(
        `Skipping host app '${app.name}' (run it in the worktree with 'dev app run ${app.name}').\n`
      );
      continue;
    }
    await runConfiguredApp({ name: app.name, repoPath: worktreePath, workspace: ws, yes: true });
    if (app.protocol === "tcp") {
      urls.push(`${app.host} (tcp/${app.tcpProtocol})`);
    } else {
      const url = `https://${app.host}`;
      urls.push(url);
      openUrls.push(url);
    }
  }

  if (urls.length > 0) {
    process.stdout.write(`\nWorkspace '${ws}' routes:\n${urls.map((u) => `  ${u}`).join("\n")}\n`);
  }
  if (opts.open) {
    for (const url of openUrls) {
      const opened = spawnSync("open", [url], { encoding: "utf-8" });
      if (opened.status !== 0) {
        const detail = [opened.stdout, opened.stderr].filter(Boolean).join("\n").trim();
        throw new Error(`Unable to open '${url}': ${detail || "unknown error"}`);
      }
      process.stdout.write(`Opened ${url}\n`);
    }
  }
}

export function workspaceLs(repoPath?: string): WorkspaceRow[] {
  const mainRepo = resolveRepoPath(repoPath);
  const worktrees = listGitWorktrees(mainRepo);
  const routes = listHostRouteState();

  return worktrees.map((wt) => {
    // The primary checkout has no workspace; a linked worktree derives its token
    // from the branch. Use the canonical isLinkedWorktree() rather than assuming
    // git lists the primary first. Attribute routes by worktree path (not by tag),
    // so counts stay correct under detached HEAD and never absorb another repo's
    // untagged routes.
    const workspace =
      isLinkedWorktree(wt.path) && wt.branch ? wsFromBranch(wt.branch) : undefined;
    const here = path.resolve(wt.path);
    const wsRoutes = routes.filter((route) => path.resolve(route.repoPath) === here);
    return {
      workspace,
      branch: wt.branch,
      worktreePath: wt.path,
      routeCount: wsRoutes.length,
      hosts: wsRoutes.map((route) => route.host)
    };
  });
}

export function workspaceDown(
  target: string,
  opts: { keepWorktree?: boolean; keepDevpod?: boolean; repoPath?: string } = {}
): { freedRoutes: number; workspace: string } {
  const ws = wsFromBranch(target);
  if (!ws) {
    throw new Error(`'${target}' does not yield a valid workspace token.`);
  }

  // Resolve this repo's worktree for the workspace (live entry, else the default
  // path) so route freeing can be scoped to it. Never load the worktree's config,
  // so teardown still works when the worktree/.devrouter.yml is already gone.
  const mainRepo = resolveRepoPath(opts.repoPath);
  const match = listGitWorktrees(mainRepo).find(
    (wt) => wt.branch && wsFromBranch(wt.branch) === ws
  );
  const worktreePath = match?.path ?? defaultWorktreePath(mainRepo, ws);

  // Free routes by the workspace tag AND the worktree path, so a same-named
  // workspace in a different repo is never torn down by this call.
  const here = path.resolve(worktreePath);
  const routes = listHostRouteState().filter(
    (route) => route.workspace === ws && path.resolve(route.repoPath) === here
  );
  for (const route of routes) {
    removeHostRouteById(route.id);
  }
  process.stdout.write(`Freed ${routes.length} route(s) for workspace '${ws}'.\n`);

  if (!opts.keepDevpod && hasDevpod()) {
    spawnSync("devpod", ["stop", ws], { stdio: "inherit" });
  }

  if (!opts.keepWorktree) {
    if (fs.existsSync(worktreePath) && worktreePath !== mainRepo) {
      const rm = spawnSync("git", ["-C", mainRepo, "worktree", "remove", worktreePath], {
        encoding: "utf-8"
      });
      if (rm.status === 0) {
        process.stdout.write(`Removed worktree ${worktreePath}.\n`);
      } else {
        process.stderr.write(
          `Warning: could not remove worktree ${worktreePath}: ${rm.stderr || "unknown error"}\n`
        );
      }
    }
  }

  return { freedRoutes: routes.length, workspace: ws };
}

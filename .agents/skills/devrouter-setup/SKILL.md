---
name: devrouter-setup
description: Guided first-time machine setup for devrouter. Detects the OS, Docker-compatible runtime, DevPod or Devsy, Node, mkcert, Git and the forge CLIs, then installs and verifies devrouter one confirmed step at a time. Use when a user wants to install devrouter, prepare a new machine, fix a failing `devrouter doctor`, or check whether the installed devrouter meets a repository's required minimum version.
user-invocable: true
---

# devrouter setup

Prepare one machine for devrouter. Detect first, then change state only after
the user confirms each step.

## Rules

- Detection is read-only. Run it before anything else and show the table.
- Ask before EACH state-changing step and wait for the answer. Ask one step at a
  time; never batch confirmations. The steps are: each dependency install,
  `npm install -g @devrouter/cli`, `devrouter setup --yes` (with
  `--workspace-runtime devsy` when the user chose Devsy), and
  `devrouter tls install`.
- If the user declines a step, skip it and its dependents, then continue with
  independent steps.
- Never edit agent configuration (Claude Code or Codex settings, MCP servers).
  Give the settings in "Sandboxed agents" as instructions only.

## 1. Detect

Run the bundled script from this skill's directory. Pass a repository path to
include the repository minimum version check.

```bash
bash scripts/detect.sh [path/to/repository]
```

It prints `ITEM STATE DETAIL` rows for: OS, Docker daemon and Compose, DevPod,
Devsy, Node (24 or newer) and its version manager, pnpm, mkcert, Git, `gh`,
`glab` and the installed devrouter version. A `missing` row names what to
install. DevPod and Devsy are alternatives: one is enough.

## 2. Install missing dependencies

Offer each missing item separately, using the platform command.

| Item | macOS (Homebrew) | Linux |
| --- | --- | --- |
| Docker runtime | `brew install --cask orbstack` (or Docker Desktop; or `brew install colima docker docker-compose` then `colima start`) | Docker Engine and the Compose v2 plugin from the distribution or Docker's apt/dnf repository; add the user to the `docker` group |
| Node 24+ | `brew install node@24`, or the user's version manager (`volta install node@24`, `fnm install 24`, `nvm install 24`) | The user's version manager, or the distribution's NodeSource packages |
| mkcert | `brew install mkcert nss` | Distribution package `mkcert` plus `libnss3-tools` (Debian/Ubuntu) or `nss-tools` (Fedora) |
| DevPod | `brew install devpod` | Release binary from the DevPod project |
| Devsy | Devsy desktop app or CLI release; Devrouter supports `>=1.16.2 <2.0.0` | Devsy CLI release |
| Git | `brew install git` | Distribution package `git` |
| `gh` / `glab` (optional) | `brew install gh glab` | Distribution packages or each project's install guide |

Prefer an already-detected version manager over adding another one. Ask which
workspace runtime the user wants (DevPod or Devsy) when neither is installed.

## 3. Install and configure devrouter

Each command below is its own confirmation:

1. `npm install -g @devrouter/cli`
2. `devrouter setup --yes`, or `devrouter setup --yes --workspace-runtime devsy`
   when Devsy is the chosen runtime
3. `devrouter tls install`

Then verify with `devrouter doctor` (add `--repo <path>` for a repository, or
`--json` for machine-readable output). Report each failing check with its
remediation; do not apply remediations without a further confirmation.

## 4. Repository minimum version

A repository declares its minimum in `.devrouter.yml` under
`devrouter.version`. The detection script compares it with the installed
version in the `repo-minimum` row. When the installed version is lower, offer
`npm install -g @devrouter/cli@latest` as a confirmed step, then run
`devrouter -V --repo <path>` to show the upgrade target.

## Sandboxed agents

Devrouter and the package manager write outside the repository: the global pnpm
store and the repository's `.git` folder. Sandboxed agents need those paths
writable. Tell the user to add them, and do not change the files yourself.

- Claude Code: add the paths to `sandbox.filesystem.allowWrite` in the user's
  Claude Code settings.
- Codex: add the paths to `permissions.<profile>.workspace_roots` in the user's
  Codex configuration, for the profile in use.

Paths to allow: the pnpm store (`pnpm store path` prints it) and the
repository's `.git` directory (for linked worktrees, the shared common Git
directory shown by `git rev-parse --git-common-dir`).

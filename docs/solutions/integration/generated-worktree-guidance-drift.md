---
module: agent-guidance
date: 2026-07-13
problem_type: integration
severity: high
symptoms:
  - "Generated AGENTS.md tells agents to run app run for a proxy-only devcontainer worktree"
  - "Generated skill says every repository must use docker-compose.default.yml"
root_cause: "Static generated guidance mixed managed-scaffold defaults with universal runtime instructions"
tags: [agents, devcontainer, worktree, generator, compose]
---

# Generated Guidance Starts the Wrong Worktree Lifecycle

## Problem

`devrouter repo agents` generated valid reference material, but its quick sequence always used `devrouter app run`. That command does not own a proxy-only devcontainer's lifecycle. The generated skill also described the managed scaffold's `docker-compose.default.yml` fallback as universal, contradicting repositories with an intentional custom default overlay.

## Symptoms

Agents following the generated files could skip `devrouter workspace ensure .`, leaving the exact worktree runtime, Git mount, aliases, health, and routes unproved. They could also rewrite a working compose default to match the managed scaffold unnecessarily.

## Solution

The generated quick sequence now gives linked devcontainer worktrees their canonical `workspace ensure` command and labels `app run` as host/docker-only. The skill distinguishes managed-scaffold defaults from custom repository defaults, while retaining the invariant that the combined base and worktree overlay pass both workspace identity variables.

Regression assertions cover both generated outputs.

## Prevention

- Keep lifecycle commands tied to runtime ownership: `workspace ensure` for linked devcontainers, `app run` for Devrouter-owned host/docker apps.
- Describe scaffold defaults as defaults, not repository-wide requirements.
- Test generated agent instructions as executable operational interfaces, not only as file-presence artifacts.

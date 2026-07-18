# Devrouter documentation

Use this page to choose the smallest authoritative document for the task.

## Product manuals

- [Getting started](./GETTING_STARTED.md): install devrouter and publish a first route.
- [Repository onboarding](./REPO_ONBOARDING.md): inspect and adopt an existing consumer repository.
- [Devcontainer integration](./DEVCONTAINER.md): connect a self-contained DevPod/devcontainer through managed proxy routing.
- [Root README](../README.md): product overview and short command reference.

These manuals describe supported current behavior. Executable code, tests, `.devrouter.yml` validation, and generated CLI help remain authoritative when prose conflicts.

## Repository knowledge

- [OKF knowledge index](./knowledge/index.md): cross-cutting authority, architecture, lifecycle, integration, and change guidance.

The knowledge bundle is an orientation layer. Its concept frontmatter declares source-path review triggers; run `pnpm check:knowledge` after concept or profile changes.

## Maintainer context

- [Domain context](../CONTEXT.md): compact vocabulary consumed by Matt Pocock skills and repository planning workflows.
- [Architecture decisions](./adr/): accepted rationale for durable trade-offs.
- [Integration solutions](./solutions/integration/): incident-derived failure analysis and prevention guidance.

## Project records

- [Project record index](./project/index.md): active roadmaps plus delivered implementation plans.

Project records retain dated execution context. They are not current product manuals and should link to current guidance when later behavior supersedes them.

## Release history

- [Changelog](../CHANGELOG.md): version history and migration links.
- [`upgrade-prompts/`](../upgrade-prompts/): one adaptation prompt for each release.

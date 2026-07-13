---
module: cli-packaging
date: 2026-07-13
problem_type: integration
severity: high
symptoms:
  - "devrouter -V --repo . prints the installed version, then fails with Missing upgrade-prompts directory"
root_cause: "Runtime resource lookup used the npm bin symlink location instead of the real packaged entry file"
tags: [npm, cli, symlink, packaging, upgrade-prompts]
---

# Packaged CLI Cannot Find Its Bundled Upgrade Prompts

## Problem

The npm package contained `upgrade-prompts/`, but commands that load the upgrade catalog could not find it when npm launched the CLI through `node_modules/.bin/devrouter`. This broke the documented version and upgrade flow only after publication.

## Symptoms

The published package reported its installed version and then failed:

```text
Installed CLI version: 0.0.26
Error: Missing upgrade-prompts directory at .../node_modules/upgrade-prompts.
```

The package manifest already included both `dist` and `upgrade-prompts` ([package.json](../../../package.json#L12)), so the failure looked like a missing-file packaging problem even though it was a runtime path problem.

## What Didn't Work

- Local source and local-install verification passed because both execute the real `dist/devrouter.js` path directly.
- Inspecting `npm pack --dry-run` proved the prompt files were present, but did not exercise npm's `.bin` symlink.

## Solution

Prompt discovery now resolves the entry-file symlink before looking one directory above `dist`, while retaining source-tree and current-working-directory fallbacks ([src/core/upgrade.ts](../../../src/core/upgrade.ts#L137)).

A regression test constructs the scoped npm package layout plus `.bin/devrouter` symlink and asserts that discovery returns the package's real `upgrade-prompts` directory ([src/core/__tests__/upgrade.test.ts](../../../src/core/__tests__/upgrade.test.ts#L75)).

## Why This Works

The npm bin entry is a symlink outside the scoped package. Resolving it first moves the lookup anchor back to `@devrouter/cli/dist/devrouter.js`; its parent package directory contains the bundled prompts.

## Prevention

- Keep the packaged-layout symlink test with the upgrade catalog tests.
- For releases that bundle runtime resources, smoke-test the packed tarball through `npm exec --package=<tarball> -- <command>` rather than relying only on source-tree execution or tarball file listings.

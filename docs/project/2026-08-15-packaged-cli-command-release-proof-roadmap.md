# W1 — Packaged CLI command and release proof

## Identity

- Date: 2026-08-15.
- Parent roadmap: [Devrouter roadmap](./2026-02-07-devrouter-roadmap.md).
- Related delivery plan: [Open-source release plan](./2026-02-08-open-source-release-plan.md).
- Repository: `/Users/rschlae/Git/personal/devrouter`.
- Future base: `main`, including cleanup merge `32c29dd`.
- Future branch: `rs/packaged-cli-command-proof`.
- Future worktree: `/Users/rschlae/Git/personal/devrouter/trees/rs-packaged-cli-command-proof`.
- Pull request target: `main`; no PR exists yet.
- Audience: junior dev/agent picking this up without session context. Read
  `AGENTS.md`, the parent roadmap, and the release plan before creating the
  execution plan.

## How to work on this

1. Finish and commit the current delivery-reconciliation docs before creating
   the future W1 worktree. Fetch `origin/main`, verify that it contains
   `32c29dd`, and create the branch/worktree named above from that base.
2. Run host-side Git and GitHub commands outside a devcontainer. Run the
   repository's Node/pnpm checks in the W1 worktree with Node 24 and pnpm
   11.6.0, as declared by `package.json`.
3. Install dependencies with `pnpm install --frozen-lockfile`. Build before
   package verification with `pnpm build`.
4. The package smoke must create its tarball and installation under a temporary
   directory, invoke only the temporary installation, and remove that
   directory on exit. It must run the probes from a working directory outside
   the repository.
5. The complete verification loop is:

   ```sh
   pnpm check:docs-policy
   pnpm check:knowledge
   pnpm check
   pnpm knip
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm test:package
   ```

   The CI job must run `pnpm test:package` immediately after `pnpm build`.

## Current state

| Item | State | Evidence |
| --- | --- | --- |
| Cleanup package | delivered | PR #27 merged into `main` at `32c29dd`; the command remains report-only. |
| Package allowlist | exists | `package.json` includes `bin`, `dist`, and `upgrade-prompts` in its published files. |
| Built-command CI proof | missing | `.github/workflows/ci.yml` runs quality checks and `pnpm build`, but no installed-package probe. |
| Packed-content proof | missing | The release plan still lists packed contents, `npx`, and installed-executable verification as remaining work. |
| Upgrade prompt layout risk | present | `src/core/upgrade.ts` resolves prompts from the executable layout but also falls back to `process.cwd()`, so repository-local runs can hide missing package assets. |
| Candidate command probes | available | `--help`, `-V --repo`, `upgrade --repo`, and `repo inspect --repo ... --json` are existing non-mutating commands. |

The W1 package is a verification and CI change. It does not change product
command behavior or publish a release.

## Non-negotiables

- Do not publish to npm, create a release, bump the version, install globally,
  or alter registry state.
- Do not add a product command, change command semantics, or expand protocol
  support. A runtime defect found by the smoke becomes separate implementation
  scope; it is not hidden inside the harness.
- Do not add a dependency for the smoke. Use the existing Node/pnpm toolchain,
  shell utilities, and repository scripts.
- The smoke must invoke the exact locally packed tarball. It must not resolve a
  global `devrouter`, a repository checkout, a registry package, or an
  unrelated `npx` result as the executable under test.
- Run probes from outside the repository so `process.cwd()` cannot satisfy a
  missing `upgrade-prompts` asset.
- Only run non-mutating probes: `--help`, `-V --repo`, `upgrade --repo`, and
  `repo inspect --repo ./examples/routing --json`. Do not run `setup --yes`,
  router startup, Docker, DevPod, TLS, or live cleanup from this smoke.
- Fail closed when a declared binary, expected prompt, tarball member, or
  structured command result is absent or malformed.
- Keep temporary tarballs, installation directories, and logs outside the
  repository; clean them up on success and failure.
- Do not print credentials or secret values. Package checks must inspect names,
  paths, exit statuses, and safe structured fields only.

## Known traps

- **A repository-local `upgrade --repo` passes while the package is broken.**
  Cause: prompt discovery includes a `process.cwd()` fallback. Remedy: invoke
  the temporary binary with the current directory outside the repository and
  assert that every source prompt has a matching packaged member.
- **`npx` exercises a different binary.** Cause: registry or global resolution
  can win when the temporary install is not bound explicitly. Remedy: invoke
  the exact temporary `node_modules/.bin/devrouter` path or a local
  `npx --no-install` with a temporary-only `PATH`, and verify its resolved
  package location.
- **A source build is mistaken for an installation test.** Cause: `pnpm build`
  proves `dist/` in the checkout, not the published file allowlist. Remedy:
  pack, inspect the tarball, install it in a temporary directory, and run the
  probes there.
- **Release work leaks into the verification package.** Cause: the CI workflow
  has a conditional publish job. Remedy: change only the required-check job;
  never trigger or edit publication behavior in W1.
- **A live environment makes the smoke flaky or destructive.** Cause: Docker,
  DevPod, TLS, and setup commands have external state. Remedy: keep W1
  entirely local, temporary-directory based, and independent of those tools.

## Work items

### W1 — Packaged CLI command and release proof

**Problem**

The required CI checks validate source files, tests, and compilation but do not
prove that the tarball users install contains the declared binaries,
`upgrade-prompts`, and a runnable CLI layout. This leaves documented commands
and upgrade discovery unverified at the distribution boundary.

**Do**

1. Add one package-level smoke entry point, exposed as `pnpm test:package`,
   without adding a dependency. Keep the implementation under `scripts/` and
   make its temporary-directory cleanup unconditional.
2. Build and pack the candidate from the repository into a temporary directory.
   Compare the tarball members with the declared binaries and every local
   versioned file under `upgrade-prompts/`; missing members must fail the check.
3. Install that exact tarball into an isolated temporary prefix or project
   outside the repository. Bind invocation to that installation and prove that
   no global or registry-resolved `devrouter` is being exercised.
4. From a temporary working directory outside the repository, run and validate
   these non-mutating probes against `./examples/routing`:
   `devrouter --help`, `devrouter -V --repo ...`, `devrouter upgrade --repo ...`,
   and `devrouter repo inspect --repo ... --json`. Validate JSON syntax and
   require the inspection object to contain `repoPath`, `scripts`, `apps`,
   `services`, `env`, `devcontainer`, `devrouter`, `agentGuidance`, and
   `issues` fields.
5. Add the package smoke step after `pnpm build` in
   `.github/workflows/ci.yml`. Keep the conditional publish job unchanged.
6. Update the owning verification guidance only if the command name or
   validation sequence changes. Do not duplicate the package contract in
   product manuals.

**Check**

The following command sequence passes on the W1 branch:

```sh
pnpm check:docs-policy && \
pnpm check:knowledge && \
pnpm check && \
pnpm knip && \
pnpm typecheck && \
pnpm test && \
pnpm build && \
pnpm test:package
```

Additionally, `pnpm test:package` must demonstrate all of the following:

- the tarball contains `dist/`, both declared binaries, and every source
  `upgrade-prompts/*.md` file;
- the installed executable runs outside the repository from the temporary
  installation;
- all four documented probes exit successfully, with JSON output parseable
  where applicable;
- removing or failing to find an expected package member causes a non-zero
  result rather than a warning-only pass;
- the repository has no generated tarball, temporary install, or runtime state
  left behind after the smoke; and
- the same smoke step passes in the Ubuntu CI `check` job after the build.

**Depends on / GATED on**

- GATED on completion of the current reconciliation docs and a fresh W1
  worktree from `main` containing cleanup merge `32c29dd` — do not start on the
  reconciliation worktree.
- No Docker, DevPod, TLS, npm publication, or release approval is required for
  this W-item.

**Priority**

P1. This is the next package because it closes a concrete distribution boundary
and combines the already-related command-regression and CI/release-proof
backlog entries without changing product behavior.

## Decision gates

| Gate | Decision | Ruling |
| --- | --- | --- |
| A1 — next package | Whether to prioritize packaged CLI command and release proof over `app env`, Compose bootstrap, `app doctor`, or platform-specific hardening | Approved by the user on 2026-08-15; do not re-litigate. |

## External dependencies to watch

- GitHub Actions Ubuntu runners must continue to provide Node 24, pnpm, and
  network access for declared package dependencies.
- npm publication remains owned by the separate release workflow and is not a
  W1 dependency or outcome.

## Review and evidence expectations

At the W1 boundary, provide:

- the implementation branch and PR targeting `main`;
- the exact changed-path list, with no product-command or release-publication
  changes hidden in the harness;
- complete output and exit status for the validation sequence and
  `pnpm test:package`;
- evidence that the package smoke ran outside the repository and invoked the
  temporary installation;
- the CI `check` result with the package smoke step; and
- a statement that no release, publication, global installation, Docker,
  DevPod, TLS, or live cleanup action occurred.

The execution plan for W1 owns slice decomposition, review routing, and the
finish gate. A future executor must create that plan before implementation.

## Progress

- `2026-08-15`: W1 approved by the user after read-only repository exploration
  and a planning-stage challenge. No implementation branch, PR, package smoke,
  release, or publication exists yet.

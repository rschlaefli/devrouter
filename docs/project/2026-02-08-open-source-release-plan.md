# Open-source release plan

Status: active backlog. The package is public; this record now tracks remaining portability and release-quality work.

## Goal

Keep `@devrouter/cli` simple to install, safe to run, and verifiable on supported macOS, Linux, and WSL environments. Native Windows remains unsupported.

## Delivered baseline

- MIT license, contributor guide, code of conduct, public package metadata, and the `devrouter` binary.
- Package allowlist through `package.json.files`; a separate `.npmignore` is unnecessary.
- Path, hostname, dependency-cycle, command-length, port-range, and route-state validation.
- Vitest, TypeScript, Biome, Knip, Gitleaks, pre-commit, and Ubuntu GitHub CI gates.
- Current product manuals, changelog, versioned upgrade prompts, and a release-triggered npm publish job with provenance.
- Docker host access through `host.docker.internal:host-gateway` and one shared `isPidRunning()` implementation.
- External tools are diagnosed with remediation guidance; devrouter does not install Docker, DevPod, Node, pnpm, or the mkcert binary.

## Remaining work

### Cross-platform proof

- Add a macOS CI job for non-Docker checks; keep Ubuntu as the required Linux lane.
- Run and record the routing and devcontainer smokes on Docker Desktop, OrbStack, native Linux Docker, and WSL.
- Expand process and network-discovery tests where `ps`, `lsof`, and platform behavior differ.

### CI and release proof

- Add a Docker-backed smoke lane when a stable runner can exercise TLS and shared ports without weakening the existing local smoke.
- Verify packed contents, `npx @devrouter/cli`, and an installed `devrouter` executable before publication.

### Troubleshooting UX

- Decide whether a bounded `--debug` report adds value beyond `setup --json`, `doctor`, `status`, and `logs`; avoid a global verbose mode without a concrete diagnostic contract.
- Continue replacing generic external-tool failures with command-specific context and remediation.

## Release decisions

- GitHub release or approved manual workflow dispatch owns npm publication; semantic-release and changesets are not required.
- `npm i -g @devrouter/cli` is the primary persistent install; `npx @devrouter/cli` remains the no-install path.
- Full Docker/DevPod smoke coverage remains an explicit environment gate until CI can reproduce it reliably.

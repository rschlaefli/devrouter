import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_DEVCONTAINER_MARKER, type ManagedDevcontainerPlan } from "../devcontainer-profile";
import {
  deleteOwnedDevpodWorkspace,
  startDevpodWorkspace,
  stopOwnedDevpodWorkspace,
} from "../devpod-mutation";
import {
  deleteOwnedDevsyWorkspace,
  startDevsyWorkspace,
  stopOwnedDevsyWorkspace,
} from "../devsy-mutation";
import { findOwnedNetworkClaim, networkOwnerKey } from "../network-claim-lookup";
import { prepareNetworkComposeFiles } from "../network-compose-files";
import type { PreparedNetworkStart } from "../network-provider-binding";
import { qualifyNetworkProviderDefinition } from "../network-provider-inspect";
import { resetWorkspaceRuntimeCaches } from "../workspace-runtime";

const state = vi.hoisted(() => ({
  home: `/tmp/network-provider-process-${process.pid}-${Date.now()}`,
}));
vi.mock("../router", async (original) => ({
  ...(await original()),
  DEVROUTER_HOME: state.home,
  CACHE_DIR: `${state.home}/cache`,
}));
vi.mock("../devsy-agent", async (original) => ({
  ...(await original()),
  requireReadyDevsyAgent: () => ({ binaryPath: "/synthetic/verified-agent" }),
}));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  resetWorkspaceRuntimeCaches();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(state.home, { recursive: true, force: true });
});

function definition(provider: string) {
  return {
    name: "docker",
    agent: {
      local: true,
      docker: {
        path: "${DOCKER_PATH}",
        builder: "${DOCKER_BUILDER}",
        install: false,
        ...(provider === "devsy" ? { elevation: "${DOCKER_ELEVATION}" } : {}),
        env: { DOCKER_HOST: "${DOCKER_HOST}" },
      },
    },
    options: { DOCKER_HOST: { global: true }, DOCKER_PATH: { default: "docker" } },
    exec: {
      command:
        provider === "devsy"
          ? '"${DEVSY}" internal sh -c "${COMMAND}"'
          : '"${DEVPOD}" helper sh -c "${COMMAND}"',
    },
  };
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "network-provider-fixture-")));
  roots.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync("/bin/ps", path.join(bin, "ps"));
  const repo = path.join(root, "repo");
  const compose = path.join(repo, ".devcontainer");
  fs.mkdirSync(compose, { recursive: true });
  const receipt = path.join(root, "receipt.jsonl");
  const registry = path.join(root, "registry.json");
  fs.writeFileSync(registry, "[]");
  const yamlModule = createRequire(__filename).resolve("yaml");
  const executable = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const YAML = require(${JSON.stringify(yamlModule)});
const argv = process.argv.slice(2);
const provider = path.basename(process.argv[1]);
const record = value => fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(value)+'\\n');
const option = key => argv[argv.indexOf(key)+1];
const up = provider === 'devsy' ? argv[0] === 'workspace' && argv[1] === 'up' : argv[0] === 'up';
const list = provider === 'devsy' ? argv[0] === 'workspace' && argv[1] === 'list' : argv[0] === 'list';
const action = provider === 'devsy' ? argv[1] : argv[0];
if (argv[0] === 'context' && argv[1] === 'list') process.stdout.write(JSON.stringify([{name:'synthetic-context', default:true}]));
else if (argv[0] === 'version' || argv[0] === '--version') process.stdout.write(provider === 'devsy' ? '1.16.2' : '0.6.15');
else if (argv[0] === 'provider' && argv[1] === 'list') process.stdout.write(JSON.stringify({docker:{config: ${JSON.stringify({ devsy: definition("devsy"), devpod: definition("devpod") })}[provider], state:{options:{}}}}));
else if (provider === 'docker') {
  assert.deepEqual(argv, ['--host', 'unix:///tmp/provider.sock', 'info', '--format', '{{json .ID}}']);
  assert.equal(process.env.DOCKER_CONTEXT, undefined);
  assert.equal(process.env.DOCKER_HOST, undefined);
  record({provider, action:'identity'}); process.stdout.write('"daemon"');
}
else if (action === 'stop' || action === 'delete') {
  assert.deepEqual(argv, [...(provider === 'devsy' ? ['workspace'] : []), action, 'synthetic', ...(action === 'delete' ? ['--ignore-not-found'] : []), '--context', 'synthetic-context', '--provider', 'docker']);
  assert.equal(process.env.DOCKER_CONTEXT, undefined);
  assert.equal(process.env.DOCKER_HOST, undefined);
  record({provider, action});
  if (action === 'delete') fs.writeFileSync(${JSON.stringify(registry)}, '[]');
}
else if (list) { record({provider, action:'list'}); process.stdout.write(fs.readFileSync(${JSON.stringify(registry)})); }
else if (up) {
  record({provider, action:'up'});
  assert.equal(option('--provider'), 'docker');
  assert.equal(option('--context'), 'synthetic-context');
  assert.equal(option('--provider-option'), 'DOCKER_HOST=unix:///tmp/provider.sock');
  assert.equal(process.env.DOCKER_CONTEXT, undefined);
  assert.equal(process.env.DOCKER_HOST, undefined);
  const configPath = path.join(${JSON.stringify(repo)}, option(provider === 'devsy' ? '--devcontainer' : '--devcontainer-path'));
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw.slice(raw.indexOf('\\n')+1));
  const models = config.dockerComposeFile.map(file => YAML.parse(fs.readFileSync(path.join(path.dirname(configPath), file), 'utf8')));
  assert.equal(models.length, 2);
  assert.deepEqual(models[0].services.web.networks, ['default', 'devnet']);
  assert.equal(models[0].networks.devnet.external, true);
  assert.equal(models[1].networks.default.ipam.config[0].subnet, '10.88.0.0/26');
  assert.equal(models[1].services, undefined);
  record({provider, action:'overlay-validated', subnet: models[1].networks.default.ipam.config[0].subnet});
  fs.writeFileSync(${JSON.stringify(registry)}, JSON.stringify([{id:option('--id'),source:{localFolder:${JSON.stringify(repo)}}}]));
  if (process.env.NETWORK_FIXTURE_FAIL === '1') process.exit(1);
  if (process.env.NETWORK_FIXTURE_FAIL === 'attachment') fs.writeFileSync(${JSON.stringify(registry)}, '[]');
} else { record({provider, action:'unexpected'}); process.exit(97); }
`;
  for (const provider of ["devsy", "devpod", "docker"])
    fs.writeFileSync(path.join(bin, provider), executable, { mode: 0o700 });
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!${process.execPath}\nprocess.exit(process.argv.includes('check-ignore') ? 0 : 97);\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", bin);
  vi.stubEnv("HOME", root);
  vi.stubEnv("DEVROUTER_HOME", state.home);
  vi.stubEnv("DOCKER_HOST", "unix:///tmp/ambient.sock");
  vi.stubEnv("DOCKER_CONTEXT", "ambient-context");
  fs.writeFileSync(
    path.join(compose, "compose.yml"),
    "services:\n  web:\n    image: synthetic\n    networks: [default, devnet]\nnetworks:\n  default: {}\n  devnet:\n    external: true\n",
  );
  const native = {
    composeDirectory: compose,
    composeFiles: [path.join(compose, "compose.yml")],
    contents: `${MANAGED_DEVCONTAINER_MARKER}\n${JSON.stringify({ dockerComposeFile: ["compose.yml"], runServices: ["web"] })}\n`,
    effectiveConfigSha256: "before",
  } as ManagedDevcontainerPlan;
  const generated = prepareNetworkComposeFiles(native, "10.88.0.0/26");
  generated.write();
  fs.writeFileSync(path.join(compose, "managed.json"), generated.plan.contents);
  return { repo, compose, receipt, registry, native };
}

describe("real provider subprocess contract with closed synthetic executables", () => {
  it.each([
    "devsy",
    "devpod",
  ] as const)("pins %s stop and delete to a persisted claim", (provider) => {
    const f = fixture();
    vi.stubEnv("DEVROUTER_WORKSPACE_RUNTIME", provider);
    resetWorkspaceRuntimeCaches();
    const claim = {
      ownerKey: networkOwnerKey(f.repo),
      provider,
      providerId: "synthetic",
      providerContext: "synthetic-context",
      definitionSha256: qualifyNetworkProviderDefinition(definition(provider), provider),
      endpoint: "unix:///tmp/provider.sock",
      daemonId: "daemon",
      configFingerprint: "fingerprint",
      subnet: "10.88.0.0/26",
      prefix: 26,
      operationId: "operation",
      workerId: "worker",
      state: "attached",
      networkId: "network",
      fence: {
        environmentId: "environment",
        intentRevision: 1,
        runtimeGeneration: 1,
        controllerEpoch: 1,
      },
    };
    const root = path.join(state.home, "networks");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, `${createHash("sha256").update("daemon").digest("hex")}.json`),
      JSON.stringify({ version: 1, daemonId: "daemon", claims: [claim] }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      f.registry,
      JSON.stringify([
        {
          id: "synthetic",
          source: { localFolder: f.repo },
          provider: { name: "docker", options: { DOCKER_HOST: { value: claim.endpoint } } },
        },
      ]),
    );
    const stop = provider === "devsy" ? stopOwnedDevsyWorkspace : stopOwnedDevpodWorkspace;
    const remove = provider === "devsy" ? deleteOwnedDevsyWorkspace : deleteOwnedDevpodWorkspace;
    expect(stop("synthetic", f.repo).status).toBe("changed");
    expect(findOwnedNetworkClaim(f.repo)).toEqual(claim);
    expect(remove("synthetic", f.repo).status).toBe("changed");
    expect(findOwnedNetworkClaim(f.repo)).toEqual(claim);
    const rows = fs
      .readFileSync(f.receipt, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.action === "stop")).toHaveLength(1);
    expect(rows.filter((row) => row.action === "delete")).toHaveLength(1);
    expect(rows.filter((row) => row.action === "identity")).toHaveLength(2);
    expect(rows.filter((row) => row.action === "unexpected")).toHaveLength(0);
  });
  it.each([
    "devsy",
    "devpod",
  ] as const)("forwards %s allocation overlay and retains failed effects", async (provider) => {
    const f = fixture();
    vi.stubEnv("DEVROUTER_WORKSPACE_RUNTIME", provider);
    resetWorkspaceRuntimeCaches();
    const binding = {
      provider,
      providerId: "synthetic",
      endpoint: "unix:///tmp/provider.sock",
      daemonId: "daemon",
      definitionSha256: "a".repeat(64),
      providerContext: "synthetic-context",
    };
    const retainUncertain = vi.fn();
    const prepared: PreparedNetworkStart = {
      binding,
      evidence: {
        ...binding,
        versionQualified: true,
        providerName: "docker",
        dockerPath: "docker",
        persistedEndpoint: null,
        persistedContext: null,
        registration: "absent",
      },
      firstAllocation: true,
      devcontainerPath: ".devcontainer/managed.json",
      retainUncertain,
    };
    const start = () =>
      provider === "devsy"
        ? startDevsyWorkspace({
            repoPath: f.repo,
            devsyId: "synthetic",
            prepareNetwork: () => prepared,
          })
        : startDevpodWorkspace({
            repoPath: f.repo,
            devpodId: "synthetic",
            prepareNetwork: () => prepared,
          });
    await expect(start()).resolves.toBe("synthetic");
    expect(retainUncertain).not.toHaveBeenCalled();
    prepared.firstAllocation = false;
    prepared.evidence.registration = "owned";
    prepared.evidence.persistedEndpoint = binding.endpoint;
    await expect(start()).resolves.toBe("synthetic");
    vi.stubEnv("NETWORK_FIXTURE_FAIL", "1");
    await expect(start()).rejects.toThrow();
    expect(retainUncertain).toHaveBeenCalledOnce();
    vi.stubEnv("NETWORK_FIXTURE_FAIL", "attachment");
    await expect(start()).rejects.toThrow();
    expect(retainUncertain).toHaveBeenCalledTimes(2);
    const rows = fs
      .readFileSync(f.receipt, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.action === "overlay-validated")).toHaveLength(4);
    expect(rows.filter((row) => row.action === "up")).toHaveLength(4);
    expect(rows.filter((row) => row.action === "unexpected")).toHaveLength(0);
    expect(f.native.composeFiles).toEqual([path.join(f.compose, "compose.yml")]);
  });
});

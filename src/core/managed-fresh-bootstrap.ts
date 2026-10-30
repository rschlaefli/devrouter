import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import type { DevrouterConfig } from "../types";
import { readDevcontainerConfig } from "./devcontainer-config";
import { type ManagedDevcontainerPlan, managedComposeEnvironment } from "./devcontainer-profile";
import {
  inspectManagedStopContainers,
  inspectManagedStopDaemon,
  inspectWorkspaceContainers,
  resolveManagedStopEndpoint,
  SAFE_INSPECT_TEMPLATE,
  supportsManagedStopBaseline,
  workspaceAppContainers,
} from "./devpod-environment";
import { requireReadyDevsyAgent } from "./devsy-agent";
import { captureDevsyExecProof, revalidateDevsyExecProof } from "./devsy-exec-proof";
import type { DevsyStartOptions } from "./devsy-mutation";
import { listDevsyWorkspaces, selectDevsyWorkspace } from "./devsy-workspaces";
import { reportLifecycleProgress } from "./lifecycle-progress";
import {
  type ManagedRuntimeState,
  readManagedRuntimeState,
  writeManagedRuntimeState,
} from "./managed-runtime-state";
import { captureManagedStopBaseline, proveRetainedManagedStop } from "./managed-stop-recovery";
import {
  assertNetworkProviderBinding,
  type NetworkProviderBinding,
  networkProviderEnvironment,
} from "./network-provider-binding";
import { inspectNetworkProviderBinding } from "./network-provider-inspect";
import {
  advanceActiveFreshBootstrap,
  claimActiveFreshBootstrap,
  claimLifecycleEffect,
} from "./reliability-lifecycle";
import {
  type FreshBootstrapAttempt,
  type ReliabilityIdentity,
  readReliabilityOperation,
} from "./reliability-operation-store";
import { loadRepoConfig } from "./repo-config";
import { sameWorkspacePath } from "./workspace";

type Declaration = NonNullable<
  NonNullable<DevrouterConfig["managedRuntime"]>["devcontainer"]["freshBootstrap"]
>;
type ComposeModel = {
  services: Record<
    string,
    { volumes?: { type: string; source?: string; target: string; read_only?: boolean }[] }
  >;
  volumes?: Record<
    string,
    { name?: string; external?: boolean; driver?: string; driver_opts?: unknown }
  >;
};
type Volume = {
  Name: string;
  Driver: string;
  Scope: string;
  CreatedAt: string;
  Mountpoint: string;
  Options?: unknown;
  Labels?: Record<string, string>;
};

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function qualifiedContext(source: Record<string, unknown>): void {
  if (
    (source.userEnvProbe !== undefined && source.userEnvProbe !== "loginInteractiveShell") ||
    (object(source.remoteEnv) && Object.hasOwn(source.remoteEnv, "PATH")) ||
    (object(source.secrets) && Object.keys(source.secrets).length > 0) ||
    (object(source.features) && Object.keys(source.features).length > 0) ||
    source.onCreateCommand ||
    source.updateContentCommand
  )
    throw new Error(
      "Fresh bootstrap requires a qualified default-probe context without PATH overrides, secrets, features or earlier container hooks.",
    );
  if (
    source.postStartCommand &&
    !["postStartCommand", "postAttachCommand"].includes(String(source.waitFor))
  )
    throw new Error("Fresh bootstrap requires waitFor to include the declared post-start hook.");
}

/** Read-only intent check, repeated under the provider lock before claiming. */
export function assertFreshBootstrapRequest(
  identity: ReliabilityIdentity,
  options: { initializeNew?: boolean; repair?: boolean },
): void {
  if (!options.initializeNew) return;
  if (identity.provider !== "devsy" || options.repair)
    throw new Error(
      "--initialize-new requires a fresh Devsy managed environment without --repair.",
    );
  if (!loadRepoConfig(identity.repoPath).managedRuntime?.devcontainer.freshBootstrap)
    throw new Error("--initialize-new requires managedRuntime.devcontainer.freshBootstrap.");
  if (readReliabilityOperation(identity)?.freshBootstrap)
    throw new Error(
      "This environment already records an initialization attempt; initialization cannot be replayed. Use preserving recovery or a new disposable checkout.",
    );
  if (
    readManagedRuntimeState(identity.repoPath, identity.workspace ?? undefined) ||
    selectDevsyWorkspace(listDevsyWorkspaces(), identity.repoPath)
  )
    throw new Error("Fresh bootstrap refuses a retained runtime or provider registration.");
  qualifiedContext(readDevcontainerConfig(identity.repoPath).source);
}

function docker(endpoint: string, args: string[], cwd?: string, environment = process.env): string {
  const env = { ...environment };
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_HOST;
  const result = spawnSync("docker", ["--host", endpoint, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      "Fresh-bootstrap Docker evidence is unavailable; initialization was not retried.",
    );
  return result.stdout;
}

function sourceIdentity(repoPath: string, plan: ManagedDevcontainerPlan): string {
  return hash(
    JSON.stringify([
      hash(fs.readFileSync(path.join(repoPath, ".devrouter.yml"))),
      hash(fs.readFileSync(plan.sourcePath)),
      plan.effectiveConfigSha256,
      ...plan.composeFiles.map((file) => [file, hash(fs.readFileSync(file))]),
    ]),
  );
}

function render(
  endpoint: string,
  plan: ManagedDevcontainerPlan,
  project: string,
  workspace?: { token: string; gitCommonDir: string },
): ComposeModel {
  const args = [
    "compose",
    "--project-name",
    project,
    "--project-directory",
    plan.composeDirectory,
    ...plan.composeFiles.flatMap((file) => ["-f", file]),
    "config",
    "--format",
    "json",
    "--no-env-resolution",
  ];
  const env = managedComposeEnvironment(workspace);
  const value: unknown = JSON.parse(docker(endpoint, args, plan.composeDirectory, env));
  if (
    !object(value) ||
    !object(value.services) ||
    (value.volumes !== undefined && !object(value.volumes))
  )
    throw new Error("Invalid fresh-bootstrap Compose model.");
  return value as ComposeModel;
}

export function verifyFreshBootstrapMounts(
  repoPath: string,
  plan: ManagedDevcontainerPlan,
  model: ComposeModel,
  declaration: Declaration,
  workspace?: { token: string; gitCommonDir: string },
): void {
  const selected = new Set<string>();
  for (const service of plan.desiredServices) {
    const entry = model.services[service];
    if (!entry)
      throw new Error("Fresh-bootstrap selected service is absent from the Compose model.");
    for (const mount of entry.volumes ?? []) {
      if (mount.type === "volume") {
        if (!mount.source || !model.volumes?.[mount.source])
          throw new Error("Fresh bootstrap requires exact named volume declarations.");
        selected.add(mount.source);
      } else if (mount.type === "bind" && !mount.read_only) {
        const source = fs.realpathSync(mount.source ?? "");
        const relative = path.relative(repoPath, source);
        const gitMount =
          workspace &&
          service === plan.primaryService &&
          source === fs.realpathSync(workspace.gitCommonDir) &&
          mount.target === workspace.gitCommonDir;
        if (
          !gitMount &&
          (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        )
          throw new Error(
            "Fresh bootstrap refuses writable bind mounts outside the checkout and its exact Git common directory.",
          );
      } else if (!["bind", "tmpfs"].includes(mount.type)) {
        throw new Error("Fresh bootstrap found an unsupported mount type.");
      }
    }
  }
  for (const key of [...declaration.dataVolumes, ...declaration.sharedCaches]) {
    if (!selected.has(key))
      throw new Error("Fresh-bootstrap volume binding is not mounted by the selected profile.");
  }
  for (const key of selected) {
    const volume = model.volumes?.[key];
    const cache = declaration.sharedCaches.includes(key);
    if (
      !volume ||
      (cache ? volume.external !== true : volume.external === true) ||
      (volume.driver && volume.driver !== "local") ||
      (volume.driver_opts !== undefined &&
        (!object(volume.driver_opts) || Object.keys(volume.driver_opts).length > 0))
    )
      throw new Error(
        "Fresh bootstrap requires new local volumes or explicitly declared external shared caches.",
      );
  }
}

/** A complete bounded before-snapshot supports names assigned only during provisioning. */
function volumeSnapshot(endpoint: string): string[] {
  const rows = docker(endpoint, ["volume", "ls", "--format", "{{json .Name}}"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    rows.length > 4096 ||
    rows.some(
      (name) => typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(name),
    ) ||
    new Set(rows).size !== rows.length
  )
    throw new Error("Fresh-bootstrap volume inventory is incomplete or exceeds its bound.");
  return rows.map((name) => hash(name)).sort();
}

function assertNoCheckoutContainers(endpoint: string, repoPath: string): void {
  const ids = docker(endpoint, ["ps", "--all", "--quiet", "--no-trunc"])
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    ids.length > 4096 ||
    ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Fresh-bootstrap container inventory is incomplete or exceeds its bound.");
  for (let offset = 0; offset < ids.length; offset += 64) {
    const batch = ids.slice(offset, offset + 64);
    const rows = docker(endpoint, ["inspect", "--format", SAFE_INSPECT_TEMPLATE, ...batch])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (rows.length !== batch.length || new Set(rows.map((row) => row.id)).size !== batch.length)
      throw new Error("Fresh-bootstrap container absence evidence changed.");
    for (const row of rows) {
      if (!batch.includes(row.id) || !object(row.labels) || !Array.isArray(row.mounts))
        throw new Error("Fresh-bootstrap container absence evidence is invalid.");
      if (
        sameWorkspacePath(
          row.labels["com.docker.compose.project.working_dir"] ?? "",
          path.join(repoPath, ".devcontainer"),
        ) ||
        row.mounts.some(
          (mount: { Type?: string; Source?: string }) =>
            mount.Type === "bind" && sameWorkspacePath(mount.Source ?? "", repoPath),
        )
      )
        throw new Error("Fresh bootstrap refuses surviving containers for this checkout.");
    }
  }
}

export function verifyFreshVolume(
  volume: Volume,
  key: string,
  project: string,
  prior: readonly string[],
  sharedCache: boolean,
): void {
  if (
    !volume ||
    typeof volume.Name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(volume.Name) ||
    volume.Driver !== "local" ||
    volume.Scope !== "local" ||
    typeof volume.Mountpoint !== "string" ||
    typeof volume.CreatedAt !== "string" ||
    !path.isAbsolute(volume.Mountpoint) ||
    !Number.isFinite(Date.parse(volume.CreatedAt)) ||
    (volume.Options !== undefined && volume.Options !== null && !object(volume.Options)) ||
    (object(volume.Options) && Object.keys(volume.Options).length > 0)
  )
    throw new Error("Fresh-bootstrap volume identity is not qualified local storage.");
  if (
    !sharedCache &&
    (prior.includes(hash(volume.Name)) ||
      volume.Labels?.["com.docker.compose.project"] !== project ||
      volume.Labels?.["com.docker.compose.volume"] !== key)
  )
    throw new Error("Fresh bootstrap refuses retained or foreign data volumes.");
}

function proveVolumes(input: {
  endpoint: string;
  model: ComposeModel;
  declaration: Declaration;
  plan: ManagedDevcontainerPlan;
  project: string;
  prior: string[];
}): NonNullable<FreshBootstrapAttempt["resources"]>["dataVolumes"] {
  const containers = inspectManagedStopContainers(input.project, input.endpoint);
  const result: NonNullable<FreshBootstrapAttempt["resources"]>["dataVolumes"] = [];
  const names = new Set<string>();
  const seen = new Set<string>();
  for (const service of input.plan.desiredServices) {
    const container = containers.find((c) => c.labels["com.docker.compose.service"] === service);
    if (!container) throw new Error("Fresh-bootstrap volume owner is absent.");
    for (const mount of input.model.services[service].volumes ?? []) {
      if (mount.type !== "volume" || !mount.source) continue;
      const key = mount.source;
      const name = input.model.volumes?.[key]?.name;
      if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(name))
        throw new Error("Fresh-bootstrap volume name did not resolve exactly.");
      const inspected: unknown = JSON.parse(docker(input.endpoint, ["volume", "inspect", name]));
      if (
        !Array.isArray(inspected) ||
        inspected.length !== 1 ||
        !object(inspected[0]) ||
        inspected[0].Name !== name
      )
        throw new Error("Fresh-bootstrap volume inspection is ambiguous.");
      const volume = inspected[0] as Volume;
      verifyFreshVolume(
        volume,
        key,
        input.project,
        input.prior,
        input.declaration.sharedCaches.includes(key),
      );
      const attached = container.mounts.filter(
        (m) => m.Type === "volume" && m.Destination === mount.target,
      );
      if (attached.length !== 1 || attached[0].Source !== volume.Mountpoint)
        throw new Error("Fresh-bootstrap data volume is not attached to its exact owner.");
      if (seen.has(key)) continue;
      if (names.has(name)) throw new Error("Fresh-bootstrap volume bindings alias each other.");
      seen.add(key);
      names.add(name);
      if (input.declaration.dataVolumes.includes(key))
        result.push({ key, name, createdAt: volume.CreatedAt, mountpoint: volume.Mountpoint });
    }
  }
  if (result.length !== input.declaration.dataVolumes.length)
    throw new Error("Fresh-bootstrap data-volume proof is incomplete.");
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

export function createFreshBootstrap(options: {
  identity: ReliabilityIdentity;
  workspace?: { token: string; gitCommonDir: string };
  plan: () => ManagedDevcontainerPlan;
  profile: string;
  variant: string;
  apps: string[];
  processes: string[];
  hostPortDeclarationsSha256?: string;
  onCaptured: (
    state: ManagedRuntimeState,
    container: { id: string; workspacePath: string },
  ) => void;
}): NonNullable<DevsyStartOptions["freshBootstrap"]> {
  const repoPath = options.identity.repoPath;
  return {
    prepare(providerId, network) {
      assertFreshBootstrapRequest(options.identity, { initializeNew: true });
      if (requireReadyDevsyAgent().version !== "1.19.0")
        throw new Error(
          "Fresh bootstrap is qualified for Devsy 1.19.0; ordinary startup is unchanged.",
        );
      const declaration = loadRepoConfig(repoPath).managedRuntime?.devcontainer.freshBootstrap;
      if (!declaration) throw new Error("Fresh-bootstrap declaration disappeared.");
      const plan = options.plan();
      for (const file of plan.composeFiles) {
        const source = YAML.parse(fs.readFileSync(file, "utf8"));
        if (source?.name !== undefined)
          throw new Error("Fresh bootstrap refuses an explicit shared Compose project name.");
        for (const [key, value] of Object.entries(source?.volumes ?? {})) {
          if (!declaration.sharedCaches.includes(key) && object(value) && value.name !== undefined)
            throw new Error(
              "Fresh bootstrap refuses fixed names for non-cache volumes before provider startup.",
            );
        }
      }
      const envFile = path.join(plan.composeDirectory, ".env");
      if (
        process.env.COMPOSE_PROJECT_NAME !== undefined ||
        (fs.existsSync(envFile) &&
          /^\s*(?:export\s+)?COMPOSE_PROJECT_NAME\s*=/m.test(fs.readFileSync(envFile, "utf8")))
      )
        throw new Error("Fresh bootstrap requires the provider's isolated project namespace.");
      const endpoint = network?.endpoint ?? resolveManagedStopEndpoint();
      if (!supportsManagedStopBaseline(endpoint))
        throw new Error("Fresh bootstrap requires a local Docker endpoint.");
      const evidence = inspectNetworkProviderBinding({
        provider: "devsy",
        providerId,
        repoPath,
        endpoint,
        ...(network ? { providerContext: network.providerContext } : {}),
      });
      const binding: NetworkProviderBinding = network ?? {
        provider: "devsy",
        providerId,
        endpoint,
        daemonId: evidence.daemonId,
        definitionSha256: evidence.definitionSha256,
        providerContext: evidence.providerContext,
      };
      assertNetworkProviderBinding(binding, evidence, true);
      const providerDirectory = path.join(
        process.env.DEVSY_HOME || path.join(os.homedir(), ".devsy"),
        "contexts",
        binding.providerContext,
        "workspaces",
        providerId,
      );
      try {
        fs.lstatSync(providerDirectory);
        throw new Error(
          "Fresh bootstrap refuses retained provider files, even without a registration.",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      assertNoCheckoutContainers(endpoint, repoPath);
      verifyFreshBootstrapMounts(
        repoPath,
        plan,
        render(endpoint, plan, "fresh-bootstrap-preflight", options.workspace),
        declaration,
        options.workspace,
      );
      const sourceSha256 = sourceIdentity(repoPath, plan);
      const prior = volumeSnapshot(endpoint);
      claimActiveFreshBootstrap({
        sourceSha256,
        providerId,
        providerContext: binding.providerContext,
        definitionSha256: binding.definitionSha256,
        endpoint,
        daemonId: binding.daemonId,
        previousVolumeNameDigests: prior,
      });
      return {
        binding,
        async afterStart(resumeSourceHooks) {
          const proof = captureDevsyExecProof(repoPath);
          if (
            proof.id !== providerId ||
            proof.endpoint !== endpoint ||
            proof.daemon !== binding.daemonId ||
            proof.context !== binding.providerContext
          )
            throw new Error("Fresh-bootstrap provider or daemon changed during provisioning.");
          const primary = workspaceAppContainers(inspectWorkspaceContainers(), repoPath).find(
            (c) => c.id === proof.containerId,
          );
          const project = primary?.labels["com.docker.compose.project"];
          if (!project) throw new Error("Fresh-bootstrap primary project is unavailable.");
          const state: ManagedRuntimeState = {
            version: 1,
            repoPath,
            ...(options.identity.workspace ? { workspace: options.identity.workspace } : {}),
            devpodId: providerId,
            composeProject: project,
            profile: options.profile,
            variant: options.variant,
            ...(options.hostPortDeclarationsSha256 !== undefined
              ? { hostPortDeclarationsSha256: options.hostPortDeclarationsSha256 }
              : {}),
            desired: {
              apps: [...options.apps].sort(),
              services: [...plan.desiredProfileServices].sort(),
              processes: [...options.processes].sort(),
            },
            sourceConfigSha256: plan.sourceConfigSha256,
            effectiveConfigSha256: plan.effectiveConfigSha256,
            status: "degraded",
            transitionPhase: "fresh-bootstrap",
            updatedAt: new Date().toISOString(),
          };
          state.stopBaseline = captureManagedStopBaseline(state, plan, proof.containerId, endpoint);
          claimLifecycleEffect();
          writeManagedRuntimeState(state);
          options.onCaptured(state, { id: proof.containerId, workspacePath: proof.workspacePath });
          const metadata: unknown = JSON.parse(
            docker(endpoint, [
              "inspect",
              "--format",
              '{{json (index .Config.Labels "devcontainer.metadata")}}',
              proof.containerId,
            ]),
          );
          if (typeof metadata === "string") {
            const entries: unknown = JSON.parse(metadata);
            if (!Array.isArray(entries) || entries.some((entry) => !object(entry)))
              throw new Error("Fresh-bootstrap image metadata is invalid.");
            for (const entry of entries) qualifiedContext(entry);
          } else if (metadata !== null)
            throw new Error("Fresh-bootstrap image metadata is unavailable.");
          const model = render(endpoint, plan, project, options.workspace);
          verifyFreshBootstrapMounts(repoPath, plan, model, declaration, options.workspace);
          const dataVolumes = proveVolumes({ endpoint, model, declaration, plan, project, prior });
          const resources = { primaryId: proof.containerId, project, dataVolumes };
          const revalidate = () => {
            if (
              sourceIdentity(repoPath, options.plan()) !== sourceSha256 ||
              inspectManagedStopDaemon(endpoint) !== binding.daemonId
            )
              throw new Error("Fresh-bootstrap source or daemon changed.");
            assertNetworkProviderBinding(
              binding,
              inspectNetworkProviderBinding({
                provider: "devsy",
                providerId,
                repoPath,
                endpoint,
                providerContext: binding.providerContext,
              }),
              false,
            );
            revalidateDevsyExecProof(repoPath, proof);
            proveRetainedManagedStop(state);
            if (
              !isDeepStrictEqual(
                proveVolumes({ endpoint, model, declaration, plan, project, prior }),
                dataVolumes,
              )
            )
              throw new Error("Fresh-bootstrap volume identity changed.");
          };
          revalidate();
          advanceActiveFreshBootstrap("provisioned", resources);
          reportLifecycleProgress("fresh-bootstrap");
          advanceActiveFreshBootstrap("initializing");
          const outcome = await new Promise<{ code: number | null; error?: boolean }>((resolve) => {
            revalidate();
            claimLifecycleEffect();
            const child = spawn(
              "devsy",
              [
                "workspace",
                "exec",
                "--result-format",
                "plain",
                "--context",
                binding.providerContext,
                providerId,
                "--",
                ...declaration.command,
              ],
              { stdio: "inherit", env: networkProviderEnvironment(binding, process.env) },
            );
            child.once("error", () => resolve({ code: null, error: true }));
            child.once("close", (code) => resolve({ code }));
          });
          if (outcome.error || outcome.code !== 0) {
            advanceActiveFreshBootstrap("failed");
            throw new Error(
              "Fresh initialization failed or completion is unknown; partial data and its attempt fence were retained. Initialization will not replay.",
            );
          }
          advanceActiveFreshBootstrap("initialized");
          revalidate();
          await resumeSourceHooks();
          revalidate();
          advanceActiveFreshBootstrap("ready");
        },
      };
    },
  };
}

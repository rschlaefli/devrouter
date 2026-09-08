import { createHash } from "node:crypto";
import path from "node:path";
import {
  captureControllerEvidence,
  controllerBindingFingerprint,
  readControllerEvidence,
  resolveControllerBinding,
} from "./controller-binding";
import {
  ControllerObservationBindingChanged,
  type ControllerObservationCollector,
  controllerCapability,
} from "./controller-monitor";
import { runControllerProbe } from "./controller-probe";
import { observeControllerProcess } from "./controller-process-observation";
import { parseDevcontainerConfig } from "./devcontainer-config";
import {
  MANAGED_DEVCONTAINER_PATH,
  managedComposeEnvironment,
  resolveComposeReference,
} from "./devcontainer-profile";
import {
  hasExactComposeIdentity,
  SAFE_INSPECT_TEMPLATE,
  type WorkspaceContainerSnapshot,
  workspaceAppContainers,
} from "./devpod-environment";
import { parseUpstream, readHostRouteStateReadOnly } from "./host-routes";
import { probeHttpReadiness } from "./http-route-probe";
import { managedRuntimeStatePath, readManagedRuntimeState } from "./managed-runtime-state";
import { assertPathWithinRepo } from "./paths";
import { buildProfileResolutionReport } from "./profile-resolution";
import type { ReliabilityObservation } from "./reliability-contract";
import { readReliabilityOperation } from "./reliability-operation-store";
import { applyWorkspace, loadRepoConfig } from "./repo-config";
import { isTLSEnabled } from "./router";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readRoutes() {
  return readHostRouteStateReadOnly((file) => readControllerEvidence(file, 1_048_576));
}

type ObservedContainer = WorkspaceContainerSnapshot & {
  state: WorkspaceContainerSnapshot["state"] & {
    Status: string;
    Paused: boolean;
    Restarting: boolean;
    Dead: boolean;
    StartedAt: string;
  };
};

const OBSERVATION_INSPECT_TEMPLATE = SAFE_INSPECT_TEMPLATE.replace(
  '"Running":{{json .State.Running}}',
  '"Running":{{json .State.Running}},"Status":{{json .State.Status}},"Paused":{{json .State.Paused}},"Restarting":{{json .State.Restarting}},"Dead":{{json .State.Dead}},"StartedAt":{{json .State.StartedAt}}',
);

async function containers(project: string, signal: AbortSignal): Promise<ObservedContainer[]> {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(project))
    throw new Error("Observation project is invalid.");
  const listed = await runControllerProbe(
    "docker",
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.ID}}",
    ],
    signal,
  );
  const ids = listed.trim() ? listed.trim().split(/\r?\n/).sort() : [];
  if (
    ids.length > 128 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-f0-9]{64}$/.test(id))
  )
    throw new Error("Observation container population is invalid.");
  if (!ids.length) return [];
  const output = await runControllerProbe(
    "docker",
    ["inspect", "--format", OBSERVATION_INSPECT_TEMPLATE, ...ids],
    signal,
  );
  const values = output
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as ObservedContainer);
  if (values.length !== ids.length || new Set(values.map((value) => value.id)).size !== ids.length)
    throw new Error("Observation container population changed.");
  for (const value of values) {
    if (
      !ids.includes(value.id) ||
      typeof value.state?.Running !== "boolean" ||
      typeof value.state.Status !== "string" ||
      typeof value.state.Paused !== "boolean" ||
      typeof value.state.Restarting !== "boolean" ||
      typeof value.state.Dead !== "boolean" ||
      typeof value.state.StartedAt !== "string" ||
      !Number.isFinite(Date.parse(value.state.StartedAt)) ||
      value.labels?.["com.docker.compose.project"] !== project ||
      !Array.isArray(value.mounts) ||
      !value.networks ||
      typeof value.networks !== "object"
    )
      throw new Error("Observation container identity is unavailable.");
  }
  return values.sort((a, b) => a.id.localeCompare(b.id));
}

/** Provider observations are bounded and read-only; only the caller publishes. */
export const collectControllerObservation: ControllerObservationCollector = async (
  environment,
  requirements,
  signal,
) => {
  const request = {
    path: environment.repoPath,
    profile: environment.profile,
    require: requirements,
  };
  const binding = await resolveControllerBinding(request, signal);
  if (JSON.stringify(binding) !== JSON.stringify(environment))
    throw new ControllerObservationBindingChanged("Observation binding changed.");
  const metadata = (
    await runControllerProbe(
      "git",
      [
        "-C",
        environment.repoPath,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ],
      signal,
    )
  )
    .trim()
    .split("\n");
  if (metadata.length !== 2) throw new Error("Observation ownership paths unavailable.");
  const [gitDir, commonDir] = metadata;
  const sourcePath = path.join(environment.repoPath, ".devcontainer/devcontainer.json");
  const files = [
    path.join(commonDir, "devrouter/workspaces", `${environment.workspace}.json`),
    path.join(environment.repoPath, ".devrouter.yml"),
    path.join(gitDir, "devrouter-workspace"),
    managedRuntimeStatePath(environment.repoPath, environment.workspace),
    sourcePath,
    path.join(environment.repoPath, MANAGED_DEVCONTAINER_PATH),
  ];
  const persisted = captureControllerEvidence(files);
  if (
    controllerBindingFingerprint(persisted.contents[0], persisted.contents[1]) !==
    environment.fingerprint
  )
    throw new ControllerObservationBindingChanged("Observation configuration changed.");
  const config = loadRepoConfig(environment.repoPath, () => persisted.contents[1]);
  const profile = buildProfileResolutionReport(config, environment.repoPath, environment.profile);
  const runtimeConfig = applyWorkspace(config, environment.workspace, environment.repoPath);
  const state = readManagedRuntimeState(
    environment.repoPath,
    environment.workspace,
    () => persisted.contents[3],
  );
  const source = parseDevcontainerConfig(persisted.contents[4], sourcePath);
  if (
    !state ||
    state.devpodId !== environment.providerId ||
    state.profile !== environment.profile ||
    typeof source.service !== "string" ||
    !source.service ||
    createHash("sha256").update(persisted.contents[4]).digest("hex") !== state.sourceConfigSha256 ||
    createHash("sha256").update(persisted.contents[5]).digest("hex") !== state.effectiveConfigSha256
  )
    throw new ControllerObservationBindingChanged("Observation retained configuration changed.");
  const identity = {
    repoPath: environment.repoPath,
    workspace: environment.workspace,
    provider: environment.provider,
  };
  const journal = readReliabilityOperation(identity);
  if (!journal) throw new Error("Observation journal is unavailable.");
  const routes = readRoutes().filter((route) => route.repoPath === environment.repoPath);
  const before = await containers(state.composeProject, signal);
  const composeDirectory = path.join(environment.repoPath, ".devcontainer");
  const references =
    typeof source.dockerComposeFile === "string"
      ? [source.dockerComposeFile]
      : source.dockerComposeFile;
  if (
    !Array.isArray(references) ||
    !references.length ||
    references.some((value) => typeof value !== "string")
  )
    throw new Error("Observation Compose source is unavailable.");
  const composeFiles = references.map((value) =>
    assertPathWithinRepo(
      resolveComposeReference(value, true),
      composeDirectory,
      "dockerComposeFile",
    ),
  );
  const recordedFiles = new Set(composeFiles);
  for (const container of before) {
    const recorded = container.labels["com.docker.compose.project.config_files"];
    if (
      !recorded ||
      container.labels["com.docker.compose.project.working_dir"] !== composeDirectory
    )
      throw new Error("Observation Compose ownership is unavailable.");
    const files = recorded.split(",").map((file) => file.trim());
    if (
      files.some((file) => !path.isAbsolute(file)) ||
      !hasExactComposeIdentity(container, {
        repoPath: environment.repoPath,
        service: container.labels["com.docker.compose.service"] ?? "",
        composeProject: state.composeProject,
        composeFiles,
      })
    )
      throw new Error("Observation Compose membership changed.");
    for (const file of files) recordedFiles.add(file);
  }
  const composeEvidence = captureControllerEvidence([...recordedFiles]);
  const verifyCompose = async () => {
    for (const container of before.filter((value) => value.state.Running)) {
      const service = container.labels["com.docker.compose.service"];
      const expectedHash = container.labels["com.docker.compose.config-hash"];
      if (
        !service ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service) ||
        !expectedHash ||
        !/^[a-f0-9]{64}$/.test(expectedHash)
      )
        throw new Error("Observation Compose hash is unavailable.");
      const files =
        container.labels["com.docker.compose.project.config_files"]
          ?.split(",")
          .map((file) => file.trim()) ?? [];
      const args = [
        "compose",
        "--project-name",
        state.composeProject,
        "--project-directory",
        composeDirectory,
      ];
      const options = {
        cwd: composeDirectory,
        env: managedComposeEnvironment({ token: environment.workspace, gitCommonDir: commonDir }),
      };
      // Resolved configuration can contain secrets. Keep it transient and never
      // include it in observation records, diagnostics, or temporary files.
      const rendered = await runControllerProbe(
        "docker",
        [...args, ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"],
        signal,
        options,
      );
      const hash = await runControllerProbe(
        "docker",
        [...args, "-f", "-", "config", "--no-interpolate", "--hash", service],
        signal,
        { ...options, input: rendered },
      );
      if (hash.trim() !== `${service} ${expectedHash}`)
        throw new ControllerObservationBindingChanged("Observation Compose configuration changed.");
    }
  };
  await verifyCompose();
  const primary = workspaceAppContainers(before, environment.repoPath).filter(
    (container) => container.labels["com.docker.compose.service"] === source.service,
  );
  const stopped =
    before.every(
      (container) =>
        !container.state.Running &&
        !container.state.Paused &&
        !container.state.Restarting &&
        !container.state.Dead &&
        ["exited", "created"].includes(container.state.Status),
    ) && routes.length === 0;
  const expected = [...new Set([source.service, ...profile.managedRuntime.services])];
  const population = expected.every(
    (service) =>
      before.filter((container) => container.labels["com.docker.compose.service"] === service)
        .length === 1,
  );
  const healthy =
    population &&
    before.every(
      (container) =>
        !container.state.Running ||
        expected.includes(container.labels["com.docker.compose.service"] ?? ""),
    ) &&
    primary.length === 1 &&
    primary[0].state.Running &&
    expected.every((service) => {
      const container = before.find(
        (value) => value.labels["com.docker.compose.service"] === service,
      );
      return (
        !!container &&
        container.state.Running &&
        container.state.Status === "running" &&
        !container.state.Paused &&
        !container.state.Restarting &&
        !container.state.Dead &&
        (!container.state.Health || container.state.Health.Status === "healthy")
      );
    });
  const capabilities: ReliabilityObservation[] = [
    {
      capability: "runtime",
      infrastructure: healthy ? "healthy" : "unknown",
      application: healthy ? "verified" : "unverified",
      observedAtMs: 0,
      validForMs: 15000,
    },
  ];
  const processes: string[] = [];
  let processesVerified = healthy;
  if (healthy && requirements.some((value) => value.startsWith("app:"))) {
    try {
      for (const name of profile.managedRuntime.processes)
        processes.push(await observeControllerProcess(primary[0].id, name, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      processesVerified = false;
    }
  }
  for (const requirement of requirements.filter((value) => value.startsWith("app:"))) {
    const app = runtimeConfig.apps.find((value) => value.name === requirement.slice(4));
    if (
      !app ||
      app.kind === "dependency" ||
      app.runtime !== "proxy" ||
      app.protocol !== "http" ||
      !app.readiness
    )
      throw new ControllerObservationBindingChanged("Observation application contract changed.");
    const upstream = parseUpstream(app.upstream);
    const routeMatches = routes.some(
      (route) =>
        route.workspace === environment.workspace &&
        route.name === app.name &&
        route.host === app.host &&
        route.mode === "proxy" &&
        route.upstreamHost === upstream.upstreamHost &&
        route.port === upstream.port,
    );
    const http =
      healthy && routeMatches && processesVerified
        ? await probeHttpReadiness(
            app.host,
            app.readiness,
            signal,
            runControllerProbe,
            isTLSEnabled(readControllerEvidence),
          )
        : undefined;
    capabilities.push({
      capability: controllerCapability(requirement),
      infrastructure: healthy && routeMatches ? "healthy" : "unknown",
      application: http?.ok
        ? "verified"
        : http?.classification === "application-contract"
          ? "unready"
          : "unverified",
      observedAtMs: 0,
      validForMs: 15000,
    });
  }
  if (processesVerified && requirements.some((value) => value.startsWith("app:"))) {
    try {
      for (let index = 0; index < profile.managedRuntime.processes.length; index++)
        if (
          processes[index] !==
          (await observeControllerProcess(
            primary[0].id,
            profile.managedRuntime.processes[index],
            signal,
          ))
        )
          throw new Error("Observation process changed.");
    } catch (error) {
      if (signal.aborted) throw error;
      for (const capability of capabilities)
        if (capability.capability !== "runtime") capability.application = "unverified";
    }
  }
  if (digest(before) !== digest(await containers(state.composeProject, signal)))
    throw new Error("Observation runtime changed.");
  await verifyCompose();
  if (
    JSON.stringify(await resolveControllerBinding(request, signal)) !== JSON.stringify(environment)
  )
    throw new ControllerObservationBindingChanged("Observation ownership changed.");
  const routeFingerprint = digest(routes);
  return {
    environment,
    identity,
    journal,
    sampledAtMs: Math.floor(performance.now()),
    runtimeFingerprint: digest({ before, processes }),
    capabilities,
    stopped,
    revalidatePersisted: () =>
      persisted.unchanged() &&
      composeEvidence.unchanged() &&
      routeFingerprint ===
        digest(readRoutes().filter((route) => route.repoPath === environment.repoPath)),
  };
};

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inspectManagedStopDaemon } from "./devpod-environment";
import type { NetworkProviderBindingEvidence } from "./network-provider-binding";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider evidence.");
  return value as Record<string, unknown>;
}

export function qualifyNetworkProviderDefinition(
  value: unknown,
  provider: "devsy" | "devpod",
): string {
  const definition = object(value);
  const agent = object(definition.agent);
  const docker = object(agent.docker);
  const env = object(docker.env);
  const options = object(definition.options);
  const host = object(options.DOCKER_HOST);
  const dockerPath = object(options.DOCKER_PATH);
  const exec = object(definition.exec);
  const command =
    provider === "devsy"
      ? '"${DEVSY}" internal sh -c "${COMMAND}"'
      : '"${DEVPOD}" helper sh -c "${COMMAND}"';
  const actualCommand = Array.isArray(exec.command) ? exec.command : [exec.command];
  if (
    definition.name !== "docker" ||
    ![true, "true"].includes(agent.local as boolean) ||
    (agent.driver !== undefined && agent.driver !== "docker" && agent.driver !== "") ||
    docker.path !== "${DOCKER_PATH}" ||
    docker.builder !== "${DOCKER_BUILDER}" ||
    ![false, "false"].includes(docker.install as boolean) ||
    (provider === "devsy"
      ? docker.elevation !== "${DOCKER_ELEVATION}"
      : docker.elevation !== undefined && docker.elevation !== "") ||
    env.DOCKER_HOST !== "${DOCKER_HOST}" ||
    Object.keys(env).some((key) => key !== "DOCKER_HOST") ||
    host.global !== true ||
    dockerPath.default !== "docker" ||
    actualCommand.length !== 1 ||
    typeof actualCommand[0] !== "string" ||
    actualCommand[0].trim() !== command ||
    Object.keys(exec).some((key) => key !== "command") ||
    (agent.path !== undefined && agent.path !== "") ||
    (agent.downloadURL !== undefined && agent.downloadURL !== "")
  ) {
    throw new Error("Docker provider definition is not qualified for network allocation.");
  }
  return createHash("sha256")
    .update(JSON.stringify({ name: definition.name, agent, options, exec }))
    .digest("hex");
}

function read(provider: "devsy" | "devpod", args: string[]): string {
  const result = spawnSync(provider, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error("Network provider evidence is unavailable.");
  return result.stdout;
}

export function inspectNetworkProviderBinding(input: {
  provider: "devsy" | "devpod";
  providerId: string;
  repoPath: string;
  endpoint?: string;
  providerContext?: string;
}): NetworkProviderBindingEvidence {
  try {
    const { provider, providerId, repoPath } = input;
    const contexts: unknown = JSON.parse(
      read(provider, [
        "context",
        "list",
        ...(provider === "devsy" ? ["--result-format", "json"] : ["--output", "json"]),
      ]),
    );
    if (!Array.isArray(contexts) || contexts.length > 128) throw new Error();
    const selected = contexts
      .map(object)
      .filter((row) =>
        input.providerContext ? row.name === input.providerContext : row.default === true,
      );
    if (selected.length !== 1 || typeof selected[0].name !== "string") throw new Error();
    const providerContext = selected[0].name;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(providerContext)) throw new Error();
    const contextArgs = ["--context", providerContext];
    const version = read(provider, provider === "devsy" ? ["--version"] : ["version"]);
    const expectedVersion = provider === "devsy" ? "1.16.2" : "0.6.15";
    if (version.match(/\b(?:v)?(\d+\.\d+\.\d+)\b/)?.[1] !== expectedVersion) throw new Error();
    const definitions = object(
      JSON.parse(
        read(
          provider,
          provider === "devsy"
            ? ["provider", "list", "--result-format", "json", ...contextArgs]
            : ["provider", "list", "--output", "json", ...contextArgs],
        ),
      ),
    );
    const entry = object(definitions.docker);
    const definitionSha256 = qualifyNetworkProviderDefinition(entry.config, provider);
    const rows: unknown = JSON.parse(
      read(
        provider,
        provider === "devsy"
          ? ["workspace", "list", "--result-format", "json", "--skip-pro", ...contextArgs]
          : ["list", "--output", "json", "--skip-pro", ...contextArgs],
      ),
    );
    if (!Array.isArray(rows) || rows.length > 4096) throw new Error();
    const matching = rows
      .map(object)
      .filter((row) => row.id === providerId || object(row.source).localFolder === repoPath);
    if (matching.length > 1) throw new Error();
    const workspace = matching[0];
    if (
      workspace &&
      (workspace.id !== providerId || object(workspace.source).localFolder !== repoPath)
    )
      throw new Error();
    const workspaceProvider = workspace ? object(workspace.provider) : undefined;
    const state = object(entry.state);
    const settings = object(state.options ?? {});
    const stored = workspaceProvider ? object(workspaceProvider.options ?? {}) : {};
    const option = (key: string, localOnly = false): string | null => {
      const value = localOnly ? stored[key] : (stored[key] ?? settings[key]);
      if (value === undefined) return null;
      const text = object(value).value;
      if (typeof text !== "string") throw new Error();
      return text || null;
    };
    if (workspaceProvider && workspaceProvider.name !== "docker") throw new Error();
    if (option("DOCKER_ELEVATION") && option("DOCKER_ELEVATION") !== "none") throw new Error();
    // Without an allocation binding, only an explicitly configured provider
    // endpoint identifies the diagnostic target. Ambient Docker selectors do not.
    const endpoint = input.endpoint ?? option("DOCKER_HOST");
    if (
      !endpoint ||
      (!input.endpoint &&
        (process.env.DOCKER_CONTEXT ||
          option("DOCKER_CONTEXT") ||
          (option("DOCKER_PATH") ?? "docker") !== "docker" ||
          (!workspace && entry.default !== true)))
    )
      throw new Error();
    return {
      provider,
      providerContext,
      providerId,
      endpoint,
      daemonId: inspectManagedStopDaemon(endpoint),
      versionQualified: true,
      definitionSha256,
      providerName: "docker",
      dockerPath: option("DOCKER_PATH") ?? "docker",
      persistedEndpoint: workspace ? option("DOCKER_HOST", true) : null,
      persistedContext: option("DOCKER_CONTEXT"),
      registration: workspace ? "owned" : "absent",
    };
  } catch {
    throw new Error(
      "Network provider destination could not be qualified; no allocation is permitted.",
    );
  }
}

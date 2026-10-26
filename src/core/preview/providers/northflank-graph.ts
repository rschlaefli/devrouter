import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { PreviewPoolEntry } from "../state";

type NorthflankValueBinding =
  | { literal: string }
  | { generation: true }
  | { service: string; port: string; path?: string; format: "host" | "authority" | "http-url" }
  | { origin: string; port: string; path?: string; format?: "url" | "hostname" };

export type NorthflankBinding =
  | NorthflankValueBinding
  | { addon: string; key: string }
  | { runtimeSecret: string }
  | { generated: string }
  | { output: string };

export type NorthflankResourceSettings = {
  deploymentPlan: string;
  buildPlan?: string;
  addonVersion?: string;
  storageMiB?: number;
  environment?: Record<string, NorthflankBinding>;
  publicBuildEnvironment?: Record<
    string,
    NorthflankValueBinding | { json: Record<string, NorthflankValueBinding> }
  >;
  portProtocols?: Record<string, "HTTP" | "TCP" | "UDP">;
  readiness?: { port: string; path: string } | { command: string[] };
  mount?: { service: string; path: string };
  runOn?: "create" | "update";
};

export type NorthflankGraphPolicy = {
  namespace: string;
  baseDomain: string;
  allowedNetworks: string[];
  git?: {
    url: string;
    type: "github" | "gitlab" | "self-hosted";
    branch: string;
    selfHostedVcsId?: string;
  };
  resources: Record<string, NorthflankResourceSettings>;
  generated?: Record<string, { bytes: number; encoding: "hex" | "base64url" }>;
  outputs?: Record<
    string,
    {
      service: string;
      command: string[];
      pattern: string;
      maxBytes: number;
    }
  >;
};

type SensitiveBinding = { runtimeSecret: string } | { generated: string } | { output: string };

type Node = {
  kind: string;
  ref?: string;
  spec: Record<string, unknown>;
  updateMode?: "create" | "put";
  condition?: "success";
  runNodeOnce?: "true";
};

type RefNamespace = "r" | "b" | "e" | "d";
const ALLOCATION_PLAN = /^[a-zA-Z0-9-]{3,100}$/;
const SOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SOURCE_NAMES = 32;
const MAX_OUTPUTS = 16;
const MAX_SECRET_GROUPS = 32;
const MAX_OUTPUT_ARGUMENTS = 32;
const MAX_OUTPUT_ARGUMENT_BYTES = 4096;
const MAX_OUTPUT_COMMAND_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 8000;
const MAX_PATTERN_BYTES = 128;
const boundedStorage = (miB?: number) => Number.isSafeInteger(miB) && (miB ?? 0) >= 1024;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Northflank policy object.");
  return value as Record<string, unknown>;
}
function hasFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    fields.every((field) => required.includes(field) || optional.includes(field))
  );
}
type BindingKind =
  | "literal"
  | "generation"
  | "origin"
  | "service"
  | "addon"
  | "runtimeSecret"
  | "generated"
  | "output";
function bindingKind(value: unknown): BindingKind {
  if (hasFields(value, ["literal"])) return "literal";
  if (hasFields(value, ["generation"])) return "generation";
  if (hasFields(value, ["origin", "port"], ["path", "format"])) return "origin";
  if (hasFields(value, ["service", "port", "format"], ["path"])) return "service";
  if (hasFields(value, ["addon", "key"])) return "addon";
  if (hasFields(value, ["runtimeSecret"])) return "runtimeSecret";
  if (hasFields(value, ["generated"])) return "generated";
  if (hasFields(value, ["output"])) return "output";
  throw new Error("Invalid Northflank binding discriminant.");
}
function validateSourceName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length > 48 || !SOURCE_NAME.test(name))
    throw new Error("Invalid Northflank generated or output name.");
}
function validateRuntimeSecret(name: unknown): asserts name is string {
  if (typeof name !== "string" || !SOURCE_NAME.test(name))
    throw new Error("Invalid runtime secret reference.");
}
function validateCommand(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_OUTPUT_ARGUMENTS)
    throw new Error("Invalid Northflank output command.");
  let total = 0;
  for (const [index, argument] of argv.entries()) {
    if (
      typeof argument !== "string" ||
      (index === 0 && argument.length === 0) ||
      argument.includes("\0")
    )
      throw new Error("Invalid Northflank output command.");
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_OUTPUT_ARGUMENT_BYTES) throw new Error("Invalid Northflank output command.");
    total += bytes;
  }
  if (total > MAX_OUTPUT_COMMAND_BYTES) throw new Error("Invalid Northflank output command.");
}
function safeCharacterClass(value: string): boolean {
  const ranges = new Set(["A-Z", "a-z", "0-9", "A-F", "a-f"]);
  for (let index = 0; index < value.length; ) {
    if (ranges.has(value.slice(index, index + 3))) {
      index += 3;
      continue;
    }
    const character = value.charAt(index);
    if (/[A-Za-z0-9._+/=]/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && index === value.length - 1) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}
function validatePattern(pattern: unknown, maxBytes: number): asserts pattern is string {
  if (typeof pattern !== "string" || pattern.length > MAX_PATTERN_BYTES)
    throw new Error("Invalid Northflank output pattern.");
  const match = /^\^\[([A-Za-z0-9._+\-/=]+)\]\{([0-9]{1,4})(?:,([0-9]{1,4}))?\}\$$/.exec(pattern);
  if (!match || !safeCharacterClass(match[1]))
    throw new Error("Invalid Northflank output pattern.");
  const minimum = Number(match[2]);
  const maximum = Number(match[3] ?? match[2]);
  if (minimum < 1 || maximum < minimum || maximum > maxBytes)
    throw new Error("Invalid Northflank output pattern.");
}
function refName(id: string, namespace: RefNamespace = "r"): string {
  return `${namespace}_${id.replaceAll("-", "_")}`;
}
function ref(id: string, namespace: RefNamespace = "r"): string {
  return `\${refs.${refName(id, namespace)}.id}`;
}
function node(
  kind: string,
  id: string,
  spec: Record<string, unknown>,
  updateMode: "create" | "put" = "put",
  namespace: RefNamespace = "r",
): Node & { ref: string } {
  return {
    kind,
    ref: refName(id, namespace),
    spec,
    ...(kind === "Subdomain" ? {} : { updateMode }),
  };
}
function staticText(value: string): string {
  if (value.includes("${") || value.includes("\0"))
    throw new Error("Northflank literal cannot contain template expressions or NUL.");
  return value;
}
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function northflankAllocationPrefix(
  policy: NorthflankGraphPolicy,
  generation: string,
): string {
  return `${policy.namespace.slice(0, 6)}-${generation.slice(0, 12)}-`;
}

export function compileNorthflankGraph(
  entry: PreviewPoolEntry,
  policy: NorthflankGraphPolicy,
  phase: "prepare" | "source" | "activate",
  owned: { resources: Record<string, string>; domains: string[] } = { resources: {}, domains: [] },
) {
  const source = entry.plan.source;
  if (
    !/^[a-z][a-z0-9-]{0,11}$/.test(policy.namespace) ||
    !/^[a-f0-9]{24}$/.test(entry.session.generation) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source?.head ?? "") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(policy.baseDomain) ||
    policy.baseDomain.length > 190 ||
    entry.plan.status !== "planned" ||
    !source?.complete ||
    source.head !== entry.session.desiredRevision ||
    entry.plan.resources.length > 64
  )
    throw new Error("Invalid Northflank graph identity or bound.");
  if (
    !policy.allowedNetworks.length ||
    policy.allowedNetworks.some((network) => {
      const [address, prefix, extra] = network.split("/");
      return (
        extra !== undefined ||
        isIP(address) !== 4 ||
        (prefix !== undefined &&
          (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > 32))
      );
    })
  )
    throw new Error("Northflank graph requires a restricted IPv4 source-network policy.");
  const prefix = `${policy.namespace}-${entry.session.generation.slice(0, 12)}`;
  const resources = new Map(entry.plan.resources.map((resource) => [resource.id, resource]));
  const seen = new Set<string>();
  for (const resource of entry.plan.resources) {
    if (seen.has(resource.id) || resource.dependsOn?.some((id) => !seen.has(id)))
      throw new Error("Northflank graph requires a complete dependency-ordered resource plan.");
    seen.add(resource.id);
  }
  const generated = record(policy.generated ?? {});
  const outputs = record(policy.outputs ?? {});
  if (
    Object.keys(generated).length + Object.keys(outputs).length > MAX_SOURCE_NAMES ||
    Object.keys(outputs).length > MAX_OUTPUTS
  )
    throw new Error("Northflank generated and output policy exceeds its bound.");
  const generatedNames = new Set<string>();
  for (const [name, definition] of Object.entries(generated)) {
    validateSourceName(name);
    if (!hasFields(definition, ["bytes", "encoding"]))
      throw new Error("Invalid Northflank generated secret definition.");
    if (
      !Number.isSafeInteger(definition.bytes) ||
      (definition.bytes as number) < 16 ||
      (definition.bytes as number) > 64 ||
      !["hex", "base64url"].includes(definition.encoding as string)
    )
      throw new Error("Invalid Northflank generated secret definition.");
    generatedNames.add(name);
  }
  const outputSources = new Map<string, string>();
  const outputServices = new Set<string>();
  for (const [name, definition] of Object.entries(outputs)) {
    validateSourceName(name);
    if (!hasFields(definition, ["service", "command", "pattern", "maxBytes"]))
      throw new Error("Invalid Northflank output definition.");
    if (
      typeof definition.service !== "string" ||
      !SOURCE_NAME.test(definition.service) ||
      definition.service.length > 63 ||
      !Number.isSafeInteger(definition.maxBytes) ||
      (definition.maxBytes as number) < 1 ||
      (definition.maxBytes as number) > MAX_OUTPUT_BYTES
    )
      throw new Error("Invalid Northflank output definition.");
    validateCommand(definition.command);
    validatePattern(definition.pattern, definition.maxBytes as number);
    outputSources.set(name, definition.service);
  }
  let secretGroups = 0;
  for (const resource of entry.plan.resources) {
    const settings = policy.resources[resource.id];
    if (!settings) continue;
    if (settings.environment !== undefined) {
      const environment = record(settings.environment);
      if (
        ["service", "job"].includes(resource.kind) &&
        Object.keys(environment).length &&
        ++secretGroups > MAX_SECRET_GROUPS
      )
        throw new Error("Northflank graph exceeds its secret-group bound.");
      for (const [key, binding] of Object.entries(environment)) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) throw new Error("Invalid runtime binding key.");
        const kind = bindingKind(binding);
        if (kind === "generated") {
          if (!generatedNames.has((binding as { generated: string }).generated))
            throw new Error("Northflank generated binding is undeclared.");
        } else if (kind === "output") {
          const service = outputSources.get((binding as { output: string }).output);
          if (!service) throw new Error("Northflank output binding is undeclared.");
          outputServices.add(service);
        } else if (kind === "runtimeSecret")
          validateRuntimeSecret((binding as { runtimeSecret: unknown }).runtimeSecret);
      }
    }
    if (settings.publicBuildEnvironment !== undefined) {
      const publicBuild = record(settings.publicBuildEnvironment);
      for (const binding of Object.values(publicBuild)) {
        const values = hasFields(binding, ["json"])
          ? Object.values(record(binding.json))
          : [binding];
        for (const value of values) {
          const kind = bindingKind(value);
          if (!["literal", "generation", "origin", "service"].includes(kind))
            throw new Error("Northflank build bindings must contain public values only.");
        }
      }
    }
  }
  for (const service of outputServices)
    if (resources.get(service)?.kind !== "service")
      throw new Error("Northflank output sources require selected services.");
  const sourceClosure = new Set<string>();
  const visitSource = (id: string) => {
    if (sourceClosure.has(id)) return;
    const resource = resources.get(id);
    if (!resource) throw new Error("Northflank output source closure is incomplete.");
    for (const dependency of resource.dependsOn ?? []) visitSource(dependency);
    sourceClosure.add(id);
  };
  for (const service of outputServices) visitSource(service);
  const sourceResources = entry.plan.resources
    .filter((resource) => sourceClosure.has(resource.id))
    .map((resource) => resource.id);
  for (const id of sourceResources) {
    const settings = policy.resources[id];
    if (!settings) throw new Error("Northflank source recipe is missing.");
    for (const binding of Object.values(record(settings.environment ?? {}))) {
      const kind = bindingKind(binding);
      if (kind === "output") throw new Error("Northflank output binding is not source-safe.");
      if (kind === "service" && !sourceClosure.has((binding as { service: string }).service))
        throw new Error("Northflank source closure has an external private binding.");
    }
    for (const binding of Object.values(record(settings.publicBuildEnvironment ?? {}))) {
      const values = hasFields(binding, ["json"]) ? Object.values(record(binding.json)) : [binding];
      for (const value of values) {
        if (
          bindingKind(value) === "service" &&
          !sourceClosure.has((value as { service: string }).service)
        )
          throw new Error("Northflank source closure has an external private binding.");
      }
    }
  }
  for (const nativeId of Object.values(owned.resources)) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(nativeId))
      throw new Error("Invalid owned Northflank resource identifier.");
  }
  if (
    (phase === "source" || phase === "activate") &&
    entry.plan.resources.some((resource) => !owned.resources[refName(resource.id)])
  )
    throw new Error(
      "Northflank activation requires observed ownership for every selected resource.",
    );
  const reference = (id: string, namespace: RefNamespace = "r") =>
    owned.resources[refName(id, namespace)] ?? ref(id, namespace);
  const origin = (id: string, port: string) => {
    const resource = resources.get(id);
    if (!resource?.ports?.some((item) => item.name === port && item.public))
      throw new Error("Northflank origin binding requires a selected public port.");
    return `https://${prefix}--${id.slice(0, 16)}-${port}-${createHash("sha256").update(id).digest("hex").slice(0, 6)}.${policy.baseDomain}`;
  };
  const resourceName = (id: string) =>
    `${northflankAllocationPrefix(policy, entry.session.generation)}${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
  const suffix = (value?: string) => {
    if (value === undefined) return "";
    if (
      typeof value !== "string" ||
      value.length > 1024 ||
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\") ||
      /\s|\p{Cc}/u.test(value)
    )
      throw new Error("Northflank endpoint path must be a bounded relative URL path.");
    return staticText(value);
  };
  const literal = (binding: NorthflankBinding): string => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding))
      throw new Error("Invalid Northflank binding.");
    if ("literal" in binding) {
      if (
        typeof binding.literal !== "string" ||
        binding.literal.length > 4096 ||
        binding.literal.includes("${")
      )
        throw new Error("Northflank literal binding cannot contain template expressions.");
      return staticText(binding.literal);
    }
    if ("generation" in binding && binding.generation === true) return entry.session.generation;
    if ("origin" in binding) {
      const url = origin(binding.origin, binding.port);
      if (binding.format !== undefined && !["url", "hostname"].includes(binding.format))
        throw new Error("Invalid Northflank origin format.");
      if (binding.format === "hostname") {
        if (binding.path !== undefined) throw new Error("A hostname binding cannot have a path.");
        return new URL(url).hostname;
      }
      return url + suffix(binding.path);
    }
    if ("service" in binding) {
      const service = resources.get(binding.service);
      const port = service?.ports?.find((item) => item.name === binding.port);
      if (
        service?.kind !== "service" ||
        !port ||
        !["host", "authority", "http-url"].includes(binding.format)
      )
        throw new Error("Northflank private binding requires a selected service port.");
      if (binding.format !== "http-url" && binding.path !== undefined)
        throw new Error("A private host or authority cannot have a path.");
      if (
        binding.format === "http-url" &&
        (policy.resources[binding.service]?.portProtocols?.[binding.port] ?? "HTTP") !== "HTTP"
      )
        throw new Error("A private HTTP URL requires an HTTP service port.");
      const host = resourceName(binding.service);
      const authority = `${host}:${port.port}`;
      return binding.format === "host"
        ? host
        : binding.format === "authority"
          ? authority
          : `http://${authority}${suffix(binding.path)}`;
    }
    throw new Error("Northflank build bindings must contain public values only.");
  };
  const buildValue = (
    binding: NorthflankValueBinding | { json: Record<string, NorthflankValueBinding> },
  ) => {
    if (!binding || typeof binding !== "object" || !("json" in binding)) return literal(binding);
    const fields = binding.json;
    if (
      !fields ||
      typeof fields !== "object" ||
      Array.isArray(fields) ||
      Object.keys(fields).length > 64
    )
      throw new Error("Northflank JSON build binding requires a bounded flat object.");
    const value = JSON.stringify(
      Object.fromEntries(
        Object.entries(fields).map(([key, item]) => {
          if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key))
            throw new Error("Invalid Northflank JSON build binding key.");
          return [key, literal(item)];
        }),
      ),
    );
    if (Buffer.byteLength(value) > 16 * 1024)
      throw new Error("Northflank JSON build binding exceeds its size bound.");
    return value;
  };
  const prepare: Node[] = [];
  const volumes: Node[] = [];
  const secretNodes: Node[] = [];
  const activations = new Map<string, Node[]>();
  const runtimeSecrets: Array<{ groupRef: string; variables: Record<string, string> }> = [];
  const secretBindings: Array<{
    groupRef: string;
    variables: Record<string, SensitiveBinding>;
  }> = [];
  const urls: Record<string, string> = {};
  const nativeNames = new Set<string>();
  for (const resource of entry.plan.resources) {
    const settings = policy.resources[resource.id];
    if (!settings || !ALLOCATION_PLAN.test(settings.deploymentPlan))
      throw new Error("Every selected resource requires a trusted allocation plan.");
    const name = resourceName(resource.id);
    if (nativeNames.has(name)) throw new Error("Northflank resource name collision.");
    nativeNames.add(name);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(resource.id))
      throw new Error("Invalid Northflank resource identifier.");
    const billing = { deploymentPlan: settings.deploymentPlan };
    if (resource.kind === "postgres" || resource.kind === "redis") {
      if (!settings.addonVersion || !boundedStorage(settings.storageMiB))
        throw new Error("Northflank addons require explicit version and bounded storage.");
      prepare.push(
        node(
          "Addon",
          resource.id,
          {
            name,
            type: resource.kind === "postgres" ? "postgresql" : "redis",
            version: settings.addonVersion,
            externalAccessEnabled: false,
            tlsEnabled: true,
            billing: { ...billing, storage: settings.storageMiB, replicas: 1 },
          },
          "create",
        ),
      );
      prepare.push({
        kind: "Condition",
        spec: {
          kind: "Addon",
          spec: {
            type: "running",
            data: { addonId: reference(resource.id), timeoutDuration: 600 },
          },
        },
      });
      continue;
    }
    if (resource.kind === "volume") {
      const mount = settings.mount;
      if (
        !mount ||
        resources.get(mount.service)?.kind !== "service" ||
        !mount.path.startsWith("/") ||
        mount.path.includes("..") ||
        !boundedStorage(settings.storageMiB)
      )
        throw new Error("Northflank volume requires a selected service mount and bounded storage.");
      volumes.push(
        node(
          "Volume",
          resource.id,
          {
            name,
            mounts: [{ containerMountPath: mount.path }],
            spec: { storageSize: settings.storageMiB },
            attachedObjects: [{ id: reference(mount.service), type: "service" }],
          },
          "create",
        ),
      );
      continue;
    }
    const deployment: Record<string, unknown> = resource.kind === "service" ? { instances: 0 } : {};
    if (resource.build) {
      const git = policy.git;
      if (
        !git ||
        !/^https:\/\/[^/@:]+\/[A-Za-z0-9_./-]+$/.test(git.url) ||
        git.url.includes("..") ||
        !settings.buildPlan ||
        !ALLOCATION_PLAN.test(settings.buildPlan)
      )
        throw new Error(
          "Northflank source builds require a trusted repository and build allocation.",
        );
      const buildId = resource.id;
      const buildArguments = Object.fromEntries(
        Object.entries(settings.publicBuildEnvironment ?? {}).map(([key, binding]) => [
          key,
          buildValue(binding),
        ]),
      );
      prepare.push(
        node(
          "BuildService",
          buildId,
          {
            name: `${name}-b`,
            disabledCI: true,
            billing: { buildPlan: settings.buildPlan },
            vcsData: {
              projectUrl: git.url,
              projectType: git.type,
              ...(git.selfHostedVcsId ? { selfHostedVcsId: git.selfHostedVcsId } : {}),
            },
            buildSettings: {
              dockerfile: {
                buildEngine: "buildkit",
                dockerFilePath: `/${staticText(resource.build.dockerfile)}`,
                dockerWorkDir:
                  resource.build.context === "." ? "/" : `/${staticText(resource.build.context)}`,
              },
            },
            buildArguments,
          },
          "put",
          "b",
        ),
      );
      prepare.push({
        kind: "Build",
        ref: `build_${resource.id.replaceAll("-", "_")}_${source.head.slice(0, 12)}`,
        condition: "success",
        spec: {
          id: reference(buildId, "b"),
          type: "service",
          sha: source.head,
          branch: git.branch,
          reuseExistingBuilds: true,
          ...(resource.build.target
            ? {
                buildOverrides: { docker: { dockerfileTarget: staticText(resource.build.target) } },
              }
            : {}),
        },
      });
      deployment.internal = {
        id: reference(buildId, "b"),
        buildSHA: source.head,
        branch: git.branch,
      };
    } else {
      if (!resource.image?.includes("@sha256:"))
        throw new Error("Northflank image recipes require immutable image digests.");
      deployment.external = { imagePath: resource.image };
    }
    if (resource.command)
      deployment.docker = {
        configType: "customEntrypointCustomCommand",
        customEntrypoint: shellWord(staticText(resource.command[0])),
        customCommand: resource.command
          .slice(1)
          .map((arg) => shellWord(staticText(arg)))
          .join(" "),
      };
    if (resource.kind === "job" && resource.ports?.length)
      throw new Error("Northflank jobs cannot expose ports.");
    if (
      Object.keys(settings.portProtocols ?? {}).some(
        (name) => !resource.ports?.some((port) => port.name === name),
      )
    )
      throw new Error("Northflank protocol overrides require a selected port.");
    const ports = (resource.ports ?? []).map((port) => {
      if (port.name.length > 8)
        throw new Error("Northflank port names support at most eight characters.");
      const protocol = settings.portProtocols?.[port.name] ?? "HTTP";
      if (!["HTTP", "TCP", "UDP"].includes(protocol) || (port.public && protocol !== "HTTP"))
        throw new Error("Northflank non-HTTP service ports must remain private.");
      const domains = port.public ? [new URL(origin(resource.id, port.name)).hostname] : [];
      if (port.public) {
        const hostname = domains[0];
        if (!owned.domains.includes(hostname))
          prepare.push(
            node(
              "Subdomain",
              `${resource.id}__${port.name}`,
              {
                domain: policy.baseDomain,
                name: hostname.slice(0, -(policy.baseDomain.length + 1)),
              },
              "put",
              "d",
            ),
          );
        urls[`${resource.id}:${port.name}`] = `https://${hostname}`;
      }
      return {
        name: port.name,
        internalPort: port.port,
        protocol,
        public: false,
        domains,
        security: {
          policies: [{ action: "ALLOW", addresses: [...policy.allowedNetworks] }],
          verificationMode: "and",
        },
      };
    });
    const readiness = settings.readiness;
    const http = readiness && "port" in readiness ? readiness : undefined;
    const command = readiness && "command" in readiness ? readiness.command : undefined;
    const readinessPort = resource.ports?.find((port) => port.name === http?.port);
    if (
      resource.kind === "service" &&
      (!readiness ||
        (http
          ? !readinessPort ||
            !http.path.startsWith("/") ||
            (settings.portProtocols?.[http.port] ?? "HTTP") !== "HTTP"
          : !Array.isArray(command) ||
            command.length === 0 ||
            command.length > 32 ||
            command.some((arg) => typeof arg !== "string" || arg.length > 4096)))
    )
      throw new Error("Northflank services require explicit HTTP or command readiness.");
    const spec = {
      name,
      billing,
      deployment,
      ...(resource.kind === "service"
        ? {
            ports,
            healthChecks: [
              {
                ...(http
                  ? { protocol: "HTTP", port: readinessPort?.port, path: http.path }
                  : {
                      protocol: "CMD",
                      cmd: command?.map((arg) => shellWord(staticText(arg))).join(" "),
                    }),
                type: "readinessProbe",
                initialDelaySeconds: 1,
                periodSeconds: 10,
                timeoutSeconds: 5,
                successThreshold: 1,
                failureThreshold: 6,
              },
            ],
          }
        : {
            settings: { backoffLimit: 0, activeDeadlineSeconds: 600, runOnSourceChange: "never" },
          }),
    };
    prepare.push(
      node(resource.kind === "service" ? "DeploymentService" : "Job", resource.id, spec),
    );
    if (resource.kind === "service") {
      const serviceActivation = {
        ...node("DeploymentService", resource.id, {
          ...spec,
          deployment: { ...deployment, instances: 1 },
          ports: ports.map((port, index) => ({
            ...port,
            public: resource.ports?.[index].public === true,
          })),
        }),
        ref: `activate_${resource.id.replaceAll("-", "_")}`,
      };
      const runningCondition: Node = {
        kind: "Condition",
        spec: {
          kind: "Service",
          spec: {
            type: "running",
            data: { serviceId: reference(resource.id), timeoutDuration: 600 },
          },
        },
      };
      activations.set(resource.id, [serviceActivation, runningCondition]);
    } else
      activations.set(resource.id, [
        {
          kind: "JobRun",
          ref: `init_${resource.id.replaceAll("-", "_")}${settings.runOn === "update" ? `_${source.head.slice(0, 12)}` : ""}`,
          condition: "success",
          runNodeOnce: "true",
          spec: { jobId: reference(resource.id) },
        },
      ]);
    const variables: Record<string, string> = {};
    const runtime: Record<string, string> = {};
    const sensitive: Record<string, SensitiveBinding> = {};
    const addonDependencies: Array<{
      addonId: string;
      keys: Array<{ keyName: string; aliases: string[] }>;
    }> = [];
    for (const [key, binding] of Object.entries(settings.environment ?? {})) {
      if ("addon" in binding) {
        if (
          !["postgres", "redis"].includes(resources.get(binding.addon)?.kind ?? "") ||
          !/^[A-Z][A-Z0-9_]*$/.test(binding.key)
        )
          throw new Error("Runtime addon binding must name a selected backing resource.");
        addonDependencies.push({
          addonId: reference(binding.addon),
          keys: [{ keyName: binding.key, aliases: [key] }],
        });
      } else if ("runtimeSecret" in binding) {
        runtime[key] = binding.runtimeSecret;
        sensitive[key] = { runtimeSecret: binding.runtimeSecret };
      } else if ("generated" in binding) {
        sensitive[key] = { generated: binding.generated };
      } else if ("output" in binding) {
        sensitive[key] = { output: binding.output };
      } else variables[key] = literal(binding);
    }
    if (Object.keys(settings.environment ?? {}).length) {
      const groupId = resource.id;
      const group = node(
        "SecretGroup",
        groupId,
        {
          name: `${name}-env`,
          type: "secret",
          secretType: "environment",
          priority: 10,
          restrictions: {
            restricted: true,
            nfObjects: [
              { id: reference(resource.id), type: resource.kind === "service" ? "service" : "job" },
            ],
          },
          secrets: { variables, files: {} },
          addonDependencies,
        },
        "create",
        "e",
      );
      secretNodes.push(group);
      if (Object.keys(runtime).length)
        runtimeSecrets.push({ groupRef: group.ref, variables: runtime });
      if (Object.keys(sensitive).length)
        secretBindings.push({ groupRef: group.ref, variables: sensitive });
    }
  }
  const references = [
    ...prepare,
    ...volumes,
    ...secretNodes,
    ...[...activations.values()].flat(),
  ].flatMap((item) => (item.ref ? [item.ref] : []));
  if (
    new Set(references).size !== references.length ||
    new Set(Object.values(urls)).size !== Object.keys(urls).length
  )
    throw new Error("Northflank graph contains colliding references or origins.");
  const spec = {
    kind: "Workflow",
    spec: {
      type: "sequential",
      steps: [
        ...prepare,
        ...volumes,
        ...secretNodes,
        ...(phase === "activate"
          ? [...activations.values()].flat()
          : phase === "source"
            ? sourceResources.flatMap((id) => activations.get(id) ?? [])
            : []),
      ],
    },
  };
  const digest = createHash("sha256")
    .update(JSON.stringify({ spec, runtimeSecrets }))
    .digest("hex");
  return { spec, digest, runtimeSecrets, secretBindings, urls, sourceResources };
}

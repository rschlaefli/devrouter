import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { PreviewPoolEntry } from "../state";

export type NorthflankBinding =
  | { literal: string }
  | { origin: string; port: string }
  | { addon: string; key: string }
  | { runtimeSecret: string };

export type NorthflankResourceSettings = {
  deploymentPlan: string;
  buildPlan?: string;
  addonVersion?: string;
  storageMiB?: number;
  environment?: Record<string, NorthflankBinding>;
  publicBuildEnvironment?: Record<
    string,
    Extract<NorthflankBinding, { literal: string } | { origin: string }>
  >;
  readiness?: { port: string; path: string };
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
};

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
const boundedStorage = (miB?: number) => Number.isSafeInteger(miB) && (miB ?? 0) >= 1024;
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
  phase: "prepare" | "activate",
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
  for (const nativeId of Object.values(owned.resources)) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(nativeId))
      throw new Error("Invalid owned Northflank resource identifier.");
  }
  if (
    phase === "activate" &&
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
  const literal = (binding: NorthflankBinding): string => {
    if ("literal" in binding) {
      if (
        typeof binding.literal !== "string" ||
        binding.literal.length > 4096 ||
        binding.literal.includes("${")
      )
        throw new Error("Northflank literal binding cannot contain template expressions.");
      return staticText(binding.literal);
    }
    if ("origin" in binding) return origin(binding.origin, binding.port);
    throw new Error("Northflank build bindings must be public literals or origins.");
  };
  const prepare: Node[] = [];
  const activate: Node[] = [];
  const volumes: Node[] = [];
  const secretNodes: Node[] = [];
  const runtimeSecrets: Array<{ groupRef: string; variables: Record<string, string> }> = [];
  const urls: Record<string, string> = {};
  const nativeNames = new Set<string>();
  for (const resource of entry.plan.resources) {
    const settings = policy.resources[resource.id];
    if (!settings || !ALLOCATION_PLAN.test(settings.deploymentPlan))
      throw new Error("Every selected resource requires a trusted allocation plan.");
    const name = `${northflankAllocationPrefix(policy, entry.session.generation)}${createHash("sha256").update(resource.id).digest("hex").slice(0, 10)}`;
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
          literal(binding),
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
              projectBranch: git.branch,
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
          reuseExistingBuilds: true,
          ...(resource.build.target
            ? {
                buildOverrides: { docker: { dockerfileTarget: staticText(resource.build.target) } },
              }
            : {}),
        },
      });
      deployment.internal = { id: reference(buildId, "b"), buildSHA: source.head };
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
    const ports = (resource.ports ?? []).map((port) => {
      if (port.name.length > 8)
        throw new Error("Northflank port names support at most eight characters.");
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
        protocol: "HTTP",
        public: false,
        domains,
        security: {
          policies: [{ action: "ALLOW", addresses: [...policy.allowedNetworks] }],
          verificationMode: "and",
        },
      };
    });
    const readiness = settings.readiness;
    const readinessPort = resource.ports?.find((port) => port.name === readiness?.port);
    if (
      resource.kind === "service" &&
      (!readiness || !readinessPort || !readiness.path.startsWith("/"))
    )
      throw new Error("Northflank services require explicit readiness on a selected port.");
    const spec = {
      name,
      billing,
      deployment,
      ...(resource.kind === "service"
        ? {
            ports,
            healthChecks: [
              {
                protocol: "HTTP",
                type: "readinessProbe",
                port: readinessPort?.port,
                path: readiness?.path,
                initialDelaySeconds: 1,
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 6,
              },
            ],
          }
        : { settings: { backoffLimit: 0, activeDeadlineSeconds: 600, runOnSourceChange: false } }),
    };
    prepare.push(
      node(resource.kind === "service" ? "DeploymentService" : "Job", resource.id, spec),
    );
    if (resource.kind === "service") {
      activate.push({
        ...node("DeploymentService", resource.id, {
          ...spec,
          deployment: { ...deployment, instances: 1 },
          ports: ports.map((port, index) => ({
            ...port,
            public: resource.ports?.[index].public === true,
          })),
        }),
        ref: `activate_${resource.id.replaceAll("-", "_")}`,
      });
      activate.push({
        kind: "Condition",
        spec: {
          kind: "Service",
          spec: {
            type: "running",
            data: { serviceId: reference(resource.id), timeoutDuration: 600 },
          },
        },
      });
    } else
      activate.push({
        kind: "JobRun",
        ref: `init_${resource.id.replaceAll("-", "_")}${settings.runOn === "update" ? `_${source.head.slice(0, 12)}` : ""}`,
        condition: "success",
        runNodeOnce: "true",
        spec: { jobId: reference(resource.id) },
      });
    const variables: Record<string, string> = {};
    const runtime: Record<string, string> = {};
    const addonDependencies: Array<{
      addonId: string;
      keys: Array<{ keyName: string; aliases: string[] }>;
    }> = [];
    for (const [key, binding] of Object.entries(settings.environment ?? {})) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) throw new Error("Invalid runtime binding key.");
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
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(binding.runtimeSecret))
          throw new Error("Invalid runtime secret reference.");
        runtime[key] = binding.runtimeSecret;
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
    }
  }
  const references = [...prepare, ...volumes, ...secretNodes, ...activate].flatMap((item) =>
    item.ref ? [item.ref] : [],
  );
  if (
    new Set(references).size !== references.length ||
    new Set(Object.values(urls)).size !== Object.keys(urls).length
  )
    throw new Error("Northflank graph contains colliding references or origins.");
  const spec = {
    kind: "Workflow",
    spec: {
      type: "sequential",
      steps: [...prepare, ...volumes, ...secretNodes, ...(phase === "activate" ? activate : [])],
    },
  };
  const digest = createHash("sha256")
    .update(JSON.stringify({ spec, runtimeSecrets }))
    .digest("hex");
  return { spec, digest, runtimeSecrets, urls };
}

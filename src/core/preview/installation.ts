import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseRepoConfigSource } from "../repo-config";
import { PreviewController } from "./controller";
import { PreviewEngine, type PreviewProvider } from "./engine";
import { GitHubPreviewForge } from "./forge/github";
import { GitLabPreviewForge } from "./forge/gitlab";
import {
  forgeObject as map,
  PreviewControlUnavailable,
  PreviewForgeRejected,
} from "./forge/status";
import { parsePreviewManifest } from "./manifest";
import { buildPreviewPlan, listPreviewAliases } from "./plan";
import {
  NorthflankPreviewProvider,
  type NorthflankQualification,
  northflankQualificationKeys,
} from "./providers/northflank";
import { NorthflankPreviewAPI } from "./providers/northflank-api";
import { compileNorthflankGraph, type NorthflankGraphPolicy } from "./providers/northflank-graph";
import {
  createPreviewPool,
  decodePreviewPool,
  object,
  type PreviewPoolEntry,
  type PreviewStateStore,
} from "./state";
import { AzureBlobPreviewState } from "./state/azure-blob";
import type { PreviewPlanReport } from "./types";

const MAX_COMMAND_AGE_MS = 15 * 60_000;
const digest = (source: string) => createHash("sha256").update(source).digest("hex");
const envName = (value: unknown): string => {
  if (typeof value !== "string" || !/^DEVROUTER_PREVIEW_[A-Z0-9_]+$/.test(value))
    throw new Error("Preview credential references require scoped environment names.");
  return value;
};
function readFile(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("Preview control files must be regular files of at most 1 MiB.");
  return fs.readFileSync(file, "utf8");
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("Invalid preview installation field.");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error("Invalid preview installation bound.");
  return value as number;
}

/** Reviewed operator policy, never read from a candidate checkout or event payload. */
export function loadPreviewInstallation(
  filename: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number } = {},
) {
  const root = path.dirname(fs.realpathSync(filename));
  const raw = object(JSON.parse(readFile(filename)), [
    "version",
    "installationId",
    "state",
    "maxActive",
    "maxReservedCents",
    "projects",
  ]);
  if (raw.version !== 1) throw new Error("Unsupported preview installation version.");
  const installationId = text(raw.installationId, /^[a-z][a-z0-9-]{0,62}$/);
  const maxActive = integer(raw.maxActive, 1, 4),
    maxReservedCents = integer(raw.maxReservedCents, 1, 100_000);
  const supplied = options.env ?? process.env;
  let injected: unknown = {};
  try {
    if (supplied.DEVROUTER_PREVIEW_CREDENTIALS)
      injected = JSON.parse(supplied.DEVROUTER_PREVIEW_CREDENTIALS);
  } catch {
    throw new Error("Preview credential map is not valid JSON.");
  }
  const extra = map(injected);
  if (Object.keys(extra).length > 128) throw new Error("Preview credential map exceeds its bound.");
  for (const [name, value] of Object.entries(extra)) {
    envName(name);
    if (typeof value !== "string" || value.length > 64 * 1024 || value.includes("\0"))
      throw new Error("Invalid preview credential mapping.");
  }
  const environment = { ...extra, ...supplied } as NodeJS.ProcessEnv,
    now = options.now ?? Date.now;
  const credential = (name: unknown) => {
    const key = envName(name);
    return async () => {
      const value = environment[key];
      if (!value) throw new Error("A required preview credential is unavailable.");
      return value;
    };
  };
  const statePolicy = object(raw.state, ["containerUrl", "tokenEnv"]);
  const store = new AzureBlobPreviewState({
    containerUrl: text(statePolicy.containerUrl, /^https:\/\//),
    accessToken: credential(statePolicy.tokenEnv),
    fetch: options.fetch,
  });
  if (!Array.isArray(raw.projects) || raw.projects.length < 1 || raw.projects.length > 16)
    throw new Error("Preview installation requires 1-16 registered projects.");
  const projects = raw.projects.map((input) => {
    const row = object(input, [
      "key",
      "forge",
      "config",
      "manifest",
      "northflank",
      "hourlyCents",
      "acceptance",
    ]);
    const key = text(row.key, /^[a-z][a-z0-9-]{0,62}$/);
    const forgePolicy = object(row.forge, [
      "kind",
      "host",
      "apiUrl",
      "repository",
      "projectId",
      "botId",
      "tokenEnv",
    ]);
    if (!["github", "gitlab"].includes(String(forgePolicy.kind)))
      throw new Error("Unknown installed forge adapter.");
    const host = text(forgePolicy.host, /^[a-z0-9.-]{1,253}$/),
      projectId = text(forgePolicy.projectId, /^[1-9][0-9]{0,19}$/);
    const Adapter = forgePolicy.kind === "github" ? GitHubPreviewForge : GitLabPreviewForge;
    const forge = new Adapter({
      apiUrl: text(forgePolicy.apiUrl, /^https:\/\//),
      forgeHost: host,
      repository: text(forgePolicy.repository, /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
      projectId,
      botId: text(forgePolicy.botId, /^[1-9][0-9]{0,19}$/),
      token: credential(forgePolicy.tokenEnv),
      fetch: options.fetch,
    });
    const control = (input: unknown) => {
      const ref = object(input, ["file", "sha256"]);
      const filename = text(ref.file, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/);
      const file = fs.realpathSync(path.join(root, filename));
      if (!file.startsWith(`${root}${path.sep}`))
        throw new Error("Preview control file escapes installation directory.");
      const source = readFile(file),
        expected = text(ref.sha256, /^[a-f0-9]{64}$/);
      if (digest(source) !== expected)
        throw new Error("Reviewed preview control fingerprint differs.");
      return { source, digest: expected };
    };
    const local = control(row.config),
      remote = control(row.manifest),
      config = parseRepoConfigSource(local.source, ".devrouter.yml"),
      manifest = parsePreviewManifest(remote.source);
    const northflank = object(row.northflank, [
      "projectId",
      "tokenEnv",
      "graph",
      "qualification",
      "runtimeSecrets",
    ]);
    const graph = northflank.graph as NorthflankGraphPolicy;
    const qualifications = object(northflank.qualification, [...northflankQualificationKeys]);
    for (const key of northflankQualificationKeys)
      if (typeof qualifications[key] !== "boolean")
        throw new Error("Invalid Northflank qualification evidence.");
    const qualification = qualifications as NorthflankQualification;
    const secrets = map(northflank.runtimeSecrets);
    for (const [name, value] of Object.entries(secrets)) {
      text(name, /^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
      envName(value);
    }
    const rates = map(row.hourlyCents);
    for (const id of Object.keys(manifest.resources)) integer(rates[id], 1, 100_000);
    if (Object.keys(rates).some((id) => !manifest.resources[id]))
      throw new Error("Preview cost names an unknown resource.");
    const acceptance = object(row.acceptance, ["command", "environment"]);
    if (
      !Array.isArray(acceptance.command) ||
      acceptance.command.length < 1 ||
      acceptance.command.length > 32 ||
      acceptance.command.some(
        (arg) => typeof arg !== "string" || !arg || arg.length > 4096 || arg.includes("\0"),
      )
    )
      throw new Error("Invalid trusted acceptance command.");
    if (!Array.isArray(acceptance.environment) || acceptance.environment.length > 32)
      throw new Error("Invalid acceptance environment names.");
    const acceptanceEnv = acceptance.environment.map(envName);
    const command = acceptance.command as string[];
    const provider = new NorthflankPreviewProvider({
      api: new NorthflankPreviewAPI({
        projectId: text(northflank.projectId, /^[A-Za-z0-9-]{1,128}$/),
        accessToken: credential(northflank.tokenEnv),
        domain: graph.baseDomain,
        fetch: options.fetch,
      }),
      store,
      installationId,
      graph,
      qualification,
      now,
      runtimeSecret: async (ref) => {
        if (!Object.hasOwn(secrets, ref)) throw new Error("Unregistered preview runtime secret.");
        return credential(secrets[ref])();
      },
      accept: async (entry, urls) => {
        const result = spawnSync(command[0], command.slice(1), {
          cwd: root,
          shell: false,
          timeout: 30_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
          input: JSON.stringify({
            generation: entry.session.generation,
            revision: entry.session.desiredRevision,
            urls,
          }),
          env: {
            PATH: process.env.PATH,
            ...Object.fromEntries(acceptanceEnv.map((key) => [key, environment[key]])),
          },
        });
        if (result.error || result.status !== 0) return false;
        try {
          const proof = object(JSON.parse(result.stdout), [
            "generation",
            "revision",
            "urls",
            "ready",
            "allowedSource",
            "outsideDenied",
          ]);
          return (
            proof.generation === entry.session.generation &&
            proof.revision === entry.session.desiredRevision &&
            JSON.stringify(proof.urls) === JSON.stringify(urls) &&
            proof.ready === true &&
            proof.allowedSource === true &&
            proof.outsideDenied === true
          );
        } catch {
          return false;
        }
      },
    });
    // Resolve every installed alias before any credential is requested or native write is possible.
    const plan = (source: import("./types").PreviewSource, aliases?: string[]) =>
      buildPreviewPlan({
        repoPath: root,
        config,
        manifest,
        manifestDigest: remote.digest,
        localConfigDigest: local.digest,
        source,
        ...(aliases?.length ? { aliases } : {}),
      });
    const aliases = listPreviewAliases(manifest);
    for (const alias of aliases) {
      const checked = plan(
        {
          head: "a".repeat(40),
          target: "b".repeat(40),
          mergeBase: "c".repeat(40),
          complete: true,
          changes: [],
        },
        [alias],
      );
      if (checked.status !== "planned")
        throw new Error("Installed preview alias cannot be resolved.");
      compileNorthflankGraph(
        {
          plan: checked,
          session: { generation: "0".repeat(24), desiredRevision: checked.source?.head },
        } as PreviewPoolEntry,
        graph,
        "prepare",
      );
    }
    return {
      key,
      host,
      projectId,
      forge,
      provider,
      graph,
      qualification,
      aliases,
      local,
      remote,
      plan,
      rates,
      tokens: [forgePolicy.tokenEnv, northflank.tokenEnv],
      secrets,
    };
  });
  if (
    new Set(projects.map((project) => project.key)).size !== projects.length ||
    new Set(projects.map((project) => `${project.host}/${project.projectId}`)).size !==
      projects.length
  )
    throw new Error("Duplicate registered preview project.");
  // Provider selection follows admitted immutable identity, never webhook fields.
  const providerFor = (entry: PreviewPoolEntry) => {
    const project = projects.find(
      (project) =>
        project.host === entry.identity?.forgeHost &&
        project.projectId === entry.identity?.projectId,
    );
    if (!project) throw new Error("Preview ownership project is not installed.");
    return project.provider;
  };
  const controlTokens = new Set([
    statePolicy.tokenEnv,
    "DEVROUTER_PREVIEW_CREDENTIALS",
    ...projects.flatMap((project) => project.tokens),
  ]);
  if (
    projects.some((project) =>
      Object.values(project.secrets).some((name) => controlTokens.has(name)),
    )
  )
    throw new Error("Deployment credentials cannot be delivered as preview runtime secrets.");
  const provider: PreviewProvider = {
    // The controller validates its project provider before submitting an admission.
    submit: (effect, entry, gate) => providerFor(entry).submit(effect, entry, gate),
    observe: (effect, entry, gate) => providerFor(entry).observe(effect, entry, gate),
    absent: (entry) => providerFor(entry).absent(entry),
  };
  const engine = new PreviewEngine({
    store,
    provider,
    now,
    workerId: randomUUID(),
    policy: {
      installationId,
      maxActive,
      maxReservedCents,
      maxCommandAgeMs: MAX_COMMAND_AGE_MS,
      startupBudgetMs: 20 * 60_000,
      leaseMs: 45_000,
      allowedProjects: projects.map((p) => `${p.host}/${p.projectId}`),
      allowedAliases: [...new Set(projects.flatMap((p) => p.aliases))],
      manifestDigests: projects.map((p) => p.remote.digest),
      localConfigDigests: projects.map((p) => p.local.digest),
    },
  });
  const controllers = projects.map((project) => ({
    key: project.key,
    host: project.host,
    projectId: project.projectId,
    controller: new PreviewController({
      installationId,
      forgeHost: project.host,
      projectId: project.projectId,
      forge: project.forge,
      engine,
      store,
      now,
      maxCommandAgeMs: MAX_COMMAND_AGE_MS,
      aliases: project.aliases,
      plan: async (source, command) => {
        const plan = project.plan(source, command.aliases);
        // Candidate control bytes must still equal the reviewed installation copies.
        for (const [file, expected] of [
          [".devrouter.yml", project.local.digest],
          [".devrouter.preview.yml", project.remote.digest],
        ] as const) {
          let matches = false;
          try {
            matches = digest(await project.forge.file(source.head, file)) === expected;
          } catch (error) {
            if (
              !(error instanceof PreviewControlUnavailable) &&
              (!(error instanceof PreviewForgeRejected) || error.status !== 404)
            )
              throw error;
          }
          if (!matches)
            return {
              ...plan,
              status: "review-required",
              aliases: [],
              resources: [],
              reasons: [`control-file-unreviewed:${file}`],
            };
        }
        if (plan.status === "planned") project.provider.validatePlan(plan);
        return plan;
      },
      hourlyCents: (plan: PreviewPlanReport) =>
        plan.resources.reduce((sum, resource) => sum + (project.rates[resource.id] as number), 0),
      urls: (entry) => compileNorthflankGraph(entry, project.graph, "prepare").urls,
    }),
  }));
  return {
    installationId,
    store,
    engine,
    controllers,
    diagnostic: {
      schemaVersion: 1,
      installationId,
      maxActive,
      maxReservedCents,
      projects: projects.map((p) => {
        const requiredProofs = northflankQualificationKeys.filter((key) => !p.qualification[key]);
        return {
          key: p.key,
          forgeHost: p.host,
          projectId: p.projectId,
          aliases: p.aliases,
          qualified: requiredProofs.length === 0,
          requiredProofs,
        };
      }),
    },
  };
}

export async function initializePreviewInstallation(
  installationId: string,
  store: PreviewStateStore,
): Promise<void> {
  const poolKey = `installations/${installationId}/pool`,
    witnessKey = `installations/${installationId}/initialized`;
  if (await store.read(witnessKey, (raw) => object(raw, ["installationId"])))
    throw new Error(
      "Preview installation is already initialized; missing state requires operator recovery.",
    );
  if (await store.read(poolKey, decodePreviewPool))
    throw new Error("Preview pool already exists; initialization is refused.");
  // A crash after this permanent witness requires recovery, never an empty replacement pool.
  await store.compareAndSwap(witnessKey, null, { installationId });
  await store.compareAndSwap(poolKey, null, createPreviewPool(installationId));
}

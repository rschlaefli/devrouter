import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { printJSON } from "../core/output";
import { assertPathWithinRepo } from "../core/paths";
import { loadPreviewManifest } from "../core/preview/manifest";
import { buildPreviewPlan, listPreviewAliases } from "../core/preview/plan";
import type { PreviewSource } from "../core/preview/types";
import { loadRepoConfig, resolveRepoPath } from "../core/repo-config";

export type PreviewCommandOptions = {
  repo?: string;
  alias?: string;
  source?: string;
  list?: boolean;
  json?: boolean;
  write?: boolean;
  integration?: string;
  controllerRef?: string;
  policyRef?: string;
  policyRepository?: string;
  project?: string;
  installation?: string;
  sweeper?: boolean;
  controllerImage?: string;
};

function readSource(repoPath: string, filename: string): PreviewSource {
  if (path.isAbsolute(filename))
    throw new Error("Preview source path must be repository-relative.");
  const root = fs.realpathSync(repoPath);
  const file = assertPathWithinRepo(filename, root, "preview source");
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("Preview source must be a regular file of at most 1 MiB.");
  }
  assertPathWithinRepo(fs.realpathSync(file), root, "preview source");
  return JSON.parse(fs.readFileSync(file, "utf8")) as PreviewSource;
}

export async function runPreviewPlanCommand(options: PreviewCommandOptions): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  const { manifest, digest } = loadPreviewManifest(repoPath);
  if (options.list) {
    if (options.alias || options.source) {
      throw new Error("--list cannot be combined with --alias or --source.");
    }
    const aliases = listPreviewAliases(manifest);
    if (options.json) printJSON({ schemaVersion: 1, aliases });
    else process.stdout.write(`${aliases.join("\n")}\n`);
    return;
  }
  const localConfig = fs.readFileSync(path.join(repoPath, ".devrouter.yml"), "utf8");
  const report = buildPreviewPlan({
    repoPath,
    config: loadRepoConfig(repoPath, () => localConfig),
    manifest,
    manifestDigest: digest,
    localConfigDigest: createHash("sha256").update(localConfig).digest("hex"),
    ...(options.alias === undefined ? {} : { aliases: options.alias.split(",") }),
    ...(options.source === undefined ? {} : { source: readSource(repoPath, options.source) }),
  });
  if (options.json) printJSON(report);
  else {
    process.stdout.write(`Preview plan: ${report.status}\n`);
    process.stdout.write(`Aliases: ${report.aliases.join(", ") || "-"}\n`);
    process.stdout.write(
      `Resources: ${report.resources.map((resource) => resource.id).join(", ") || "-"}\n`,
    );
    for (const reason of report.reasons) process.stdout.write(`${reason}\n`);
  }
}

export async function runPreviewInitCommand(options: PreviewCommandOptions): Promise<void> {
  const repoPath = fs.realpathSync(resolveRepoPath(options.repo));
  if (options.integration === "gitlab") return renderGitLabPreviewIntegration(repoPath, options);
  if (options.integration) return renderPreviewIntegration(repoPath, options);
  loadRepoConfig(repoPath);
  const manifest = {
    version: 1,
    aliases: { web: { resources: ["web"] } },
    bindings: { apps: {}, dependencies: {}, services: {}, processes: {} },
    resources: {
      web: {
        kind: "service",
        image: `registry.example.org/app@sha256:${"0".repeat(64)}`,
        ports: [{ name: "http", port: 8080, public: false }],
      },
    },
    selection: {
      rules: [{ paths: ["src/**"], aliases: ["web"] }],
      ignorePaths: ["docs/**", "**/*.md"],
      controlPaths: [],
      fallback: "web",
      allowedUnions: [],
    },
  };
  const content = stringify(manifest);
  if (options.write) {
    const file = path.join(repoPath, ".devrouter.preview.yml");
    fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  }
  if (options.json) {
    printJSON({
      schemaVersion: 1,
      path: ".devrouter.preview.yml",
      written: options.write === true,
      content,
      steps: [
        "Replace the placeholder image and map repository profiles or resource aliases.",
        "Review selection rules and explicit profile omissions.",
        "Run preview plan --alias web --json to inspect the offline graph.",
        "Cloud activation requires installed access, credentials, state and deadline controls.",
      ],
    });
  } else process.stdout.write(content);
}

export async function runPreviewInstallationCommand(
  action: "doctor" | "state-init" | "handle-event" | "sweep",
  options: {
    installation: string;
    project?: string;
    change?: string;
    json?: boolean;
    live?: boolean;
  },
): Promise<void> {
  const { loadPreviewInstallation, initializePreviewInstallation } = await import(
    "../core/preview/installation"
  );
  if (options.live && action !== "doctor")
    throw new Error("--live is supported only by preview doctor.");
  const installation = loadPreviewInstallation(
    options.installation,
    action === "doctor" && !options.live ? { env: {} } : {},
  );
  if (action === "state-init")
    await initializePreviewInstallation(installation.installationId, installation.store);
  else if (action === "doctor") {
    const report = options.live ? await installation.inspectPlatform() : installation.diagnostic;
    printJSON(report);
    if (report.projects.some((project) => !project.qualified)) process.exitCode = 3;
    return;
  } else if (action === "handle-event") {
    const selected = installation.controllers.find((row) => row.key === options.project);
    if (
      !selected ||
      !options.change ||
      !/^[1-9][0-9]*$/.test(options.change) ||
      !Number.isSafeInteger(Number(options.change))
    )
      throw new Error("A registered --project and positive --change are required.");
    const change = Number(options.change),
      cutoff = Date.now() + 12 * 60_000;
    do {
      await selected.controller.scan(change);
      const entry = await installation.engine.status({
        forgeHost: selected.host,
        projectId: selected.projectId,
        change,
      });
      if (!entry || ["ready", "stopped", "expired", "failed"].includes(entry.session.status)) break;
      // One bounded handler owns synchronous reconciliation; the installation sweep recovers interruptions.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } while (Date.now() < cutoff);
  } else {
    let failures = 0;
    for (const { controller } of installation.controllers) {
      try {
        await controller.sweep();
      } catch {
        failures++;
      }
    }
    if (failures)
      throw new Error(
        `Preview sweep failed for ${failures} installed projects; all were attempted.`,
      );
  }
  printJSON({ schemaVersion: 1, action, status: "reconciled" });
}

function previewAsset(name: string): string {
  const candidates = [
    path.resolve(__dirname, "..", "assets", "preview", name),
    path.resolve(__dirname, "..", "..", "assets", "preview", name),
  ];
  const file = candidates.find((file) => fs.existsSync(file));
  if (!file) throw new Error("Installed preview integration asset is missing.");
  return fs.readFileSync(file, "utf8");
}

function renderPreviewAsset(name: string, replacements: Record<string, string>): string {
  return previewAsset(name).replace(/__([A-Z_]+)__/g, (_match, key: string) => {
    const value = replacements[key];
    if (value === undefined) throw new Error("Unknown preview template input.");
    return value;
  });
}

async function renderPreviewIntegration(
  repoPath: string,
  options: PreviewCommandOptions,
): Promise<void> {
  if (options.integration !== "github")
    throw new Error("Only the GitHub integration is installed.");
  if (
    !/^[a-f0-9]{40}$/.test(options.controllerRef ?? "") ||
    !/^[a-f0-9]{40}$/.test(options.policyRef ?? "")
  )
    throw new Error(
      "Integration output requires reviewed --controller-ref and --policy-ref commit SHAs.",
    );
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.policyRepository ?? "") ||
    options.policyRepository?.includes("..") ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(options.project ?? "")
  )
    throw new Error("Integration output requires --policy-repository and a registered --project.");
  const installation = options.installation ?? "installation.json";
  if (
    !/^[A-Za-z0-9_./-]+$/.test(installation) ||
    installation.startsWith("/") ||
    installation.split("/").includes("..")
  )
    throw new Error("Installation must be a relative policy-repository path.");
  const replacements: Record<string, string> = {
    CONTROLLER_REF: String(options.controllerRef),
    POLICY_REF: String(options.policyRef),
    POLICY_REPOSITORY: String(options.policyRepository),
    INSTALLATION: installation,
    PROJECT: String(options.project),
  };
  const content = renderPreviewAsset(
    options.sweeper ? "github-sweep.yml" : "github.yml",
    replacements,
  );
  const filename = `.github/workflows/devrouter-preview${options.sweeper ? "-sweep" : ""}.yml`;
  if (options.write) {
    const file = assertPathWithinRepo(filename, repoPath, "preview workflow");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertPathWithinRepo(fs.realpathSync(path.dirname(file)), repoPath, "preview workflow parent");
    fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  }
  if (options.json)
    printJSON({
      schemaVersion: 1,
      path: filename,
      content,
      written: options.write === true,
      installationExample: previewAsset("installation.json"),
      qualified: false,
    });
  else process.stdout.write(content);
}

async function renderGitLabPreviewIntegration(
  repoPath: string,
  options: PreviewCommandOptions,
): Promise<void> {
  if (
    !/^[a-f0-9]{40}$/.test(options.controllerRef ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(options.controllerImage ?? "")
  )
    throw new Error(
      "GitLab integration requires reviewed --controller-ref and --controller-image digest.",
    );
  const integrity = `sha256-${createHash("sha256").update(previewAsset("gitlab-template.yml")).digest("base64")}`;
  const replacements: Record<string, string> = {
    CONTROLLER_REF: String(options.controllerRef),
    CONTROLLER_IMAGE: String(options.controllerImage),
    TEMPLATE_INTEGRITY: integrity,
  };
  const content = renderPreviewAsset("gitlab.yml", replacements);
  const filename = ".gitlab-ci.yml";
  if (options.write)
    fs.writeFileSync(assertPathWithinRepo(filename, repoPath, "GitLab preview caller"), content, {
      flag: "wx",
      mode: 0o600,
    });
  if (options.json)
    printJSON({
      schemaVersion: 1,
      path: filename,
      content,
      written: options.write === true,
      qualified: false,
      templateIntegrity: integrity,
    });
  else process.stdout.write(content);
}

import fs from "node:fs";
import path from "node:path";
import type { inspectManagedDevcontainerConfig } from "./devcontainer-profile";
import type { ManagedStopContainerSnapshot } from "./devpod-environment";
import { sameWorkspacePath } from "./workspace";

/** Validate supplied Compose population ownership without inspecting or mutating a provider. */
export function proveManagedComposePopulation(options: {
  plan: Pick<
    ReturnType<typeof inspectManagedDevcontainerConfig>,
    "nativeRunServices" | "composeDirectory" | "composeFiles" | "desiredServices" | "primaryService"
  >;
  repoPath: string;
  composeProject: string;
  providerRoot: string;
  featureDirectory: string;
  containers: ManagedStopContainerSnapshot[];
}): ManagedStopContainerSnapshot {
  const { plan, repoPath, composeProject, providerRoot, featureDirectory, containers } = options;
  const services = new Set<string>();
  for (const container of containers) {
    const service = container.labels["com.docker.compose.service"] ?? "";
    if (
      !plan.nativeRunServices.includes(service) ||
      services.has(service) ||
      container.labels["com.docker.compose.project"] !== composeProject ||
      !sameWorkspacePath(
        container.labels["com.docker.compose.project.working_dir"] ?? "",
        plan.composeDirectory,
      )
    ) {
      throw new Error("Managed stop found unexpected or duplicate project membership.");
    }
    services.add(service);
    const files = (container.labels["com.docker.compose.project.config_files"] ?? "")
      .split(",")
      .map((file) => file.trim());
    if (
      files.some((file) => !file || !path.isAbsolute(file)) ||
      new Set(files.map((file) => path.resolve(file))).size !== files.length ||
      files.length < plan.composeFiles.length ||
      plan.composeFiles.some((file, index) => !sameWorkspacePath(file, files[index]))
    ) {
      throw new Error("Managed stop Compose file identity changed.");
    }
    for (const file of files.slice(plan.composeFiles.length)) {
      if (
        path.dirname(file) !== featureDirectory ||
        !/^docker-compose\.devcontainer\.containerFeatures-[a-zA-Z0-9_-]+\.yml$/.test(
          path.basename(file),
        ) ||
        fs.realpathSync(file) !==
          path.join(fs.realpathSync(providerRoot), path.relative(providerRoot, file))
      ) {
        throw new Error("Managed stop refuses a foreign or escaped provider Compose file.");
      }
    }
  }
  if (plan.desiredServices.some((service) => !services.has(service))) {
    throw new Error("Managed stop cannot prove the complete retained service population.");
  }
  const primary = containers.find(
    (c) => c.labels["com.docker.compose.service"] === plan.primaryService,
  );
  if (
    primary?.mounts.filter(
      (mount) => mount.Type === "bind" && sameWorkspacePath(mount.Source, repoPath),
    ).length !== 1
  ) {
    throw new Error("Managed stop cannot prove the exact primary workspace mount.");
  }
  return primary;
}

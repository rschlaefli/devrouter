import fs from "node:fs";
import path from "node:path";
import type { CapacityPolicy } from "./capacity-policy";
import { readControllerEvidence, resolveControllerBinding } from "./controller-binding";
import { runControllerProbe } from "./controller-probe";
import { capacityEstimatesDigest, loadRepoConfig } from "./repo-config";

/** Match operator enrollment only after existing canonical provider ownership proof. */
export async function resolveCapacityEnrollment(
  policy: CapacityPolicy,
  request: { path: string; profile: string; require: string[] },
  signal: AbortSignal,
) {
  const environment = await resolveControllerBinding(request, signal);
  const common = (
    await runControllerProbe(
      "git",
      ["-C", environment.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    )
  ).trim();
  const gitCommonDir = fs.realpathSync(common);
  const enrollment = policy.enrollments.find(
    (entry) =>
      entry.repoPath === environment.repoPath &&
      entry.gitCommonDir === gitCommonDir &&
      entry.workspace === environment.workspace &&
      entry.provider === environment.provider &&
      entry.providerId === environment.providerId,
  );
  if (!enrollment?.profiles.includes(environment.profile))
    throw new Error("Canonical runtime profile is not enrolled for capacity admission.");
  const file = path.join(environment.repoPath, ".devrouter.yml");
  const bytes = readControllerEvidence(file);
  const estimates = loadRepoConfig(environment.repoPath, () => bytes).capacity;
  if (!estimates || capacityEstimatesDigest(estimates) !== enrollment.estimatesDigest)
    throw new Error("Capacity estimates differ from the enrolled revision.");
  const current = await resolveControllerBinding(request, signal);
  if (
    JSON.stringify(current) !== JSON.stringify(environment) ||
    readControllerEvidence(file) !== bytes
  )
    throw new Error("Capacity enrollment evidence changed during resolution.");
  if (signal.aborted) throw new Error("Capacity enrollment resolution was cancelled.");
  return { environment, enrollment, estimates };
}

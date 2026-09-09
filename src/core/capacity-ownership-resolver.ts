import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readDockerCapacityPopulation } from "./capacity-docker-population";
import { readDockerCapacityOwnershipIndex } from "./capacity-docker-probe";
import { resolveCapacityEnrollment } from "./capacity-enrollment";
import type { CapacityPolicy } from "./capacity-policy";
import { proveManagedCapacityPopulation } from "./capacity-population-proof";
import type { CapacityOwnedPopulation } from "./capacity-runtime-probe";
import { readControllerEvidence } from "./controller-binding";
import { runControllerProbe } from "./controller-probe";
import { readManagedRuntimeState } from "./managed-runtime-state";
import { readReliabilityOperation } from "./reliability-operation-store";

/** The retained Devsy generation is stronger evidence than its reusable workspace ID. */
async function readProviderGeneration(repoPath: string, providerId: string, signal: AbortSignal) {
  const entries: unknown = JSON.parse(
    await runControllerProbe(
      "devsy",
      ["workspace", "list", "--result-format", "json", "--skip-pro"],
      signal,
    ),
  );
  if (!Array.isArray(entries)) throw new Error("Capacity provider generation is unavailable.");
  const matches = entries.filter(
    (entry) => entry?.id === providerId || entry?.source?.localFolder === repoPath,
  );
  if (
    matches.length !== 1 ||
    matches[0]?.id !== providerId ||
    matches[0]?.source?.localFolder !== repoPath
  )
    throw new Error("Capacity provider generation is ambiguous.");
  const entry = matches[0];
  const generation = {
    context: entry.context === undefined ? "" : entry.context,
    uid: entry.uid === undefined ? "" : entry.uid,
    sourceContainer: entry.source.container === undefined ? "" : entry.source.container,
  };
  if (Object.values(generation).some((value) => typeof value !== "string" || value.length > 4096))
    throw new Error("Capacity provider generation is malformed.");
  return generation;
}

/** Bind providers outside the sampler deadline; revalidate them before publishing its result. */
export async function resolveCapacityOwnership(
  policy: CapacityPolicy,
  runtimeDomain: string,
  signal: AbortSignal,
  dependencies = {
    resolve: resolveCapacityEnrollment,
    providerGeneration: readProviderGeneration as typeof readProviderGeneration | undefined,
    journal: readReliabilityOperation,
    managed: readManagedRuntimeState,
    population: readDockerCapacityPopulation,
    index: readDockerCapacityOwnershipIndex,
  },
) {
  const domain = policy.domains[runtimeDomain];
  if (domain?.kind !== "runtime") throw new Error("Capacity runtime domain is unavailable.");
  const enrollments = policy.enrollments.filter((entry) => entry.runtimeDomain === runtimeDomain);
  const check = () => {
    if (signal.aborted) throw new Error("Capacity ownership resolution was cancelled.");
  };
  const bindings: Array<{
    enrollment: CapacityPolicy["enrollments"][number];
    request: { path: string; profile: string; require: string[] };
    binding: Awaited<ReturnType<typeof resolveCapacityEnrollment>>;
    generation: Awaited<ReturnType<typeof readProviderGeneration>>;
    evidence?: {
      record: ReturnType<typeof readReliabilityOperation>;
      state: ReturnType<typeof readManagedRuntimeState>;
    };
  }> = [];
  for (const enrollment of enrollments) {
    check();
    const request = {
      path: enrollment.repoPath,
      profile: enrollment.profiles[0],
      require: ["runtime"],
    };
    const binding = await dependencies.resolve(policy, request, signal);
    check();
    if (!isDeepStrictEqual(binding.enrollment, enrollment))
      throw new Error("Capacity ownership enrollment changed.");
    if (enrollment.provider !== "devsy")
      throw new Error("Capacity retained generation requires Devsy ownership.");
    const generation = await (dependencies.providerGeneration ?? readProviderGeneration)(
      enrollment.repoPath,
      enrollment.providerId,
      signal,
    );
    check();
    bindings.push({ enrollment, request, binding, generation });
  }
  return {
    revalidate: async () => {
      for (const entry of bindings) {
        check();
        const current = await dependencies.resolve(policy, entry.request, signal);
        check();
        const generation = await (dependencies.providerGeneration ?? readProviderGeneration)(
          entry.enrollment.repoPath,
          entry.enrollment.providerId,
          signal,
        );
        check();
        if (
          !isDeepStrictEqual(current, entry.binding) ||
          !isDeepStrictEqual(generation, entry.generation)
        )
          throw new Error("Capacity provider ownership changed during collection.");
        if (
          !entry.evidence ||
          !isDeepStrictEqual(entry.evidence, {
            record: dependencies.journal({
              repoPath: entry.enrollment.repoPath,
              workspace: entry.enrollment.workspace || null,
              provider: entry.enrollment.provider,
            }),
            state: dependencies.managed(
              entry.enrollment.repoPath,
              entry.enrollment.workspace || undefined,
              (file) => readControllerEvidence(file, 1_048_576),
            ),
          })
        )
          throw new Error("Capacity ownership records changed before publication.");
      }
    },
    proveOwned: async (sampleSignal: AbortSignal): Promise<CapacityOwnedPopulation[]> => {
      const checkSample = () => {
        check();
        if (sampleSignal.aborted) throw new Error("Capacity population collection was cancelled.");
      };
      checkSample();
      const beforeIndex = await dependencies.index(domain.endpoint, sampleSignal);
      const result: CapacityOwnedPopulation[] = [];
      const projects = new Set<string>();
      for (const entry of bindings) {
        const { enrollment, binding } = entry;
        checkSample();
        const identity = {
          repoPath: enrollment.repoPath,
          workspace: enrollment.workspace || null,
          provider: enrollment.provider,
        };
        const record = dependencies.journal(identity);
        const expected = {
          policyRevision: policy.revision,
          gitCommonDir: enrollment.gitCommonDir,
          providerId: enrollment.providerId,
          hostDomain: enrollment.hostDomain,
          runtimeDomain,
          endpoint: domain.endpoint,
          daemonId: domain.daemonId,
          estimatesDigest: enrollment.estimatesDigest,
        };
        if (
          !record ||
          record.state.environmentId !== binding.environment.id ||
          record.state.executionPolicy !== "capacity-managed" ||
          !isDeepStrictEqual(record.enrollment, expected)
        )
          throw new Error("Capacity population lacks current durable enrollment.");
        const readState = () =>
          dependencies.managed(enrollment.repoPath, enrollment.workspace || undefined, (file) =>
            readControllerEvidence(file, 1_048_576),
          );
        const state = readState();
        if (
          !state ||
          state.devpodId !== enrollment.providerId ||
          !state.stopBaseline ||
          state.stopBaseline.provider !== enrollment.provider ||
          state.stopBaseline.context !== entry.generation.context ||
          state.stopBaseline.uid !== entry.generation.uid ||
          state.stopBaseline.sourceContainer !== entry.generation.sourceContainer ||
          state.stopBaseline.endpoint !== `unix://${domain.endpoint}` ||
          state.stopBaseline.daemonId !== domain.daemonId ||
          projects.has(state.composeProject)
        )
          throw new Error("Capacity population lacks an exact retained runtime baseline.");
        const evidence = { record, state };
        if (entry.evidence && !isDeepStrictEqual(entry.evidence, evidence))
          throw new Error("Capacity ownership generation changed during collection.");
        entry.evidence = structuredClone(evidence);
        projects.add(state.composeProject);
        const containers = await dependencies.population(
          domain.endpoint,
          domain.daemonId,
          state.composeProject,
          sampleSignal,
        );
        checkSample();
        const undispatched =
          !record.worker &&
          record.state.phase === "queued" &&
          record.state.operation?.status === "NOT_STARTED";
        const stopped =
          !record.worker &&
          record.state.stopProof.workloadsStopped &&
          record.state.stopProof.routesRemoved &&
          (!record.state.operation || record.state.operation.drained);
        if (containers.length === 0) {
          // This zero observation does not settle or release any reservation. The stable
          // daemon index below must also exclude residual workspace containers.
          if (!stopped && !undispatched)
            throw new Error("Absent capacity population lacks stopped or undispatched proof.");
        } else {
          proveManagedCapacityPopulation({
            containers,
            baseline: state.stopBaseline,
            repoPath: enrollment.repoPath,
            composeProject: state.composeProject,
            daemonId: domain.daemonId,
            endpoint: `unix://${domain.endpoint}`,
          });
        }
        if (
          !isDeepStrictEqual(state, readState()) ||
          !isDeepStrictEqual(record, dependencies.journal(identity))
        )
          throw new Error("Capacity ownership records changed during collection.");
        result.push({ environmentId: binding.environment.id, containers });
      }
      const afterIndex = await dependencies.index(domain.endpoint, sampleSignal);
      checkSample();
      if (!isDeepStrictEqual(beforeIndex, afterIndex))
        throw new Error("Capacity daemon population changed during collection.");
      const owned = new Set(
        result.flatMap((entry) => entry.containers.map((container) => container.id)),
      );
      const indexed = new Set(afterIndex.map((entry) => entry.id));
      if ([...owned].some((id) => !indexed.has(id)))
        throw new Error("Capacity population is absent from daemon ownership evidence.");
      const within = (candidate: string, root: string) => {
        if (!candidate) return false;
        const relative = path.relative(root, candidate);
        return (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        );
      };
      for (const container of afterIndex) {
        if (owned.has(container.id)) continue;
        if (
          projects.has(container.project) ||
          enrollments.some(
            (entry) =>
              within(container.workingDirectory, entry.repoPath) ||
              container.bindSources.some((source) => within(source, entry.repoPath)),
          )
        )
          throw new Error("Capacity daemon contains unattributed enrolled containers.");
      }
      return result;
    },
  };
}

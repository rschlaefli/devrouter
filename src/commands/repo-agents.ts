import { resolveRepoPath } from "../core/repo-config";
import {
  ensureAgentsMdSection,
  ensureLinearWorkflowAgentsSection,
  ensureLinearWorkflowSkillFiles,
  ensureSkillFile
} from "../core/agents-md";
import { collectLinearWorkflowMetadata, type LinearWorkflowMetadata } from "../core/linear-onboarding";

type RepoAgentsCommandDeps = {
  collectLinearMetadata?: () => Promise<LinearWorkflowMetadata>;
};

export async function runRepoAgentsCommand(
  options: { repo?: string; withLinear?: boolean },
  deps: RepoAgentsCommandDeps = {}
): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);
  let linearMetadata: LinearWorkflowMetadata | null = null;

  const skill = ensureSkillFile(repoPath);
  process.stdout.write(`Wrote skill to ${skill.path}\n`);

  if (options.withLinear) {
    linearMetadata = await (deps.collectLinearMetadata ?? collectLinearWorkflowMetadata)();
    if (linearMetadata.captureMode === "placeholder") {
      process.stdout.write(
        "Warning: non-interactive mode detected; wrote placeholder Linear mapping values. Re-run in a TTY to capture workspace/team/project.\n"
      );
    }

    const linearSkills = ensureLinearWorkflowSkillFiles(repoPath);
    for (const filePath of linearSkills.paths) {
      process.stdout.write(`Wrote Linear workflow artifact to ${filePath}\n`);
    }
  }

  const result = ensureAgentsMdSection(repoPath);

  if (!result.written) {
    process.stdout.write(`devrouter section already present: ${result.path}\n`);
  } else {
    process.stdout.write(`Wrote devrouter section to ${result.path}\n`);
  }

  if (options.withLinear) {
    if (!linearMetadata) {
      throw new Error("Linear metadata was not collected.");
    }

    const linearAgents = ensureLinearWorkflowAgentsSection(repoPath, linearMetadata);
    if (!linearAgents.written) {
      process.stdout.write(`Linear workflow section already present: ${linearAgents.path}\n`);
      return;
    }
    process.stdout.write(`Wrote Linear workflow section to ${linearAgents.path}\n`);
  }
}

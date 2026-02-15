import { buildOnboardingPrompt, COMMAND_INTENTS } from "../core/ai-prompt";
import {
  ensureAgentsMdSection,
  ensureLinearWorkflowAgentsSection,
  ensureLinearWorkflowSkillFiles,
  ensureSkillFile
} from "../core/agents-md";
import { printJSON } from "../core/output";
import { resolveRepoPath } from "../core/repo-config";

type InitCommandOptions = {
  repo?: string;
  entriesJson?: string;
  json?: boolean;
  writeAgents?: boolean;
  writeSkill?: boolean;
  withLinear?: boolean;
};

export async function runInitCommand(options: InitCommandOptions): Promise<void> {
  if (options.json && (options.writeAgents || options.writeSkill)) {
    throw new Error("--json cannot be combined with --write-agents or --write-skill.");
  }

  const prompt = buildOnboardingPrompt({
    repo: options.repo,
    entriesJson: options.entriesJson,
    withLinear: Boolean(options.withLinear)
  });

  if (options.json) {
    printJSON({
      prompt,
      commandIntents: COMMAND_INTENTS
    });
    return;
  }

  process.stdout.write(`${prompt}\n`);

  if (!options.writeAgents && !options.writeSkill) {
    return;
  }

  const repoPath = resolveRepoPath(options.repo);

  if (options.writeSkill) {
    const skill = ensureSkillFile(repoPath);
    process.stdout.write(`\nWrote skill to ${skill.path}\n`);

    if (options.withLinear) {
      const linearSkills = ensureLinearWorkflowSkillFiles(repoPath);
      for (const filePath of linearSkills.paths) {
        process.stdout.write(`Wrote Linear workflow artifact to ${filePath}\n`);
      }
    }
  }

  if (options.writeAgents) {
    const result = ensureAgentsMdSection(repoPath);
    if (result.written) {
      process.stdout.write(`Wrote devrouter section to ${result.path}\n`);
    } else {
      process.stdout.write(`devrouter section already present: ${result.path}\n`);
    }

    if (options.withLinear) {
      const linearAgents = ensureLinearWorkflowAgentsSection(repoPath);
      if (linearAgents.written) {
        process.stdout.write(`Wrote Linear workflow section to ${linearAgents.path}\n`);
      } else {
        process.stdout.write(`Linear workflow section already present: ${linearAgents.path}\n`);
      }
    }
  }
}

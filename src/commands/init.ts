import { ensureAgentsMdSection, ensureSkillFile } from "../core/agents-md";
import { buildOnboardingPrompt, COMMAND_INTENTS } from "../core/ai-prompt";
import { printJSON } from "../core/output";
import { resolveRepoPath } from "../core/repo-config";

type InitCommandOptions = {
  repo?: string;
  entriesJson?: string;
  json?: boolean;
  writeAgents?: boolean;
  writeSkill?: boolean;
};

export async function runInitCommand(options: InitCommandOptions): Promise<void> {
  if (options.json && (options.writeAgents || options.writeSkill)) {
    throw new Error("--json cannot be combined with --write-agents or --write-skill.");
  }

  const prompt = buildOnboardingPrompt({
    repo: options.repo,
    entriesJson: options.entriesJson,
  });

  if (options.json) {
    printJSON({
      prompt,
      commandIntents: COMMAND_INTENTS,
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
  }

  if (options.writeAgents) {
    const result = ensureAgentsMdSection(repoPath);
    if (result.written) {
      process.stdout.write(`Wrote devrouter section to ${result.path}\n`);
    } else {
      process.stdout.write(`devrouter section already present: ${result.path}\n`);
    }
  }
}

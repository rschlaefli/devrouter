import { buildOnboardingPrompt, COMMAND_INTENTS } from "../core/ai-prompt";
import { ensureAgentsMdSection, ensureSkillFile } from "../core/agents-md";
import { printJSON } from "../core/output";
import { resolveRepoPath } from "../core/repo-config";

type InitCommandOptions = {
  repo?: string;
  entriesJson?: string;
  json?: boolean;
};

export async function runInitCommand(options: InitCommandOptions): Promise<void> {
  const prompt = buildOnboardingPrompt({ repo: options.repo, entriesJson: options.entriesJson });

  if (options.json) {
    printJSON({
      prompt,
      commandIntents: COMMAND_INTENTS
    });
    return;
  }

  process.stdout.write(`${prompt}\n`);

  const repoPath = resolveRepoPath(options.repo);

  const skill = ensureSkillFile(repoPath);
  process.stdout.write(`\nWrote skill to ${skill.path}\n`);

  const result = ensureAgentsMdSection(repoPath);
  if (result.written) {
    process.stdout.write(`Wrote devrouter section to ${result.path}\n`);
  }
}

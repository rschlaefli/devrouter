import { buildOnboardingPrompt, COMMAND_INTENTS } from "../core/ai-prompt";
import { printJSON } from "../core/output";

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
}

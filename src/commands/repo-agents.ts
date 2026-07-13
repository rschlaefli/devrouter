import { ensureAgentsMdSection, ensureSkillFile } from "../core/agents-md";
import { resolveRepoPath } from "../core/repo-config";

export async function runRepoAgentsCommand(options: { repo?: string }): Promise<void> {
  const repoPath = resolveRepoPath(options.repo);

  const skill = ensureSkillFile(repoPath);
  process.stdout.write(`Wrote skill to ${skill.path}\n`);

  const result = ensureAgentsMdSection(repoPath);

  if (!result.written) {
    process.stdout.write(`devrouter section already present: ${result.path}\n`);
  } else {
    process.stdout.write(`Wrote devrouter section to ${result.path}\n`);
  }
}

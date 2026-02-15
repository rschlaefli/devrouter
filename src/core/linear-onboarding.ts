import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

export type LinearWorkflowMetadata = {
  workspace: {
    name: string;
  };
  team: {
    name: string;
    key?: string;
  };
  project: {
    name: string;
    id?: string;
  };
  updatedAt: string;
  captureMode: "interactive" | "placeholder";
};

export type CollectLinearWorkflowMetadataOptions = {
  isInteractive?: boolean;
  now?: Date;
  askQuestion?: (question: string) => Promise<string>;
};

function isoTimestamp(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function requiredPlaceholder(path: string): string {
  return `<REQUIRED: ${path}>`;
}

function normalizeOptionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function askRequired(
  askQuestion: (question: string) => Promise<string>,
  question: string,
  fieldName: string
): Promise<string> {
  while (true) {
    const answer = (await askQuestion(question)).trim();
    if (answer.length > 0) {
      return answer;
    }
    output.write(`${fieldName} is required. Please enter a value.\n`);
  }
}

export function buildPlaceholderLinearWorkflowMetadata(now?: Date): LinearWorkflowMetadata {
  return {
    workspace: {
      name: requiredPlaceholder("workspace.name")
    },
    team: {
      name: requiredPlaceholder("team.name")
    },
    project: {
      name: requiredPlaceholder("project.name")
    },
    updatedAt: isoTimestamp(now),
    captureMode: "placeholder"
  };
}

export async function collectLinearWorkflowMetadata(
  options: CollectLinearWorkflowMetadataOptions = {}
): Promise<LinearWorkflowMetadata> {
  const interactive = options.isInteractive ?? Boolean(input.isTTY && output.isTTY);
  if (!interactive) {
    return buildPlaceholderLinearWorkflowMetadata(options.now);
  }

  if (options.askQuestion) {
    const workspaceName = await askRequired(options.askQuestion, "Linear workspace name: ", "workspace.name");
    const teamName = await askRequired(options.askQuestion, "Linear team name: ", "team.name");
    const teamKey = normalizeOptionalValue(await options.askQuestion("Linear team key (optional): "));
    const projectName = await askRequired(options.askQuestion, "Linear project name: ", "project.name");
    const projectId = normalizeOptionalValue(await options.askQuestion("Linear project id (optional): "));

    return {
      workspace: {
        name: workspaceName
      },
      team: {
        name: teamName,
        ...(teamKey ? { key: teamKey } : {})
      },
      project: {
        name: projectName,
        ...(projectId ? { id: projectId } : {})
      },
      updatedAt: isoTimestamp(options.now),
      captureMode: "interactive"
    };
  }

  const rl = createInterface({ input, output });
  try {
    const ask = (question: string) => rl.question(question);
    const workspaceName = await askRequired(ask, "Linear workspace name: ", "workspace.name");
    const teamName = await askRequired(ask, "Linear team name: ", "team.name");
    const teamKey = normalizeOptionalValue(await ask("Linear team key (optional): "));
    const projectName = await askRequired(ask, "Linear project name: ", "project.name");
    const projectId = normalizeOptionalValue(await ask("Linear project id (optional): "));

    return {
      workspace: {
        name: workspaceName
      },
      team: {
        name: teamName,
        ...(teamKey ? { key: teamKey } : {})
      },
      project: {
        name: projectName,
        ...(projectId ? { id: projectId } : {})
      },
      updatedAt: isoTimestamp(options.now),
      captureMode: "interactive"
    };
  } finally {
    rl.close();
  }
}

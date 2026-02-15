import { describe, expect, it } from "vitest";
import {
  buildPlaceholderLinearWorkflowMetadata,
  collectLinearWorkflowMetadata
} from "../linear-onboarding";

describe("linear-onboarding", () => {
  it("builds placeholder metadata for non-interactive mode", () => {
    const metadata = buildPlaceholderLinearWorkflowMetadata(new Date("2026-02-16T10:00:00.000Z"));

    expect(metadata.captureMode).toBe("placeholder");
    expect(metadata.workspace.name).toBe("<REQUIRED: workspace.name>");
    expect(metadata.team.name).toBe("<REQUIRED: team.name>");
    expect(metadata.project.name).toBe("<REQUIRED: project.name>");
    expect(metadata.updatedAt).toBe("2026-02-16T10:00:00.000Z");
  });

  it("collects placeholder metadata when interactive mode is disabled", async () => {
    const metadata = await collectLinearWorkflowMetadata({
      isInteractive: false,
      now: new Date("2026-02-16T11:00:00.000Z")
    });

    expect(metadata.captureMode).toBe("placeholder");
    expect(metadata.updatedAt).toBe("2026-02-16T11:00:00.000Z");
  });

  it("collects interactive metadata from guided answers", async () => {
    const answers = [
      "Acme Workspace",
      "Platform",
      "PLAT",
      "Devrouter",
      "0b1c6ef6-9e97-4a75-ac79-18fea4b21af8"
    ];
    let index = 0;

    const metadata = await collectLinearWorkflowMetadata({
      isInteractive: true,
      now: new Date("2026-02-16T12:00:00.000Z"),
      askQuestion: async () => answers[index++] ?? ""
    });

    expect(metadata.captureMode).toBe("interactive");
    expect(metadata.workspace.name).toBe("Acme Workspace");
    expect(metadata.team.name).toBe("Platform");
    expect(metadata.team.key).toBe("PLAT");
    expect(metadata.project.name).toBe("Devrouter");
    expect(metadata.project.id).toBe("0b1c6ef6-9e97-4a75-ac79-18fea4b21af8");
    expect(metadata.updatedAt).toBe("2026-02-16T12:00:00.000Z");
  });

  it("re-prompts required fields and trims optional values", async () => {
    const answers = [
      "",
      "Acme Workspace",
      "",
      "Platform",
      "   ",
      "Devrouter",
      "   "
    ];
    let index = 0;

    const metadata = await collectLinearWorkflowMetadata({
      isInteractive: true,
      now: new Date("2026-02-16T13:00:00.000Z"),
      askQuestion: async () => answers[index++] ?? ""
    });

    expect(metadata.workspace.name).toBe("Acme Workspace");
    expect(metadata.team.name).toBe("Platform");
    expect(metadata.team.key).toBeUndefined();
    expect(metadata.project.name).toBe("Devrouter");
    expect(metadata.project.id).toBeUndefined();
  });
});

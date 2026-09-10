import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("parses journal settle as a subcommand and forwards the requested checkout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-journal-cli-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "workspace", "journal", "settle", directory, "--json"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    // A non-Git target must reach the checkout guard, before any journal access.
    expect(result.stderr).toContain(
      `Environment commands require a Git repository: '${directory}'.`,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

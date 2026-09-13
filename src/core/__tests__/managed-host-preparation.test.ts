import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DevrouterConfig } from "../../types";
import { runManagedHostPreparation } from "../managed-host-preparation";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(script: string, args: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-prepare-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, ".devrouter.yml"), "version: 1\napps: []\n");
  const config: DevrouterConfig = {
    version: 1,
    apps: [],
    managedRuntime: {
      processes: [],
      devcontainer: {
        baseServices: [],
        profileServices: [],
        prepareCommand: [process.execPath, "-e", script, ...args],
      },
    },
  };
  return { root, config };
}
it("executes literal argv in the checkout root without changing configuration", async () => {
  const literal = "$(touch unexpected); spaces";
  const { root, config } = fixture(
    "require('fs').writeFileSync('result.json', JSON.stringify(process.argv.slice(1)))",
    [literal],
  );
  const before = fs.readFileSync(path.join(root, ".devrouter.yml"));
  await runManagedHostPreparation(root, config);
  expect(JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"))).toEqual([literal]);
  expect(fs.existsSync(path.join(root, "unexpected"))).toBe(false);
  expect(fs.readFileSync(path.join(root, ".devrouter.yml"))).toEqual(before);
});
it("rejects a nonzero command and preserves changed configuration for correction", async () => {
  const { root, config } = fixture("process.exit(7)");
  await expect(runManagedHostPreparation(root, config)).rejects.toThrow();
  config.managedRuntime!.devcontainer.prepareCommand = [
    process.execPath,
    "-e",
    "require('fs').writeFileSync('.devrouter.yml','changed')",
  ];
  await expect(runManagedHostPreparation(root, config)).rejects.toThrow();
  expect(fs.readFileSync(path.join(root, ".devrouter.yml"), "utf8")).toBe("changed");
});
it("bounds a live foreground process and kills its inherited process group", async () => {
  const { root, config } = fixture(
    "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync('child.pid',String(c.pid)); setInterval(()=>{},1000)",
  );
  const original = global.setTimeout;
  vi.spyOn(global, "setTimeout").mockImplementation(((
    fn: (...args: any[]) => void,
    ms?: number,
    ...args: any[]
  ) => original(fn, ms === 60000 ? 500 : ms, ...args)) as typeof setTimeout);
  await expect(runManagedHostPreparation(root, config)).rejects.toThrow();
  const pid = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"));
  await new Promise((resolve) => original(resolve, 50));
  expect(() => process.kill(pid, 0)).toThrow();
});

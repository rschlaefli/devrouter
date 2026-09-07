import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveControllerBinding } from "../controller-binding";
import { ControllerProbeUnavailable, runControllerProbe } from "../controller-probe";

vi.mock("../controller-probe", async (original) => ({
  ...(await original<typeof import("../controller-probe")>()),
  runControllerProbe: vi.fn(),
}));
const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-binding-")));
  directories.push(root);
  const repo = path.join(root, "checkout");
  const common = path.join(root, ".git");
  const git = path.join(common, "worktrees", "checkout");
  fs.mkdirSync(git, { recursive: true });
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(common, "devrouter", "workspaces"), { recursive: true });
  fs.writeFileSync(path.join(git, "devrouter-workspace"), "fixture");
  fs.writeFileSync(
    path.join(common, "devrouter", "workspaces", "fixture.json"),
    JSON.stringify({ version: 1, workspace: "fixture", worktreePath: repo, devpodId: "provider" }),
  );
  fs.writeFileSync(
    path.join(repo, ".devrouter.yml"),
    'version: 1\nmanagedRuntime:\n  devcontainer:\n    baseServices: [db]\n    profileServices: []\n  processes: [web]\nprofiles:\n  full:\n    apps: ["*"]\n    processes: ["*"]\n    default: true\napps:\n  - name: web\n    host: web.localhost\n    protocol: http\n    runtime: proxy\n    upstream: ${WORKSPACE}-web:3000\n    readiness:\n      path: /health\n',
  );
  const registry = JSON.stringify([{ id: "provider", source: { localFolder: repo } }]);
  vi.mocked(runControllerProbe).mockImplementation(async (command) => {
    if (command === "git") return `${git}\n${common}\n${repo}\n`;
    if (command === "devpod") throw new ControllerProbeUnavailable(true);
    return registry;
  });
  return {
    repo,
    common,
    registry,
    request: { path: repo, profile: "full", require: ["runtime", "app:web"] },
  };
}
it("resolves existing linked ownership with an absent alternative provider", async () => {
  const { request } = fixture();
  const binding = await resolveControllerBinding(request, new AbortController().signal);
  expect(binding.provider).toBe("devsy");
  expect(binding.providerId).toBe("provider");
  expect(binding.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(runControllerProbe).toHaveBeenCalledTimes(3);
});
it("rejects unavailable installed registries and conflicting owners", async () => {
  const { request, registry } = fixture();
  const base = vi.mocked(runControllerProbe).getMockImplementation()!;
  vi.mocked(runControllerProbe).mockImplementation(async (command, args, signal) =>
    command === "devpod"
      ? Promise.reject(new ControllerProbeUnavailable(false))
      : base(command, args, signal),
  );
  await expect(resolveControllerBinding(request, new AbortController().signal)).rejects.toThrow();
  vi.mocked(runControllerProbe).mockImplementation(async (command, args, signal) =>
    command === "devpod" ? registry : base(command, args, signal),
  );
  await expect(resolveControllerBinding(request, new AbortController().signal)).rejects.toThrow();
});
it("rejects undeclared application readiness before provider inspection", async () => {
  const { request } = fixture();
  await expect(
    resolveControllerBinding(
      { ...request, require: ["app:missing"] },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(runControllerProbe).toHaveBeenCalledTimes(1);
});

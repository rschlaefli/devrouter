import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MANAGED_MARKER = "devrouter:managed devcontainer";
const RUNTIME_HELPER_PATH = "/tmp/devrouter/bin/devrouter-process";
const DELIVERY_SCRIPT = `set -eu
umask 077
mkdir -p /tmp/devrouter/bin
temporary="${RUNTIME_HELPER_PATH}.tmp.$$"
cat > "$temporary"
chmod 700 "$temporary"
mv -f "$temporary" ${RUNTIME_HELPER_PATH}
`;

type ValidatedContainer = {
  id: string;
  workspacePath: string;
};

function commandFailure(result: ReturnType<typeof spawnSync>): string {
  return [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join("\n");
}

export function resolveProcessHelperPath(): string {
  const candidates = [
    path.resolve(__dirname, "..", "bin", "devrouter-process"),
    path.resolve(__dirname, "..", "..", "bin", "devrouter-process"),
  ];
  const helperPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!helperPath) {
    throw new Error("Could not locate the packaged devrouter-process helper.");
  }
  return helperPath;
}

function managedAdapterPath(repoPath: string): string | undefined {
  const adapterPath = path.join(repoPath, ".devcontainer", "post-start.sh");
  if (!fs.existsSync(adapterPath)) return undefined;

  const adapter = fs.readFileSync(adapterPath, "utf-8");
  if (!adapter.includes(MANAGED_MARKER)) return undefined;
  if (adapter.includes("DEVROUTER_PROCESS_HELPER")) return adapterPath;

  const dockerfilePath = path.join(repoPath, ".devcontainer", "Dockerfile");
  const devcontainerPath = path.join(repoPath, ".devcontainer", "devcontainer.json");
  const dockerfile = fs.existsSync(dockerfilePath) ? fs.readFileSync(dockerfilePath, "utf-8") : "";
  const devcontainer = fs.existsSync(devcontainerPath)
    ? fs.readFileSync(devcontainerPath, "utf-8")
    : "";
  if (dockerfile.includes("devrouter-process") && devcontainer.includes("postStartCommand")) {
    return undefined;
  }
  throw new Error(
    "Managed post-start must use DEVROUTER_PROCESS_HELPER before removing the legacy image helper and postStartCommand. Regenerate or migrate the devcontainer, then retry devrouter ensure.",
  );
}

export function assertManagedPostStartMigration(repoPath: string): void {
  managedAdapterPath(repoPath);
}

export function ensureManagedPostStart(options: {
  repoPath: string;
  container: ValidatedContainer;
  quiet?: boolean;
}): void {
  const adapter = managedAdapterPath(options.repoPath);
  if (!adapter) return;

  const helper = fs.readFileSync(resolveProcessHelperPath());
  const delivered = spawnSync(
    "docker",
    ["exec", "-i", options.container.id, "sh", "-c", DELIVERY_SCRIPT],
    { input: helper, encoding: "utf-8" },
  );
  if (delivered.status !== 0) {
    const details = commandFailure(delivered);
    throw new Error(
      `Could not deliver the managed process helper${details ? `: ${details}` : "."}`,
    );
  }

  const relativeAdapter = path.relative(options.repoPath, adapter);
  const started = spawnSync(
    "docker",
    [
      "exec",
      "--workdir",
      options.container.workspacePath,
      "--env",
      `DEVROUTER_PROCESS_HELPER=${RUNTIME_HELPER_PATH}`,
      options.container.id,
      "bash",
      relativeAdapter,
    ],
    { stdio: options.quiet ? ["ignore", 2, "inherit"] : "inherit" },
  );
  if (started.status !== 0) {
    const details = commandFailure(started);
    throw new Error(`Managed post-start failed${details ? `: ${details}` : "."}`);
  }
}

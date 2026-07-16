import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MANAGED_MARKER = "devrouter:managed devcontainer";
const MANAGED_ADAPTER_PATH = ".devcontainer/post-start.sh";
const RUNTIME_HELPER_PATH = "/tmp/devrouter/bin/devrouter-process";
const DELIVERY_SCRIPT = `set -eu
umask 077
runtime_root=/tmp/devrouter
runtime_bin="$runtime_root/bin"
if [ -L "$runtime_root" ] || [ -L "$runtime_bin" ]; then
  echo "Refusing symlinked devrouter runtime path." >&2
  exit 1
fi
mkdir -p "$runtime_bin"
chmod 700 "$runtime_root" "$runtime_bin"
temporary="$(mktemp "$runtime_bin/.devrouter-process.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
cat > "$temporary"
chmod 700 "$temporary"
mv -f "$temporary" "${RUNTIME_HELPER_PATH}"
trap - EXIT
`;

type ValidatedContainer = {
  id: string;
  workspacePath: string;
};

export type ManagedPostStartPlan =
  | { kind: "unmanaged" }
  | { kind: "legacy" }
  | { kind: "runtime"; adapterPath: string };

function commandFailure(result: ReturnType<typeof spawnSync>): string {
  return [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join("\n");
}

function readRegularFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) return undefined;
  return fs.readFileSync(filePath, "utf-8");
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

export function resolveManagedPostStartPlan(repoPath: string): ManagedPostStartPlan {
  const adapterPath = path.join(repoPath, MANAGED_ADAPTER_PATH);
  const adapter = readRegularFile(adapterPath);
  if (adapter === undefined) return { kind: "unmanaged" };

  if (!adapter.includes(MANAGED_MARKER)) return { kind: "unmanaged" };
  if (adapter.includes("DEVROUTER_PROCESS_HELPER")) {
    return { kind: "runtime", adapterPath: MANAGED_ADAPTER_PATH };
  }

  const dockerfilePath = path.join(repoPath, ".devcontainer", "Dockerfile");
  const devcontainerPath = path.join(repoPath, ".devcontainer", "devcontainer.json");
  const dockerfile = readRegularFile(dockerfilePath) ?? "";
  const devcontainer = readRegularFile(devcontainerPath) ?? "";
  if (dockerfile.includes("devrouter-process") && devcontainer.includes("postStartCommand")) {
    return { kind: "legacy" };
  }
  throw new Error(
    "Managed post-start must use DEVROUTER_PROCESS_HELPER before removing the legacy image helper and postStartCommand. Regenerate or migrate the devcontainer, then retry devrouter ensure.",
  );
}

export function runManagedPostStart(options: {
  plan: ManagedPostStartPlan;
  container: ValidatedContainer;
  quiet?: boolean;
}): void {
  if (options.plan.kind !== "runtime") return;

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
      options.plan.adapterPath,
    ],
    { stdio: options.quiet ? ["ignore", 2, "inherit"] : "inherit" },
  );
  if (started.status !== 0) {
    const details = commandFailure(started);
    throw new Error(`Managed post-start failed${details ? `: ${details}` : "."}`);
  }
}

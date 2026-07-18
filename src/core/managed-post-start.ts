import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANAGED_MARKER = "devrouter:managed devcontainer";
const MANAGED_ADAPTER_PATH = ".devcontainer/post-start.sh";
const RUNTIME_HELPER_PATH = "/tmp/devrouter/bin/devrouter-process";
const ADAPTER_WRAPPER = `adapter_snapshot="$1"
shift
readonly DEVROUTER_PROCESS_HELPER DEVROUTER_PROCESS_ADAPTER_SHA256
source "$adapter_snapshot"
`;
function renderDeliveryScript(targetPath: string): string {
  if (!/^\/tmp\/devrouter\/bin\/[a-zA-Z0-9._-]+$/.test(targetPath)) {
    throw new Error(`Unsafe managed runtime delivery path: ${targetPath}`);
  }
  const temporaryPrefix = path.posix.basename(targetPath);
  return `set -eu
umask 077
runtime_root=/tmp/devrouter
runtime_bin="$runtime_root/bin"
target="${targetPath}"
if [ -L "$runtime_root" ] || [ -L "$runtime_bin" ]; then
  echo "Refusing symlinked devrouter runtime path." >&2
  exit 1
fi
mkdir -p "$runtime_bin"
chmod 700 "$runtime_root" "$runtime_bin"
temporary="$(mktemp "$runtime_bin/.${temporaryPrefix}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
cat > "$temporary"
chmod 700 "$temporary"
mv -f "$temporary" "$target"
trap - EXIT
`;
}

type ValidatedContainer = {
  id: string;
  workspacePath: string;
};

export type ManagedPostStartPlan =
  | { kind: "unmanaged" }
  | { kind: "legacy" }
  | {
      kind: "runtime";
      adapterPath: string;
      adapterSha256: string;
      adapterContents: Buffer;
    };

function commandFailure(result: ReturnType<typeof spawnSync>): string {
  return [result.error?.message, result.stderr, result.stdout]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join("\n");
}

function deliverRuntimeFile(
  containerId: string,
  targetPath: string,
  contents: Buffer,
  label: string,
): void {
  const result = spawnSync(
    "docker",
    ["exec", "-i", containerId, "sh", "-c", renderDeliveryScript(targetPath)],
    { input: contents, encoding: "utf-8" },
  );
  if (result.status !== 0) {
    const details = commandFailure(result);
    throw new Error(`Could not deliver ${label}${details ? `: ${details}` : "."}`);
  }
}

function readRegularFileBytes(filePath: string): Buffer | undefined {
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) return undefined;
  return fs.readFileSync(filePath);
}

function readRegularFile(filePath: string): string | undefined {
  return readRegularFileBytes(filePath)?.toString("utf-8");
}

function adapterFingerprint(adapter: Buffer): string {
  return createHash("sha256").update(adapter).digest("hex");
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
  const adapterBytes = readRegularFileBytes(adapterPath);
  const adapterText = adapterBytes?.toString("utf-8");
  const dockerfilePath = path.join(repoPath, ".devcontainer", "Dockerfile");
  const devcontainerPath = path.join(repoPath, ".devcontainer", "devcontainer.json");
  const dockerfile = readRegularFile(dockerfilePath) ?? "";
  const devcontainer = readRegularFile(devcontainerPath) ?? "";
  const devrouterPattern = [adapterText, dockerfile, devcontainer]
    .filter((value): value is string => value !== undefined)
    .some(
      (value) => value.includes("DEVROUTER_PROCESS_HELPER") || value.includes("devrouter-process"),
    );
  if (adapterBytes === undefined) {
    if (devrouterPattern) {
      throw new Error(
        "Devrouter lifecycle wiring is incomplete: add the managed post-start adapter or remove the stale devrouter-process references.",
      );
    }
    return { kind: "unmanaged" };
  }
  const adapter = adapterBytes.toString("utf-8");

  if (!adapter.includes(MANAGED_MARKER)) {
    if (devrouterPattern) {
      throw new Error(
        "Devrouter-looking post-start adapter is missing the 'devrouter:managed devcontainer' marker. Regenerate or migrate the devcontainer, then retry devrouter ensure.",
      );
    }
    return { kind: "unmanaged" };
  }
  if (adapter.includes("DEVROUTER_PROCESS_HELPER")) {
    return {
      kind: "runtime",
      adapterPath: MANAGED_ADAPTER_PATH,
      adapterSha256: adapterFingerprint(adapterBytes),
      adapterContents: adapterBytes,
    };
  }

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
  deliverRuntimeFile(
    options.container.id,
    RUNTIME_HELPER_PATH,
    helper,
    "the managed process helper",
  );

  const runtimeAdapterPath = `/tmp/devrouter/bin/managed-post-start-${options.plan.adapterSha256}`;
  deliverRuntimeFile(
    options.container.id,
    runtimeAdapterPath,
    options.plan.adapterContents,
    "the managed post-start adapter",
  );

  const started = spawnSync(
    "docker",
    [
      "exec",
      "--workdir",
      options.container.workspacePath,
      "--env",
      `DEVROUTER_PROCESS_HELPER=${RUNTIME_HELPER_PATH}`,
      "--env",
      `DEVROUTER_PROCESS_ADAPTER_SHA256=${options.plan.adapterSha256}`,
      options.container.id,
      "bash",
      "-c",
      ADAPTER_WRAPPER,
      options.plan.adapterPath,
      runtimeAdapterPath,
    ],
    { stdio: options.quiet ? ["ignore", 2, "inherit"] : "inherit" },
  );
  if (started.status !== 0) {
    const details = commandFailure(started);
    throw new Error(`Managed post-start failed${details ? `: ${details}` : "."}`);
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOnboardingPrompt } from "../ai-prompt";
import {
  DEPENDENCY_ONLY_RUNTIME,
  formatSupportedProtocolsForRuntime,
  formatSupportedTcpProtocols,
  POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE,
  POSTGRES_DEPENDENCY_URL_TEMPLATE,
  SUPPORTED_TCP_PROTOCOLS,
} from "../capabilities";
import { loadRepoConfig } from "../repo-config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-ai-prompt-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildOnboardingPrompt", () => {
  it("contains a canonical config skeleton that validates against parser", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    expect(prompt).toContain("devrouter.version: semantic version string");
    const skeletonMatch = prompt.match(/Canonical valid skeleton:\n```yaml\n([\s\S]*?)\n```/);
    expect(skeletonMatch).toBeTruthy();

    const skeleton = skeletonMatch?.[1];
    expect(skeleton).toContain("version: 1");

    fs.writeFileSync(path.join(tmpDir, ".devrouter.yml"), `${skeleton}\n`, "utf-8");
    const config = loadRepoConfig(tmpDir);
    expect(config.version).toBe(1);
    expect(config.apps).toEqual([]);
  });

  it("does not contain contradictory file-edit restrictions", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    expect(prompt).not.toContain("Create/update only REPO_PATH/.devrouter.yml.");
    expect(prompt).toContain("make minimal manual edits");
  });

  it("includes explicit tcp/tls onboarding sequence guidance", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    const tcpProtocolUnion = SUPPORTED_TCP_PROTOCOLS.map((protocol) => `"${protocol}"`).join(" | ");
    expect(prompt).toContain(
      "Run `devrouter setup --yes --json` for devrouter-owned machine state; use `devrouter doctor --repo <REPO_PATH> --json` to diagnose missing prerequisites without mutation.",
    );
    expect(prompt).toContain(
      "devrouter repo devcontainer verify --repo <REPO_PATH> --live --yes --json",
    );
    expect(prompt).toContain("Validation commands to run/report for the devcontainer path:");
    expect(prompt).toContain("Validation commands to run/report for host/docker runtime apps:");
    expect(prompt).toContain("Postgres multiplexing on shared :5432 requires TLS/SNI");
    expect(prompt).toContain(`  - tcpProtocol: ${tcpProtocolUnion}`);
    expect(prompt).toContain(
      `- kind=app runtime=proxy supports protocol=${formatSupportedProtocolsForRuntime("proxy").replace(", ", " or ")}, requires upstream`,
    );
    expect(prompt).toContain(
      `- kind=app protocol=tcp requires runtime=docker or proxy, and tcpProtocol (${formatSupportedTcpProtocols()})`,
    );
    expect(prompt).toContain(POSTGRES_DEPENDENCY_URL_TEMPLATE);
    expect(prompt).toContain(POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE);
  });

  it("documents dependency-only app kind semantics", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    expect(prompt).toContain('kind: "app" | "dependency"');
    expect(prompt).toContain(`kind=dependency requires runtime=${DEPENDENCY_ONLY_RUNTIME}`);
    expect(prompt).toContain("kind=dependency entries are dependency-only");
  });

  it("includes secret-manager interop guidance with envMap and probes", () => {
    const prompt = buildOnboardingPrompt({ repo: tmpDir });
    expect(prompt).toContain("Secret Manager Integration (config-based):");
    expect(prompt).toContain("secretManager.command");
    expect(prompt).toContain("secretManager.defaultEnv");
    expect(prompt).toContain("{env}");
    expect(prompt).toContain("Secret Manager Interop (manual fallback):");
    expect(prompt).toContain("envMap: { DATABASE_URL: DB_URL }");
    expect(prompt).toContain("printenv DB_URL DB_HOST DB_PORT DB_SHADOW_URL");
    expect(prompt).toContain("Do not assume secret-manager precedence");
    expect(prompt).toContain(
      "Avoid pre-wrapper DB assignments such as `DATABASE_URI=... <wrapper> run -- ...`",
    );
    expect(prompt).toContain("warns on risky pre-wrapper DB assignments before `run --`");
    expect(prompt).not.toContain("--env-map");
  });
});
